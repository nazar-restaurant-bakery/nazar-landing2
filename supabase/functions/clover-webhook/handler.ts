import { snapshot, PullError } from "../_shared/cloverSnapshot.ts";

type Values = Record<string, string | undefined>;
type ObjectValue = Record<string, unknown>;
type Fetcher = typeof fetch;
const object = (x: unknown): x is ObjectValue => x !== null && typeof x === "object" && !Array.isArray(x);
const id = (x: unknown): x is string => typeof x === "string" && /^[A-Za-z0-9]{8,32}$/.test(x);
const result = (status: number, code: string) => Response.json({ code },
  { status, headers: { "Cache-Control": "no-store" } });

// Clover app event webhooks use X-Clover-Auth, not Hosted Checkout's HMAC header.
// The order body is never financial truth: all financial fields come from GET Orders.
export async function constantTimeAuth(received: string | null, expected: string): Promise<boolean> {
  if (!expected || !received || received.length !== expected.length) return false;
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", new TextEncoder().encode(received)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected))]);
  const x = new Uint8Array(a); const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function rpc(url: string, key: string, method: string, body: ObjectValue, fetcher: Fetcher): Promise<unknown> {
  const response = await fetcher(`${url}/rest/v1/rpc/${method}`, { method: "POST", redirect: "manual",
    signal: AbortSignal.timeout(10000), headers: { apikey: key,
      ...(key.startsWith("sb_secret_") ? {} : { Authorization: `Bearer ${key}` }),
      "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error("database_unavailable");
  return response.json();
}

async function cloverGet(url: URL, token: string, fetcher: Fetcher, step: string): Promise<ObjectValue> {
  let response: Response;
  try { response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "NazarCRM/1.0" } }); }
  catch { throw new Error(`${step}_request_failed`); }
  if (!response.ok) throw new Error(`${step}_${response.status === 401 || response.status === 403 ? "access_denied" : "http_error"}`);
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error(`${step}_response_invalid`); }
  if (!object(body)) throw new Error(`${step}_response_invalid`);
  return body;
}

type Claim = { claimed: boolean; eventId: string | null; businessId: string;
  environment: string; tokenSecretName: string; onlineOrderTypeIds: string[] };
type Event = { merchant: string; objectId: string; action: string; ts: number; kind: "order" | "payment"; objectKey: string };

function parseEvents(payload: unknown, appId: string): Event[] | null {
  if (!object(payload) || payload.appId !== appId || !object(payload.merchants)) return null;
  const events: Event[] = [];
  for (const [merchant, updates] of Object.entries(payload.merchants)) {
    if (!id(merchant) || !Array.isArray(updates)) return null;
    for (const item of updates) {
      if (!object(item) || typeof item.objectId !== "string"
        || !/^(O|P):[A-Za-z0-9]{8,32}$/.test(item.objectId)
        || !["CREATE", "UPDATE", "DELETE"].includes(String(item.type))
        || !Number.isSafeInteger(item.ts) || Number(item.ts) < 1_400_000_000_000) return null;
      const [key, objectKey] = item.objectId.split(":");
      events.push({ merchant, objectId: item.objectId, objectKey, action: String(item.type),
        ts: Number(item.ts), kind: key === "O" ? "order" : "payment" });
      if (events.length > 20) return null;
    }
  }
  return events.length ? events : null;
}

async function eventHash(event: Event): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(
    `${event.merchant}:${event.objectId}:${event.action}:${event.ts}`)));
  return Array.from(bytes, x => x.toString(16).padStart(2, "0")).join("");
}

async function freshOrder(event: Event, binding: Claim, token: string, fetcher: Fetcher): Promise<ObjectValue> {
  const base = binding.environment === "sandbox" ? "https://apisandbox.dev.clover.com" : "https://api.clover.com";
  let orderId = event.objectKey;
  if (event.kind === "payment") {
    const paymentUrl = new URL(`${base}/v3/merchants/${event.merchant}/payments/${event.objectKey}`);
    paymentUrl.searchParams.set("expand", "order");
    const payment = await cloverGet(paymentUrl,
      token, fetcher, "payment_lookup");
    if (payment.id !== event.objectKey || !object(payment.order) || !id(payment.order.id))
      throw new Error("payment_order_missing");
    orderId = payment.order.id;
  }
  const url = new URL(`${base}/v3/merchants/${event.merchant}/orders/${orderId}`);
  url.searchParams.set("expand", "lineItems,payments,orderType");
  const core = await cloverGet(url, token, fetcher, "order_core");
  if (core.id !== orderId) throw new Error("order_id_mismatch");
  let refunds: unknown;
  let refundsVerified = true;
  url.searchParams.set("expand", "refunds");
  try {
    const response = await cloverGet(url, token, fetcher, "order_refunds");
    if (response.id !== orderId) throw new Error("order_id_mismatch");
    refunds = response.refunds;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "order_refunds_access_denied") throw error;
    refundsVerified = false;
  }
  let customers: unknown;
  let customerAccess = "verified";
  const online = object(core.orderType) && typeof core.orderType.id === "string"
    && binding.onlineOrderTypeIds.includes(core.orderType.id);
  if (online) {
    url.searchParams.set("expand", "customers");
    try {
      const response = await cloverGet(url, token, fetcher, "order_customers");
      if (response.id !== orderId) throw new Error("order_id_mismatch");
      customers = response.customers;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "order_customers_access_denied") throw error;
      customerAccess = "denied";
    }
  }
  try { return snapshot({ ...core, refunds, customers, refundsVerified, customerAccess },
    event.merchant, binding.onlineOrderTypeIds); }
  catch (error) { throw error instanceof PullError ? new Error(error.code) : new Error("snapshot_invalid"); }
}

