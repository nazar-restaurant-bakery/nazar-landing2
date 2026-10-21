/** K10 server preparation. No route, scheduler or flow is activated by this module. */
import { resolveServerEnvironment } from "../../src/lib/deploymentEnvironment.ts";

export const COUPON_KLAVIYO_REVISION = "2026-07-15";
export const COUPON_WELCOME_METRIC = "Nazar Coupon Welcome Authorized";
type Json = Record<string, unknown>;
type Fetcher = typeof fetch;
export type CouponStore = { rpc(name: string, args: Json): Promise<unknown> };
export type CouponProvider = {
  mode: "mock" | "live";
  get(path: string, query?: Record<string, string>): Promise<unknown>;
  eventAccount(): Promise<unknown>;
  event(body: Json, signal: AbortSignal): Promise<{ status: number }>;
};
export type CouponResult = { status: "confirmed" | "provider_accepted" | "blocked" | "unknown" | "disabled"; code: string; synthetic: boolean; activationReady: false };
export type CouponConfig = {
  mode: "disabled" | "mock" | "live"; isolated: boolean; url: string; businessId: string;
  serviceKey: string; processKey: string; accountId: string; readKey: string; eventKey: string;
  qrOrigin: string; approvalId: string;
};
const obj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);
const uuid = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const ident = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(x);
const email = (x: unknown): x is string => typeof x === "string" && x === x.trim().toLowerCase()
  && x.length <= 254 && /^[^\s<>"\\@]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(x);
const date = (x: unknown): x is string => typeof x === "string" && /^\d{4}-\d\d-\d\dT/.test(x) && Number.isFinite(Date.parse(x));
const digest = async (x: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x)))].map(n => n.toString(16).padStart(2, "0")).join("");
const safeCode = (x: unknown, fallback = "not_authorized") => typeof x === "string" && /^[a-z][a-z0-9_]{0,79}$/.test(x) ? x : fallback;
const result = (provider: CouponProvider, status: CouponResult["status"], code: string): CouponResult => ({ status, code, synthetic: provider.mode === "mock", activationReady: false });

/** Every connection/account/credential is trusted server configuration; disabled is the default. */
export function couponConfig(env: Record<string, string | undefined>, hostname: string): CouponConfig {
  const target = resolveServerEnvironment(env, hostname);
  const prefix = target.isolated ? "TEST_" : "";
  const read = (key: string) => env[prefix + key] || "";
  const requested = read("COUPON_PROCESS_MODE");
  const processKey = read("COUPON_PROCESS_KEY");
  const accountId = read("COUPON_KLAVIYO_ACCOUNT_ID");
  const readKey = read("COUPON_KLAVIYO_READ_KEY");
  const eventKey = read("COUPON_KLAVIYO_EVENT_KEY");
  const approvalId = read("COUPON_LIVE_APPROVAL_ID");
  let qrOrigin = "";
  try { const u = new URL(read("COUPON_QR_ORIGIN")); if (u.protocol === "https:" && u.href === u.origin + "/" && !u.username && !u.password) qrOrigin = u.origin; } catch { /* fail closed */ }
  let mode: CouponConfig["mode"] = "disabled";
  if (target.configured && target.secret.startsWith("sb_secret_") && /^[A-Za-z0-9_-]{32,200}$/.test(processKey)
    && ident(accountId) && qrOrigin && read("COUPON_PROCESS_ENABLED") === "true") {
    if (target.isolated && requested === "mock") mode = "mock";
    if (!target.isolated && requested === "live" && /^[A-Za-z0-9_.:-]{8,120}$/.test(approvalId)
      && /^pk_[A-Za-z0-9_-]{10,200}$/.test(readKey) && /^pk_[A-Za-z0-9_-]{10,200}$/.test(eventKey)
      && readKey !== eventKey) mode = "live";
  }
  return { mode, isolated: target.isolated, url: target.url, businessId: target.businessId,
    serviceKey: target.secret, processKey, accountId, readKey, eventKey, qrOrigin, approvalId };
}

