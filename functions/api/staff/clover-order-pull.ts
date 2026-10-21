import { CloverRequestGate, closedPullWindow, collectOrders, orderPullConfig, PullError, type PullStep, type PullEnv, type Fetcher } from "../../_lib/cloverOrderPull.ts";

type Context = { request: Request; env: PullEnv };
type AuditBinding = { writeDataPoint: (point: { blobs: string[]; doubles: number[] }) => void };
const headers = { "Cache-Control": "private, no-store", "Content-Type": "application/json" };
const reply = (status: number, code: string, fields: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ code, ...fields }), { status, headers });
const auditIssue = (env: PullEnv, status: number, code: string, step: PullStep, providerStatus?: number, requestCount = 0) => {
  // Structured metadata only: never log the request, token, Clover response or customer record.
  console.warn("k7_pull_failure", { code, step, status, requestCount, ...(providerStatus ? { providerStatus } : {}) });
  const audit = (env as unknown as { CLOVER_PULL_AUDIT?: AuditBinding }).CLOVER_PULL_AUDIT;
  try { audit?.writeDataPoint({ blobs: [code, step], doubles: [status, providerStatus || 0, requestCount] }); }
  catch { console.warn("k7_pull_audit_unavailable"); }
};
const failure = (env: PullEnv, status: number, code: string, step: PullStep, providerStatus?: number, requestCount = 0) => {
  auditIssue(env, status, code, step, providerStatus, requestCount);
  return reply(status, code, { step, requestCount, ...(providerStatus ? { providerStatus } : {}) });
};

async function rpc(url: string, key: string, method: string, body: Record<string, unknown>, fetcher: Fetcher,
  bearer?: string): Promise<unknown> {
  const step: PullStep = bearer ? "authorization" : "ingest";
  let response: Response;
  try {
    response = await fetcher(`${url}/rest/v1/rpc/${method}`, { method: "POST", redirect: "manual",
      signal: AbortSignal.timeout(10000), headers: { apikey: key,
        ...(bearer ? { Authorization: bearer } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch { throw new PullError("database_request_failed", step); }
  if (!response.ok) throw new PullError(response.status === 401 || response.status === 403
    ? "database_access_denied" : "database_http_error", step, response.status);
  try { return await response.json(); } catch { throw new PullError("database_response_invalid", step); }
}

/** Manual only. No scheduler and no browser-supplied merchant or business ID. */
export function cloverOrderPullHandler(fetcher: Fetcher = fetch) {
  return async ({ request, env }: Context): Promise<Response> => {
    if (request.method !== "POST") return reply(405, "method_not_allowed");
    const url = new URL(request.url);
    if (request.headers.get("Origin") !== url.origin) return failure(env, 403, "forbidden", "authorization");
    const bearer = request.headers.get("Authorization") || "";
    if (!/^Bearer [A-Za-z0-9_.-]{20,4096}$/.test(bearer)) return failure(env, 401, "unauthorized", "authorization");
    const config = orderPullConfig(env, url.hostname);
    if (!config.ready) return failure(env, 503, "connection_unavailable", "configuration");
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return reply(415, "invalid_content_type");
    const bodyText = await request.text();
    if (bodyText.length > 128) return reply(413, "too_large");
    let body: unknown;
    try { body = JSON.parse(bodyText); } catch { return reply(400, "invalid_request"); }
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).join() !== "day" || typeof (body as { day?: unknown }).day !== "string") return reply(400, "invalid_request");
    const day = (body as { day: string }).day;
    const window = closedPullWindow(day);
    if (!window) return reply(400, "invalid_request");
    const gate = new CloverRequestGate();
    let written = 0;
    try {
      const allowed = await rpc(config.url, config.publicKey, "crm_staff_authorized_v1", {}, fetcher, bearer);
      if (allowed !== true) return failure(env, 403, "forbidden", "authorization");
      const { orders, warnings, requestCount } = await collectOrders(config, window, fetcher, gate);
      const uniqueWarnings = [...new Map(warnings.map(warning => [warning.step, warning])).values()];
      for (const warning of uniqueWarnings) auditIssue(env, 200, warning.code, warning.step, warning.httpStatus, requestCount);
      for (const order of orders) {
        await rpc(config.url, config.secret, "clover_order_ingest_v1",
          { p_business_id: config.businessId, p_merchant_id: config.merchant, p_snapshot: order }, fetcher);
        written++;
      }
      try { (env as unknown as { CLOVER_PULL_AUDIT?: AuditBinding }).CLOVER_PULL_AUDIT?.writeDataPoint({
        blobs: ["pull_completed", "ingest"], doubles: [200, 0, requestCount] }); } catch { /* audit cannot fail an ingested pull */ }
      return reply(200, "ok", { fetched: orders.length, upserted: written,
        day, requestCount, warnings: uniqueWarnings });
    } catch (error) {
      const known = error instanceof PullError ? error : new PullError("pull_unconfirmed", "ingest");
      const status = known.step === "authorization" && known.code === "database_access_denied" ? 403 : 503;
      auditIssue(env, status, known.code, known.step, known.providerStatus, gate.attempts);
      return reply(status, known.code, { step: known.step, requestCount: gate.attempts,
        upserted: written, ...(known.providerStatus ? { providerStatus: known.providerStatus } : {}) });
    }
  };
}

export const onRequestPost = cloverOrderPullHandler();
export function onRequest(): Response { return reply(405, "method_not_allowed"); }
