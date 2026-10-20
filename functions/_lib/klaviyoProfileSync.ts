/** Attribute-only sync. No credentials, logging, scheduling or account operation. */
export const KLAVIYO_REVISION = "2026-07-15";
const ORIGIN = "https://a.klaviyo.com";
const MAX_ATTEMPTS = 6;

export type SyncLease = { jobId: string; leaseId: string; attempt: number; leaseExpiresAt?: string };
export type SyncContext = {
  businessId: string; customerId: string; accountId: string;
  email: string; name: string | null; source: string | null; registeredAt: string;
  utm: Record<string, string> | null; tags: string[] | null;
  emailStatus: string; isTest: boolean; suppressedAt: string | null;
  lastSuccessfulFingerprint?: string | null; providerProfileId?: string | null;
  providerBlockedStatus?: "unsubscribed" | "suppressed" | null;
};
export type SyncOutcome = {
  status: "succeeded" | "retry" | "failed" | "provider_blocked";
  errorCode?: string; retryAfterSeconds?: number;
  providerStatus?: "unsubscribed" | "suppressed"; providerUpdatedAt?: string;
  providerProfileId?: string; fingerprint?: string; unchanged?: boolean;
  uncertainWrite?: boolean;
};
export interface SyncStore {
  /** Must validate job/lease expiry and return the CURRENT local state. */
  readContext(lease: SyncLease): Promise<SyncContext | null>;
  /** provider_blocked must atomically persist local negative evidence + finish. */
  finish(lease: SyncLease, outcome: SyncOutcome): Promise<void>;
}
export type ProviderRequest = {
  accountId: string; method: "GET" | "POST"; url: string;
  headers: Record<string, string>; body?: string; signal: AbortSignal;
};
export type ProviderResponse = { status: number; headers?: Record<string, string>; body: unknown };
export interface SyncProvider {
  /** Attach the account-scoped server key here; never follow a redirect. */
  request(request: ProviderRequest): Promise<ProviderResponse>;
}
type Profile = { id: string; attributes: Record<string, unknown> };
type Snapshot = { context: SyncContext; email: string; properties: Record<string, unknown>; canonical: string; fingerprint: string };
class SyncFault extends Error {
  code: string; retryable: boolean; retryAfter?: string; uncertainWrite: boolean;
  constructor(code: string, retryable = false, retryAfter?: string, uncertainWrite = false) {
    super(code); this.code = code; this.retryable = retryable; this.retryAfter = retryAfter; this.uncertainWrite = uncertainWrite;
  }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const canonical = (v: unknown): string => JSON.stringify(v, (_key, value) => object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value) ?? "<undefined>";
const validId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const normalizedEmail = (v: string) => v.trim().toLowerCase();

function eligible(c: SyncContext | null): c is SyncContext {
  return !!c && c.emailStatus === "subscribed" && c.isTest === false && c.suppressedAt === null
    && !c.providerBlockedStatus;
}
function payloadParts(c: SyncContext) {
  const email = typeof c.email === "string" ? normalizedEmail(c.email) : "";
  if (!/^[^\s<>"\\@]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email) || email.length > 254
    || !c.businessId || !c.customerId || !c.accountId || !Number.isFinite(Date.parse(c.registeredAt))
    || (c.name !== null && (typeof c.name !== "string" || c.name.length > 200))
    || (c.source !== null && (typeof c.source !== "string" || c.source.length > 200))
    || (c.tags !== null && (!Array.isArray(c.tags) || c.tags.length > 20
      || c.tags.some(tag => typeof tag !== "string" || !tag.trim() || tag.length > 64)))
    || (c.utm !== null && !object(c.utm))) throw new SyncFault("invalid_local_context");
  const utm: Record<string, string> = {};
  for (const [key, value] of Object.entries(c.utm || {})) {
    if (!["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].includes(key)) continue;
    if (typeof value !== "string" || value.length > 500) throw new SyncFault("invalid_local_context");
    utm[key] = value;
  }
  const properties: Record<string, unknown> = {
    ...(c.name !== null ? { crm_name: c.name } : {}),
    ...(c.source !== null ? { crm_source: c.source } : {}),
    crm_registered_at: new Date(c.registeredAt).toISOString(),
    ...(c.utm !== null ? { crm_utm: utm } : {}),
    ...(c.tags !== null ? { crm_tags: [...new Set(c.tags.map(tag => tag.trim()))].sort() } : {}),
  };
  return { email, properties, canonical: canonical({ businessId: c.businessId, customerId: c.customerId, accountId: c.accountId, email, properties, revision: KLAVIYO_REVISION }) };
}
export async function profileFingerprint(context: SyncContext): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payloadParts(context).canonical));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}
/** The engine never accepts provider-supplied pagination or redirect URLs. */
export function assertProfileRequest(request: Pick<ProviderRequest, "method" | "url" | "body">, email: string) {
  const url = new URL(request.url);
  if (url.origin !== ORIGIN || url.username || url.password || url.hash) throw new SyncFault("provider_endpoint_rejected");
  if (request.method === "GET" && url.pathname === "/api/profiles") {
    if (request.body !== undefined || url.searchParams.size !== 3
      || url.searchParams.get("filter") !== `equals(email,${JSON.stringify(email)})`
      || url.searchParams.get("additional-fields[profile]") !== "subscriptions"
      || url.searchParams.get("page[size]") !== "2") throw new SyncFault("provider_endpoint_rejected");
    return;
  }
  if (request.method !== "POST" || url.pathname !== "/api/profile-import" || url.search || !request.body) throw new SyncFault("provider_endpoint_rejected");
  let body: unknown;
  try { body = JSON.parse(request.body); } catch { throw new SyncFault("provider_payload_rejected"); }
  if (!object(body) || Object.keys(body).join() !== "data" || !object(body.data)
    || Object.keys(body.data).sort().join() !== "attributes,type" || body.data.type !== "profile"
    || !object(body.data.attributes) || Object.keys(body.data.attributes).sort().join() !== "email,properties"
    || body.data.attributes.email !== email || !object(body.data.attributes.properties)
    || Object.keys(body.data.attributes.properties).some(key => !["crm_name", "crm_source", "crm_registered_at", "crm_utm", "crm_tags"].includes(key))) throw new SyncFault("provider_payload_rejected");
  const properties = body.data.attributes.properties;
  if ((properties.crm_name !== undefined && (typeof properties.crm_name !== "string" || properties.crm_name.length > 200))
    || (properties.crm_source !== undefined && (typeof properties.crm_source !== "string" || properties.crm_source.length > 200))
    || typeof properties.crm_registered_at !== "string" || !Number.isFinite(Date.parse(properties.crm_registered_at))
    || (properties.crm_tags !== undefined && (!Array.isArray(properties.crm_tags) || properties.crm_tags.length > 20
      || properties.crm_tags.some(tag => typeof tag !== "string" || !tag.trim() || tag.length > 64)))
    || (properties.crm_utm !== undefined && (!object(properties.crm_utm)
      || Object.entries(properties.crm_utm).some(([key, value]) => !["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].includes(key)
        || typeof value !== "string" || value.length > 500)))) throw new SyncFault("provider_payload_rejected");
}
function providerStatus(profile: Profile, now: number): { status: "clear" | "not_subscribed" | "unsubscribed" | "suppressed"; updatedAt?: string } {
  const subscriptions = profile.attributes.subscriptions;
  const email = object(subscriptions) ? subscriptions.email : undefined;
  const marketing = object(email) ? email.marketing : undefined;
  if (!object(marketing)) throw new SyncFault("provider_status_unverified");
  const updated = marketing.last_updated ?? marketing.consent_timestamp;
  const updatedAt = typeof updated === "string" && Number.isFinite(Date.parse(updated)) && Date.parse(updated) <= now + 60000 ? new Date(updated).toISOString() : undefined;
  // Explicit unsubscribe is negative evidence even if optional fields are absent.
  if (marketing.consent === "UNSUBSCRIBED") return { status: "unsubscribed", updatedAt };
  if (updated !== undefined && updated !== null && updatedAt === undefined) throw new SyncFault("provider_status_unverified");
  if (!["SUBSCRIBED", "NEVER_SUBSCRIBED"].includes(String(marketing.consent))
    || !Array.isArray(marketing.suppression) || !Array.isArray(marketing.list_suppressions)
    || marketing.suppression.some(item => !object(item) || typeof item.reason !== "string" || !item.reason
      || typeof item.timestamp !== "string" || !Number.isFinite(Date.parse(item.timestamp)))
    || marketing.list_suppressions.some(item => !object(item) || typeof item.list_id !== "string" || !item.list_id
      || typeof item.reason !== "string" || !item.reason || typeof item.timestamp !== "string" || !Number.isFinite(Date.parse(item.timestamp)))
    || typeof marketing.can_receive_email_marketing !== "boolean") throw new SyncFault("provider_status_unverified");
  if (marketing.suppression.length || marketing.list_suppressions.length
    || (marketing.consent === "SUBSCRIBED" && marketing.can_receive_email_marketing === false)) return { status: "suppressed", updatedAt };
  // NEVER_SUBSCRIBED is not consent to market, but it does not forbid an
  // attribute-only upsert for a separately verified local subscriber.
  return { status: "clear", updatedAt };
}
function profileFrom(value: unknown, email: string): Profile {
  if (!object(value) || value.type !== "profile" || !validId(value.id) || !object(value.attributes)
    || typeof value.attributes.email !== "string" || normalizedEmail(value.attributes.email) !== email) throw new SyncFault("provider_identity_unverified");
  return { id: value.id, attributes: value.attributes };
}
function readProfile(body: unknown, email: string): Profile | null {
  if (!object(body) || !Array.isArray(body.data) || body.data.length > 1
    || (object(body.links) && body.links.next !== undefined && body.links.next !== null && body.links.next !== "")) throw new SyncFault("provider_identity_unverified");
  return body.data.length ? profileFrom(body.data[0], email) : null;
}
function propertiesMatch(profile: Profile, expected: Record<string, unknown>) {
  return object(profile.attributes.properties) && Object.entries(expected).every(([key, value]) => canonical((profile.attributes.properties as Record<string, unknown>)[key]) === canonical(value));
}
function retrySeconds(value: string | undefined, attempt: number, now: number) {
  const floor = Math.min(3600, 30 * 2 ** (attempt - 1));
  const parsed = value && /^\d+$/.test(value) ? Number(value) : value ? Math.ceil((Date.parse(value) - now) / 1000) : NaN;
  return Math.min(86400, Math.max(floor, Number.isFinite(parsed) ? parsed : 0));
}

export async function runProfileSync({ lease, store, provider, now = Date.now, timeoutMs = 8000 }: {
  lease: SyncLease; store: SyncStore; provider: SyncProvider; now?: () => number; timeoutMs?: number;
}): Promise<SyncOutcome> {
  let writeStarted = false;
  const finish = async (outcome: SyncOutcome): Promise<SyncOutcome> => {
    try { await store.finish(lease, outcome); return outcome; }
    catch { return { status: lease.attempt < MAX_ATTEMPTS ? "retry" : "failed", errorCode: "local_store_unavailable", uncertainWrite: writeStarted, ...(lease.attempt < MAX_ATTEMPTS ? { retryAfterSeconds: 30 } : {}) }; }
  };
  try {
    if (!validId(lease.jobId) || !validId(lease.leaseId) || !Number.isInteger(lease.attempt) || lease.attempt < 1 || lease.attempt > MAX_ATTEMPTS
      || timeoutMs < 1 || timeoutMs > 10000) throw new SyncFault("invalid_lease");
    const initial = await store.readContext(lease);
    if (!eligible(initial)) throw new SyncFault("local_ineligible");
    const parts = payloadParts(initial);
    const snapshot: Snapshot = { context: initial, ...parts, fingerprint: await profileFingerprint(initial) };
    const guardedRequest = async (method: "GET" | "POST", url: string, body?: string): Promise<ProviderResponse> => {
      assertProfileRequest({ method, url, body }, snapshot.email);
      const fresh = await store.readContext(lease); // Last async step before every provider request.
      if (!eligible(fresh)) throw new SyncFault("local_ineligible");
      if (payloadParts(fresh).canonical !== snapshot.canonical) throw new SyncFault("local_context_changed");
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (method === "POST") writeStarted = true;
        const response = await Promise.race([
          provider.request({ accountId: fresh.accountId, method, url, body, signal: controller.signal,
            headers: { revision: KLAVIYO_REVISION, Accept: "application/vnd.api+json", ...(method === "POST" ? { "Content-Type": "application/vnd.api+json" } : {}) } }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new SyncFault("provider_timeout", true, undefined, method === "POST")); }, timeoutMs); }),
        ]);
        if (response.status === 401 || response.status === 403) throw new SyncFault("provider_auth");
        if (response.status === 429) throw new SyncFault("provider_rate_limited", true, response.headers?.["retry-after"] ?? response.headers?.["Retry-After"], method === "POST");
        if (response.status >= 500 || response.status === 408) throw new SyncFault("provider_unavailable", true, undefined, method === "POST");
        if (response.status >= 300 && response.status < 400) throw new SyncFault("provider_redirect_rejected");
        return response;
      } catch (error) { if (error instanceof SyncFault) throw error; throw new SyncFault("provider_network_unavailable", true, undefined, method === "POST"); }
      finally { if (timer) clearTimeout(timer); controller.abort(); }
    };
    const url = new URL(ORIGIN + "/api/profiles");
    url.searchParams.set("filter", `equals(email,${JSON.stringify(snapshot.email)})`);
    url.searchParams.set("additional-fields[profile]", "subscriptions"); url.searchParams.set("page[size]", "2");
    const observe = async (): Promise<{ profile: Profile | null; blocked?: SyncOutcome }> => {
      const response = await guardedRequest("GET", url.href);
      if (response.status !== 200) throw new SyncFault("provider_read_rejected");
      const profile = readProfile(response.body, snapshot.email);
      if (!profile) return { profile };
      const status = providerStatus(profile, now());
      if (status.status === "unsubscribed" || status.status === "suppressed") return { profile, blocked: { status: "provider_blocked", errorCode: "provider_negative_observed", providerStatus: status.status, providerUpdatedAt: status.updatedAt || new Date(now()).toISOString(), providerProfileId: profile.id } };
      if (status.status !== "clear") throw new SyncFault("provider_not_subscribed");
      return { profile };
    };
    const current = await observe();
    if (current.blocked) return finish(current.blocked);
    if (current.profile && propertiesMatch(current.profile, snapshot.properties)) return finish({ status: "succeeded", fingerprint: snapshot.fingerprint, providerProfileId: current.profile.id, unchanged: true });
    const body = JSON.stringify({ data: { type: "profile", attributes: { email: snapshot.email, properties: snapshot.properties } } });
    const response = await guardedRequest("POST", ORIGIN + "/api/profile-import", body);
    if (response.status === 409) {
      // A later leased attempt starts with a fresh eligible-state check and GET.
      // No provider ID from a conflict body can retarget this job or URL.
      throw new SyncFault("provider_conflict", true, undefined, true);
    }
    if (![200, 201].includes(response.status)) throw new SyncFault("provider_write_rejected");
    if (!object(response.body)) throw new SyncFault("provider_write_ack_unverified", true, undefined, true);
    let saved: Profile;
    try { saved = profileFrom(response.body.data, snapshot.email); }
    catch { throw new SyncFault("provider_write_ack_unverified", true, undefined, true); }
    // A response which includes a newly observed negative still records that
    // evidence; it never invokes an unsubscribe, subscribe or unblock endpoint.
    if (saved.attributes.subscriptions !== undefined) {
      const observed = providerStatus(saved, now());
      if (observed.status === "unsubscribed" || observed.status === "suppressed") return finish({ status: "provider_blocked", errorCode: "provider_negative_observed", providerStatus: observed.status, providerUpdatedAt: observed.updatedAt || new Date(now()).toISOString(), providerProfileId: saved.id });
    }
    return finish({ status: "succeeded", fingerprint: snapshot.fingerprint, providerProfileId: saved.id });
  } catch (error) {
    const fault = error instanceof SyncFault ? error : new SyncFault("local_store_unavailable", true);
    return finish(fault.retryable && lease.attempt < MAX_ATTEMPTS
      ? { status: "retry", errorCode: fault.code, retryAfterSeconds: retrySeconds(fault.retryAfter, lease.attempt, now()), uncertainWrite: fault.uncertainWrite || writeStarted }
      : { status: "failed", errorCode: fault.retryable ? "retry_exhausted" : fault.code, uncertainWrite: fault.uncertainWrite || writeStarted });
  }
}