const RPCS = new Set(["coupon_confirmation_context_v1", "coupon_record_confirmed_vip_v1", "coupon_issue_confirmed_v1",
  "coupon_welcome_claim_v1", "coupon_welcome_context_v1", "coupon_welcome_finish_v1",
  "coupon_record_negative_v1",
  "message_send_reserve_v1", "message_send_claim_v1", "message_send_context_v1", "message_send_finalize_v1"]);
export function couponStore(config: CouponConfig, fetcher: Fetcher): CouponStore {
  return { async rpc(name, args) {
    if (config.mode === "disabled" || !RPCS.has(name)) throw new Error("coupon_rpc_unavailable");
    const r = await fetcher(`${config.url}/rest/v1/rpc/${name}`, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
      headers: { apikey: config.serviceKey, "Content-Type": "application/json" }, body: JSON.stringify(args) });
    if (!r.ok) throw new Error("coupon_rpc_unavailable");
    return r.json();
  } };
}

/** Narrow transport: GET identity/consent/list, POST one custom event. Never profile or subscription writes. */
export function liveCouponProvider(config: CouponConfig, fetcher: Fetcher): CouponProvider {
  const headers = (key: string) => ({ Authorization: `Klaviyo-API-Key ${key}`, Accept: "application/vnd.api+json", revision: COUPON_KLAVIYO_REVISION });
  return { mode: "live", async get(path, query = {}) {
    if (config.mode !== "live" || !config.approvalId || !/^\/(accounts|profiles|lists\/[A-Za-z0-9_-]+(?:\/profiles)?)$/.test(path)) throw new Error("provider_read_rejected");
    const u = new URL(`https://a.klaviyo.com/api${path}/`);
    for (const [key, value] of Object.entries(query)) {
      if (!["filter", "additional-fields[profile]", "page[size]"].includes(key)) throw new Error("provider_read_rejected");
      u.searchParams.set(key, value);
    }
    const r = await fetcher(u.href, { method: "GET", redirect: "manual", headers: headers(config.readKey), signal: AbortSignal.timeout(5000) });
    if (r.status !== 200) throw new Error("provider_read_unavailable");
    return r.json();
  }, async eventAccount() {
    if (config.mode !== "live" || !config.approvalId) throw new Error("provider_read_rejected");
    const r = await fetcher("https://a.klaviyo.com/api/accounts/", { method: "GET", redirect: "manual", headers: headers(config.eventKey), signal: AbortSignal.timeout(5000) });
    if (r.status !== 200) throw new Error("provider_read_unavailable");
    return r.json();
  }, async event(body, signal) {
    if (config.mode !== "live" || !config.approvalId || !validEvent(body)) throw new Error("provider_event_rejected");
    const r = await fetcher("https://a.klaviyo.com/api/events/", { method: "POST", redirect: "manual", signal,
      headers: { ...headers(config.eventKey), "Content-Type": "application/vnd.api+json" }, body: JSON.stringify(body) });
    // No provider response/error text is surfaced or logged.
    return { status: r.status };
  } };
}

