import { resolveServerEnvironment } from "../../src/lib/deploymentEnvironment.ts";
import { assertProfileRequest, KLAVIYO_REVISION, type ProviderRequest, type ProviderResponse, type SyncProvider } from "./klaviyoProfileSync.ts";

export type ProfileSyncEnv = Record<string, string | undefined>;
export type ProfileSyncConfig = {
  isolated: boolean; readable: boolean; mode: "disabled" | "mock" | "live";
  url: string; businessId: string; publicKey: string; serviceKey: string;
  accountId: string; providerKey: string; onlyCustomerId: string | null;
  mockFailure: boolean; approvalId: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const account = /^[A-Za-z0-9_-]{3,64}$/;

/** Missing configuration never enables a provider write; Preview has no prod fallback. */
export function profileSyncConfig(env: ProfileSyncEnv, hostname: string): ProfileSyncConfig {
  const target = resolveServerEnvironment(env, hostname);
  const prefix = target.isolated ? "TEST_" : "";
  const publicKey = env[target.isolated ? "VITE_TEST_SUPABASE_ANON_KEY" : "VITE_SUPABASE_ANON_KEY"] || "";
  const accountId = env[prefix + "KLAVIYO_PROFILE_SYNC_ACCOUNT_ID"] || "";
  const providerKey = env[prefix + "KLAVIYO_PROFILE_SYNC_KEY"] || "";
  const approvalId = env[prefix + "KLAVIYO_PROFILE_SYNC_LIVE_APPROVAL_ID"] || "";
  const candidateId = env[prefix + "KLAVIYO_PROFILE_SYNC_CUSTOMER_ID"] || "";
  const onlyCustomerId = uuid.test(candidateId) ? candidateId : null;
  const readable = target.configured && !!target.url && !!target.businessId
    && publicKey.startsWith("sb_publishable_")
    && (!target.isolated || publicKey !== env.VITE_SUPABASE_ANON_KEY);
  const requested = env[prefix + "KLAVIYO_PROFILE_SYNC_MODE"];
  let mode: ProfileSyncConfig["mode"] = "disabled";
  if (readable && target.secret.startsWith("sb_secret_") && account.test(accountId)
    && (!candidateId || onlyCustomerId !== null)) {
    if (requested === "mock" && target.isolated) mode = "mock";
    if (requested === "live" && /^pk_[A-Za-z0-9_-]{10,200}$/.test(providerKey)
      && /^[A-Za-z0-9_.:-]{8,120}$/.test(approvalId)
      && (!target.isolated || onlyCustomerId !== null)
      && (!target.isolated || providerKey !== env.KLAVIYO_PROFILE_SYNC_KEY)) mode = "live";
  }
  return { isolated: target.isolated, readable, mode, url: target.url, businessId: target.businessId,
    publicKey, serviceKey: target.secret, accountId, providerKey, onlyCustomerId,
    mockFailure: target.isolated && env.TEST_KLAVIYO_PROFILE_SYNC_MOCK_FAILURE === "rate_limit",
    approvalId };
}

export class RpcUnavailable extends Error {
  status: number;
  constructor(status = 503) { super("database_unavailable"); this.status = status; }
}
export type Fetcher = typeof fetch;
export async function profileSyncRpc(config: ProfileSyncConfig, name: string,
  args: Record<string, unknown>, bearer: string | null, fetcher: Fetcher): Promise<unknown> {
  const allowed = ["crm_staff_authorized_v1", "crm_profile_sync_queue_v1", "klaviyo_profile_sync_enqueue_v1",
    "klaviyo_profile_sync_claim_v1", "klaviyo_profile_sync_context_v1", "klaviyo_profile_sync_finish_v1"];
  if (!allowed.includes(name) || !config.readable || (!bearer && !config.serviceKey.startsWith("sb_secret_"))) throw new RpcUnavailable();
  const result = await fetcher(`${config.url}/rest/v1/rpc/${name}`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { apikey: bearer ? config.publicKey : config.serviceKey,
      ...(bearer ? { Authorization: bearer } : {}), "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!result.ok) throw new RpcUnavailable(result.status);
  try { return await result.json(); } catch { throw new RpcUnavailable(); }
}

/** No arbitrary host, redirect, account, method, header or credential forwarding. */
export function liveProfileProvider(config: ProfileSyncConfig, fetcher: Fetcher): SyncProvider {
  return { async request(request: ProviderRequest): Promise<ProviderResponse> {
    const endpoint = new URL(request.url);
    const allowed = endpoint.origin === "https://a.klaviyo.com" && !endpoint.username && !endpoint.password && !endpoint.hash
      && ((request.method === "GET" && endpoint.pathname === "/api/profiles")
        || (request.method === "POST" && endpoint.pathname === "/api/profile-import" && !endpoint.search));
    const headers = Object.keys(request.headers).map(key => key.toLowerCase());
    if (config.mode !== "live" || !config.approvalId || !/^pk_[A-Za-z0-9_-]{10,200}$/.test(config.providerKey)
      || !allowed || request.accountId !== config.accountId
      || headers.some(key => !["revision", "accept", "content-type"].includes(key))
      || request.headers.revision !== KLAVIYO_REVISION
      || request.headers.Accept !== "application/vnd.api+json"
      || (request.method === "POST" && request.headers["Content-Type"] !== "application/vnd.api+json")
      || (request.method === "GET" && headers.includes("content-type"))) throw new Error("provider_transport_rejected");
    const filterMatch = /^equals\(email,(".*")\)$/.exec(endpoint.searchParams.get("filter") || "");
    const email: unknown = request.method === "GET" ? (filterMatch ? JSON.parse(filterMatch[1]) : null)
      : JSON.parse(request.body || "{}").data?.attributes?.email;
    if (typeof email !== "string") throw new Error("provider_transport_rejected");
    assertProfileRequest(request, email);
    const result = await fetcher(endpoint.href, { method: request.method, redirect: "error", signal: request.signal,
      headers: { ...request.headers, Authorization: `Klaviyo-API-Key ${config.providerKey}` },
      ...(request.body !== undefined ? { body: request.body } : {}) });
    // Never return provider error bodies, which may echo personal data or keys.
    let body: unknown = null;
    if (result.ok) { try { body = await result.json(); } catch { body = null; } }
    return { status: result.status, body, headers: { "retry-after": result.headers.get("retry-after") || "" } };
  } };
}

/** Synthetic adapter only: no network, key, subscription, send or external account. */
export function mockProfileProvider(fail = false): SyncProvider {
  const profiles = new Map<string, { id: string; type: string; attributes: Record<string, unknown> }>();
  return { async request(request: ProviderRequest): Promise<ProviderResponse> {
    if (fail) return { status: 429, body: null, headers: { "retry-after": "60" } };
    const endpoint = new URL(request.url);
    if (request.method === "GET") {
      const filter = endpoint.searchParams.get("filter") || "";
      const match = /^equals\(email,(".*")\)$/.exec(filter);
      const email: unknown = match ? JSON.parse(match[1]) : null;
      const found = typeof email === "string" ? profiles.get(email) : undefined;
      return { status: 200, body: { data: found ? [found] : [], links: { next: null } } };
    }
    const data = JSON.parse(request.body || "{}").data as { attributes: { email: string; properties: Record<string, unknown> } };
    const email = data.attributes.email;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
    const id = "MOCK_" + [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("").slice(0,24);
    const existed = profiles.has(email);
    const profile = { id, type: "profile", attributes: { email, properties: data.attributes.properties,
      subscriptions: { email: { marketing: { consent: "NEVER_SUBSCRIBED", can_receive_email_marketing: false,
        suppression: [], list_suppressions: [] } } } } };
    profiles.set(email, profile);
    return { status: existed ? 200 : 201, body: { data: profile } };
  } };
}

export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export const isUuid = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