export function cloverWebhookHandler(env: Values, fetcher: Fetcher = fetch) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return result(405, "method_not_allowed");
    if (!env.SUPABASE_URL || !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(env.SUPABASE_URL)
      || !env.SUPABASE_SERVICE_ROLE_KEY
      || !id(env.CLOVER_WEBHOOK_APP_ID) || !["sandbox", "production"].includes(env.CLOVER_WEBHOOK_ENV || ""))
      return result(503, "configuration_unavailable");
    if (Number(request.headers.get("Content-Length") || 0) > 16384) return result(413, "too_large");
    const raw = await request.text();
    if (raw.length > 16384) return result(413, "too_large");
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { return result(400, "invalid_json"); }

    // Clover setup challenge has no X-Clover-Auth yet. Enable only temporarily.
    if (object(payload) && typeof payload.verificationCode === "string"
      && Object.keys(payload).length === 1 && env.CLOVER_WEBHOOK_SETUP_ENABLED === "true") {
      try { await rpc(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY,
        "clover_webhook_verification_v1", { p_code: payload.verificationCode }, fetcher);
        return result(200, "verification_received"); }
      catch { return result(503, "verification_unavailable"); }
    }
    if (!env.CLOVER_WEBHOOK_SECRET) return result(503, "configuration_unavailable");
    if (!await constantTimeAuth(request.headers.get("X-Clover-Auth"), env.CLOVER_WEBHOOK_SECRET))
      return result(401, "invalid_auth");
    const events = parseEvents(payload, env.CLOVER_WEBHOOK_APP_ID);
    if (!events) return result(400, "invalid_event");
    let processed = 0; let failed = 0;
    for (const event of events) {
      const started = new Date().toISOString();
      let claim: Claim | null;
      try {
        claim = await rpc(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, "clover_webhook_claim_v1",
          { p_merchant_id: event.merchant, p_event_id: await eventHash(event), p_event_type: event.kind,
            p_event_action: event.action, p_object_id: event.objectKey,
            p_raw_event: { appId: (payload as ObjectValue).appId, merchantId: event.merchant,
              objectId: event.objectId, type: event.action, ts: event.ts } }, fetcher) as Claim | null;
      } catch { return result(503, "event_storage_unavailable"); }
      if (!claim || claim.environment !== env.CLOVER_WEBHOOK_ENV) { failed++; continue; }
      if (!claim.claimed) continue;
      let step = "ingest"; let errorCode: string | null = null;
      try {
        const token = env[claim.tokenSecretName];
        if (!token || token.length < 12) throw new Error("clover_token_missing");
        step = "clover_lookup";
        const order = await freshOrder(event, claim, token, fetcher);
        step = "ingest";
        const ingest = await rpc(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, "clover_order_ingest_v1",
          { p_business_id: claim.businessId, p_merchant_id: event.merchant, p_snapshot: order }, fetcher);
        if (!object(ingest) || typeof ingest.orderId !== "string") throw new Error("ingest_unconfirmed");
        processed++;
      } catch (error) {
        failed++;
        errorCode = error instanceof Error && /^[a-z_]{2,60}$/.test(error.message) ? error.message : "webhook_unconfirmed";
      }
      try { const finished = await rpc(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, "clover_webhook_finish_v1",
        { p_business_id: claim.businessId, p_event_id: claim.eventId,
          p_status: errorCode ? "failed" : "processed", p_step: step,
          p_error_code: errorCode, p_http_status: errorCode ? 503 : 200, p_started_at: started }, fetcher);
        if (finished !== true) throw new Error("finish_unconfirmed"); }
      catch { return result(503, "event_finish_unavailable"); }
    }
    return result(failed ? 503 : 200, failed ? "event_retry_needed" : processed ? "processed" : "duplicate");
  };
}