async function account(provider: CouponProvider, accountId: string, eventKey = false) {
  const body = eventKey ? await provider.eventAccount() : await provider.get("/accounts");
  if (!obj(body) || !Array.isArray(body.data) || body.data.length !== 1 || !obj(body.data[0]) || body.data[0].id !== accountId) throw new Error("provider_account_mismatch");
}
async function profile(provider: CouponProvider, recipient: string, listId?: string): Promise<Json> {
  const body = await provider.get(listId ? `/lists/${listId}/profiles` : "/profiles", {
    filter: `equals(email,${JSON.stringify(recipient)})`, "additional-fields[profile]": "subscriptions", "page[size]": "2" });
  if (!obj(body) || !Array.isArray(body.data) || body.data.length !== 1 || !obj(body.data[0]) || !ident(body.data[0].id)
    || !obj(body.data[0].attributes) || body.data[0].attributes.email !== recipient) throw new Error("provider_profile_unconfirmed");
  return body.data[0];
}
function marketing(p: Json): Json {
  const a = p.attributes;
  if (!obj(a) || !obj(a.subscriptions) || !obj(a.subscriptions.email) || !obj(a.subscriptions.email.marketing)) throw new Error("provider_consent_missing");
  return a.subscriptions.email.marketing;
}
function clear(m: Json, listId?: string): boolean {
  return m.consent === "SUBSCRIBED" && m.can_receive_email_marketing === true
    && Array.isArray(m.suppression) && m.suppression.length === 0 && Array.isArray(m.list_suppressions)
    && !m.list_suppressions.some(x => !obj(x) || !ident(x.list_id) || !listId || x.list_id === listId);
}
function negative(m: Json, listId?: string): "unsubscribed" | "suppressed" | null {
  if (m.consent === "UNSUBSCRIBED") return "unsubscribed";
  if ((m.consent === "SUBSCRIBED" && m.can_receive_email_marketing === false)
    || (Array.isArray(m.suppression) && m.suppression.length > 0)
    || (Array.isArray(m.list_suppressions) && m.list_suppressions.some(x => obj(x) && (!listId || x.list_id === listId)))) return "suppressed";
  return null;
}

/** Reads actual DOI/list/profile evidence; browser assertions never supply permission. */
export async function confirmCouponVip({ store, provider, businessId, customerId, signupId, accountId, now = Date.now }: {
  store: CouponStore; provider: CouponProvider; businessId: string; customerId: string; signupId: string; accountId: string; now?: () => number;
}): Promise<CouponResult> {
  if (![businessId, customerId, signupId].every(uuid) || !ident(accountId)) return result(provider, "blocked", "invalid_input");
  try {
    const c = await store.rpc("coupon_confirmation_context_v1", { p_business_id: businessId, p_customer_id: customerId, p_signup_id: signupId });
    if (!obj(c) || c.allowed !== true) return result(provider, "blocked", obj(c) ? safeCode(c.code) : "context_unconfirmed");
    if (c.businessId !== businessId || c.customerId !== customerId || c.signupId !== signupId || !email(c.email)
      || !ident(c.vipListId) || !date(c.requestedAt) || c.isTest !== false) return result(provider, "blocked", "invalid_context");
    await account(provider, accountId);
    const list = await provider.get(`/lists/${c.vipListId}`);
    if (!obj(list) || !obj(list.data) || list.data.id !== c.vipListId || !obj(list.data.attributes)
      || list.data.attributes.opt_in_process !== "double_opt_in") return result(provider, "blocked", "list_not_double_opt_in");
    const p = await profile(provider, c.email); const m = marketing(p);
    const denied = negative(m, c.vipListId);
    if (denied) {
      await store.rpc("coupon_record_negative_v1", { p_business_id: businessId, p_customer_id: customerId,
        p_email: c.email, p_status: denied, p_checked_at: new Date(now()).toISOString() });
      return result(provider, "blocked", "provider_recipient_blocked");
    }
    if (!clear(m, c.vipListId) || m.double_optin !== true || !date(m.consent_timestamp)
      || Date.parse(m.consent_timestamp) < Date.parse(c.requestedAt) || Date.parse(m.consent_timestamp) > now() + 60000) return result(provider, "blocked", "double_opt_in_unconfirmed");
    const member = await profile(provider, c.email, c.vipListId);
    if (member.id !== p.id) return result(provider, "blocked", "provider_identity_changed");
    const checkedAt = new Date(now()).toISOString();
    const saved = await store.rpc("coupon_record_confirmed_vip_v1", { p_business_id: businessId, p_customer_id: customerId,
      p_signup_id: signupId, p_provider_profile_id: p.id, p_confirmed_at: m.consent_timestamp, p_checked_at: checkedAt,
      p_evidence: { source: "klaviyo", listId: c.vipListId, emailSha256: await digest(c.email), doubleOptIn: true,
        canReceiveEmailMarketing: true, consent: "SUBSCRIBED", reference: `profile:${String(p.id)}` } });
    if (!obj(saved) || saved.confirmed !== true) return result(provider, "unknown", "confirmation_receipt_unconfirmed");
    return result(provider, "confirmed", "confirmation_recorded");
  } catch { return result(provider, "unknown", "confirmation_unconfirmed"); }
}

