import { resolveServerEnvironment } from "../../../src/lib/deploymentEnvironment.ts";

type Context = { request: Request; env: Record<string, string | undefined> };
type Fetcher = typeof fetch;
const headers = { "Cache-Control": "private, no-store", "Content-Type": "application/json" };
const reply = (status: number, code: string, data?: unknown) =>
  new Response(JSON.stringify({ code, ...(data === undefined ? {} : { data }) }), { status, headers });

export function commissionCompareHandler(fetcher: Fetcher = fetch) {
  return async ({ request, env }: Context): Promise<Response> => {
    if (request.method !== "POST") return reply(405, "method_not_allowed");
    const url = new URL(request.url);
    if (request.headers.get("Origin") !== url.origin) return reply(403, "forbidden");
    const bearer = request.headers.get("Authorization") || "";
    if (!/^Bearer [A-Za-z0-9_.-]{20,4096}$/.test(bearer)) return reply(401, "unauthorized");
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return reply(415, "invalid_content_type");
    const bodyText = await request.text();
    if (bodyText.length > 64) return reply(413, "too_large");
    let body: unknown;
    try { body = JSON.parse(bodyText); } catch { return reply(400, "invalid_request"); }
    const month = typeof body === "object" && body !== null && !Array.isArray(body)
      && Object.keys(body).join() === "month" ? (body as { month: unknown }).month : null;
    if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return reply(400, "invalid_month");
    const target = resolveServerEnvironment(env, url.hostname);
    const key = target.isolated ? env.VITE_TEST_SUPABASE_ANON_KEY : env.VITE_SUPABASE_ANON_KEY;
    if (!target.configured || !target.secret.startsWith("sb_secret_") || !key?.startsWith("sb_publishable_"))
      return reply(503, "connection_unavailable");
    async function rpc(name: string, apiKey: string, body: Record<string, unknown>, authorization: string) {
      const response = await fetcher(`${target.url}/rest/v1/rpc/${name}`, { method: "POST", redirect: "manual",
        signal: AbortSignal.timeout(10000), headers: { apikey: apiKey, Authorization: authorization,
          "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) return { ok: false, status: response.status, data: null };
      return { ok: true, status: 200, data: await response.json() as unknown };
    }
    try {
      const auth = await rpc("crm_staff_authorized_v1", key, {}, bearer);
      if (!auth.ok || auth.data !== true) return reply(auth.status === 401 ? 401 : 403, "forbidden");
      const comparison = await rpc("commission_compare_from_orders_v1", target.secret,
        { p_business_id: target.businessId, p_month: `${month}-01` }, `Bearer ${target.secret}`);
      if (!comparison.ok) return reply(503, "comparison_unavailable");
      return reply(200, "ok", comparison.data);
    } catch { return reply(503, "comparison_unavailable"); }
  };
}

export const onRequestPost = commissionCompareHandler();
export function onRequest(): Response { return reply(405, "method_not_allowed"); }
