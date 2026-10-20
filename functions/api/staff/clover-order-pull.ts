import { collectOrders, orderPullConfig, type PullEnv, type Fetcher } from "../../_lib/cloverOrderPull.ts";

type Context = { request: Request; env: PullEnv };
const headers = { "Cache-Control": "private, no-store", "Content-Type": "application/json" };
const reply = (status: number, code: string, fields: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ code, ...fields }), { status, headers });

async function rpc(url: string, key: string, method: string, body: Record<string, unknown>, fetcher: Fetcher,
  bearer?: string): Promise<unknown> {
  const response = await fetcher(`${url}/rest/v1/rpc/${method}`, { method: "POST", redirect: "manual",
    signal: AbortSignal.timeout(10000), headers: { apikey: bearer ? key : key,
      ...(bearer ? { Authorization: bearer } : {}), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "authorization_failed" : "database_unavailable");
  return response.json();
}

/** Manual only. No scheduler and no browser-supplied merchant or business ID. */
export function cloverOrderPullHandler(fetcher: Fetcher = fetch) {
  return async ({ request, env }: Context): Promise<Response> => {
    if (request.method !== "POST") return reply(405, "method_not_allowed");
    const url = new URL(request.url);
    if (request.headers.get("Origin") !== url.origin) return reply(403, "forbidden");
    const bearer = request.headers.get("Authorization") || "";
    if (!/^Bearer [A-Za-z0-9_.-]{20,4096}$/.test(bearer)) return reply(401, "unauthorized");
    const config = orderPullConfig(env, url.hostname);
    if (!config.ready) return reply(503, "connection_unavailable");
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return reply(415, "invalid_content_type");
    const bodyText = await request.text();
    if (bodyText.length > 128) return reply(413, "too_large");
    let body: unknown;
    try { body = JSON.parse(bodyText); } catch { return reply(400, "invalid_request"); }
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).join() !== "days" || !Number.isInteger((body as { days?: unknown }).days)
      || Number((body as { days?: unknown }).days) < 1 || Number((body as { days?: unknown }).days) > 30) return reply(400, "invalid_request");
    try {
      const allowed = await rpc(config.url, config.publicKey, "crm_staff_authorized_v1", {}, fetcher, bearer);
      if (allowed !== true) return reply(403, "forbidden");
      const orders = await collectOrders(config, Number((body as { days: number }).days), fetcher);
      let written = 0;
      for (const order of orders) {
        await rpc(config.url, config.secret, "clover_order_ingest_v1",
          { p_business_id: config.businessId, p_merchant_id: config.merchant, p_snapshot: order }, fetcher);
        written++;
      }
      return reply(200, "ok", { fetched: orders.length, upserted: written, periodDays: (body as { days: number }).days });
    } catch (error) {
      const code = error instanceof Error && error.message === "clover_scope_or_auth" ? "clover_scope_or_auth"
        : error instanceof Error && error.message === "authorization_failed" ? "forbidden" : "pull_unconfirmed";
      return reply(code === "forbidden" ? 403 : 503, code);
    }
  };
}

export const onRequestPost = cloverOrderPullHandler();
export function onRequest(): Response { return reply(405, "method_not_allowed"); }