type Job = { jobId: string; jobLeaseId: string; couponId: string; businessId: string; customerId: string; messageKey: string; eventUniqueId: string; recipient: string; properties: Json };
function job(value: unknown, businessId: string): value is Job & Json {
  return obj(value) && value.allowed === true && [value.jobId, value.jobLeaseId, value.couponId, value.customerId, value.eventUniqueId].every(uuid)
    && value.businessId === businessId && email(value.recipient) && value.messageKey === `coupon-welcome:${String(value.couponId)}` && obj(value.properties);
}
function properties(j: Job, qrOrigin: string): Json | null {
  const p = j.properties;
  if (typeof p.coupon_code !== "string" || !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){3}$/.test(p.coupon_code)
    || p.coupon_qr_payload !== `VIPCOUPON1:${p.coupon_code}` || typeof p.coupon_qr_token !== "string" || !/^[a-f0-9]{32}$/.test(p.coupon_qr_token)
    || !uuid(p.campaign_id) || p.coupon_id !== j.couponId || p.message_key !== j.messageKey
    // This reviewed initial template promises exactly $30 and all three own
    // channels. Other configurable terms require a separately reviewed template.
    || p.minimum_amount_cents !== 3000 || !Array.isArray(p.channels)
    || p.channels.length !== 3 || [...p.channels].sort().join() !== "dine_in,site_delivery,site_pickup"
    || (p.expires_at !== null && !date(p.expires_at))) return null;
  let origin: URL; try { origin = new URL(qrOrigin); } catch { return null; }
  if (origin.protocol !== "https:" || origin.href !== origin.origin + "/") return null;
  return { coupon_code: p.coupon_code, coupon_qr_payload: p.coupon_qr_payload,
    coupon_qr_image_url: `${origin.origin}/api/coupon-qr/${p.coupon_qr_token}.gif`, campaign_id: p.campaign_id,
    coupon_id: j.couponId, minimum_amount_cents: p.minimum_amount_cents, channels: [...p.channels], expires_at: p.expires_at, message_key: j.messageKey };
}
function validEvent(body: Json): boolean {
  const d = body.data; if (Object.keys(body).join() !== "data" || !obj(d) || Object.keys(d).sort().join() !== "attributes,type" || d.type !== "event" || !obj(d.attributes)) return false;
  const a = d.attributes;
  return Object.keys(a).sort().join() === "metric,profile,properties,unique_id" && uuid(a.unique_id) && obj(a.properties)
    && Object.keys(a.properties).sort().join() === "campaign_id,channels,coupon_code,coupon_id,coupon_qr_image_url,coupon_qr_payload,expires_at,message_key,minimum_amount_cents"
    && obj(a.metric) && Object.keys(a.metric).join() === "data" && obj(a.metric.data) && Object.keys(a.metric.data).sort().join() === "attributes,type" && a.metric.data.type === "metric"
    && obj(a.metric.data.attributes) && a.metric.data.attributes.name === COUPON_WELCOME_METRIC
    && Object.keys(a.metric.data.attributes).join() === "name" && obj(a.profile) && Object.keys(a.profile).join() === "data"
    && obj(a.profile.data) && Object.keys(a.profile.data).sort().join() === "attributes,type" && a.profile.data.type === "profile" && obj(a.profile.data.attributes)
    && email(a.profile.data.attributes.email) && Object.keys(a.profile.data.attributes).join() === "email";
}

/** Durable outbox + K6. A 202 finalizes K6 as UNKNOWN, never SENT; no automatic retry. */
export async function processCouponWelcome({ store, provider, businessId, accountId, qrOrigin, couponId = null, now = Date.now, timeoutMs = 5000 }: {
  store: CouponStore; provider: CouponProvider; businessId: string; accountId: string; qrOrigin: string; couponId?: string | null; now?: () => number; timeoutMs?: number;
}): Promise<CouponResult> {
  if (!uuid(businessId) || (couponId !== null && !uuid(couponId)) || !ident(accountId) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) return result(provider, "blocked", "invalid_input");
  let j: Job | null = null; let reservation: string | null = null; let lease: string | null = null;
  const finish = async (outcome: "provider_accepted" | "unknown" | "blocked", code: string) => {
    if (!j) return result(provider, "unknown", "outbox_unconfirmed");
    if (reservation && lease) {
      try {
        const g = await store.rpc("message_send_finalize_v1", { p_reservation_id: reservation, p_lease_id: lease, p_outcome: outcome === "blocked" ? "blocked" : "unknown" });
        if (!obj(g) || typeof g.idempotent !== "boolean" || g.status !== (outcome === "blocked" ? "blocked" : "unknown")) return result(provider, "unknown", "gate_finalize_unconfirmed");
      } catch { return result(provider, "unknown", "gate_finalize_unconfirmed"); }
    }
    try {
      const receipt = await store.rpc("coupon_welcome_finish_v1", { p_job_id: j.jobId, p_job_lease_id: j.jobLeaseId,
        p_outcome: outcome, p_message_reservation_id: reservation, p_provider_event_id: null, p_safe_code: code });
      if (!obj(receipt) || receipt.acknowledged !== true || receipt.status !== outcome) return result(provider, "unknown", "outbox_finalize_unconfirmed");
    } catch { return result(provider, "unknown", "outbox_finalize_unconfirmed"); }
    return result(provider, outcome, code);
  };
  try {
    const claimed = await store.rpc("coupon_welcome_claim_v1", { p_business_id: businessId, p_coupon_id: couponId });
    if (!obj(claimed) || claimed.allowed !== true) return result(provider, "blocked", obj(claimed) ? safeCode(claimed.code) : "outbox_unconfirmed");
    if (!job(claimed, businessId)) return result(provider, "unknown", "invalid_outbox_context");
    j = structuredClone(claimed);
    const p = properties(j, qrOrigin);
    if (!p) return finish("blocked", "invalid_coupon_properties");
    const payloadHash = await digest(JSON.stringify(p));
    const r = await store.rpc("message_send_reserve_v1", { p_business_id: businessId, p_customer_id: j.customerId,
      p_message_key: j.messageKey, p_message_kind: "flow", p_payload_sha256: payloadHash });
    if (!obj(r) || r.allowed !== true) return finish("blocked", obj(r) ? safeCode(r.code) : "gate_reserve_unconfirmed");
    if (!uuid(r.reservationId) || r.status !== "reserved" || !["reserved", "already_reserved"].includes(String(r.code))) return finish("unknown", "gate_reserve_unconfirmed");
    reservation = r.reservationId;
    const c = await store.rpc("message_send_claim_v1", { p_reservation_id: reservation });
    if (!obj(c) || c.allowed !== true || c.code !== "claimed" || !uuid(c.leaseId) || c.status !== "claimed" || c.reservationId !== reservation
      || !date(c.dispatchExpiresAt) || Date.parse(c.dispatchExpiresAt) <= now()) return finish("unknown", "gate_claim_unconfirmed");
    lease = c.leaseId;
    await account(provider, accountId);
    await account(provider, accountId, true);
    const current = marketing(await profile(provider, j.recipient));
    if (!clear(current)) {
      const denied = negative(current);
      if (denied) {
        await store.rpc("coupon_record_negative_v1", { p_business_id: businessId, p_customer_id: j.customerId, p_email: j.recipient,
          p_status: denied, p_checked_at: new Date(now()).toISOString() });
      }
      return finish("blocked", "provider_recipient_blocked");
    }
    // The final outbox read is followed by K6's consuming current-state grant.
    const fresh = await store.rpc("coupon_welcome_context_v1", { p_job_id: j.jobId, p_job_lease_id: j.jobLeaseId });
    if (!job(fresh, businessId) || fresh.jobId !== j.jobId || fresh.jobLeaseId !== j.jobLeaseId || fresh.couponId !== j.couponId || JSON.stringify(properties(fresh, qrOrigin)) !== JSON.stringify(p)
      || fresh.recipient !== j.recipient || fresh.customerId !== j.customerId || fresh.messageKey !== j.messageKey
      || fresh.eventUniqueId !== j.eventUniqueId) return finish("blocked", "outbox_context_changed");
    const gate = await store.rpc("message_send_context_v1", { p_reservation_id: reservation, p_lease_id: lease });
    const ctx = obj(gate) ? gate.context : null;
    if (!obj(gate) || gate.allowed !== true || gate.code !== "dispatch_authorized" || gate.status !== "sending" || gate.reservationId !== reservation || !obj(ctx)
      || ctx.businessId !== businessId || ctx.customerId !== j.customerId || ctx.messageKey !== j.messageKey
      || ctx.payloadSha256 !== payloadHash || ctx.messageKind !== "flow" || ctx.leaseId !== lease
      || ctx.email !== j.recipient || ctx.emailStatus !== "subscribed" || ctx.isTest !== false
      || ctx.suppressedAt !== null || ctx.providerBlockedStatus !== null || !date(ctx.dispatchExpiresAt)
      || ctx.dispatchExpiresAt !== c.dispatchExpiresAt || Date.parse(ctx.dispatchExpiresAt) <= now()) return finish("blocked", "gate_context_denied");
    const body: Json = { data: { type: "event", attributes: { properties: p,
      metric: { data: { type: "metric", attributes: { name: COUPON_WELCOME_METRIC } } },
      profile: { data: { type: "profile", attributes: { email: j.recipient } } }, unique_id: j.eventUniqueId } } };
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const receipt = await Promise.race([provider.event(body, controller.signal), new Promise<never>((_r, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("provider_timeout")); }, timeoutMs);
      })]);
      return finish(receipt.status === 202 ? "provider_accepted" : "unknown", receipt.status === 202 ? "pending_delivery_receipt_reconciliation" : "provider_event_unconfirmed");
    } catch { return finish("unknown", "provider_event_unconfirmed"); }
    finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); }
  } catch { return j ? finish("unknown", "processing_unconfirmed") : result(provider, "unknown", "outbox_unconfirmed"); }
}

/** Optional service entry point, deliberately not mounted in public form/staff routes. */
export async function handleCouponProcessRequest(request: Request, config: CouponConfig, dependencies: { store: CouponStore; provider: CouponProvider }): Promise<Response> {
  const reply = (status: number, body: Json) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (request.method !== "POST") return reply(405, { code: "method_not_allowed" });
  if (config.mode === "disabled") return reply(503, { code: "coupon_processing_disabled" });
  if (request.headers.has("Origin") || request.headers.get("Authorization") !== `Bearer ${config.processKey}` || config.processKey.length < 32) return reply(403, { code: "forbidden" });
  if (request.headers.get("Content-Type") !== "application/json" || Number(request.headers.get("Content-Length") || 0) > 1024) return reply(400, { code: "invalid_input" });
  try {
    const raw = await request.text(); if (raw.length > 1024) return reply(400, { code: "invalid_input" });
    const b: unknown = JSON.parse(raw); if (!obj(b) || b.businessId !== config.businessId || dependencies.provider.mode !== config.mode) return reply(403, { code: "forbidden" });
    let r: CouponResult;
    if (b.action === "confirm" && Object.keys(b).sort().join() === "action,businessId,customerId,signupId" && uuid(b.customerId) && uuid(b.signupId)) r = await confirmCouponVip({ ...dependencies, businessId: config.businessId, customerId: b.customerId, signupId: b.signupId, accountId: config.accountId });
    else if (b.action === "welcome" && Object.keys(b).sort().join() === "action,businessId,couponId" && (b.couponId === null || uuid(b.couponId))) r = await processCouponWelcome({ ...dependencies, businessId: config.businessId, accountId: config.accountId, qrOrigin: config.qrOrigin, couponId: b.couponId });
    else return reply(400, { code: "invalid_input" });
    return reply(r.status === "unknown" ? 503 : 200, r);
  } catch { return reply(503, { code: "processing_unconfirmed" }); }
}
