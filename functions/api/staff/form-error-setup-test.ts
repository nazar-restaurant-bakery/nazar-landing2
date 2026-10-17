import { recordFormFailure } from "../signup";
type Env = { VITE_SUPABASE_ANON_KEY?: string; SUPABASE_SECRET_KEY?: string; CLOUDFLARE_EMAIL_SEND_TOKEN?: string; FORM_ERROR_ALERTS_ENABLED?: string };
const project = "https://khgczybubufouraqyrcj.supabase.co";
// A permanent receipt prevents a second attempt, including after a lost response.
const testId = "d8ef70a3-04b7-49c4-a2b9-3b9137c8c802";
function reply(status: number, code: string) {
  return Response.json({ code, reference: testId }, { status, headers: { "Cache-Control": "private, no-store" } });
}
export async function onRequestPost({ request, env }: { request: Request; env: Env }) {
  if (request.headers.get("Origin") !== new URL(request.url).origin) return reply(403, "forbidden");
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return reply(415, "invalid_content_type");
  const bearer = request.headers.get("Authorization") || "";
  if (!/^Bearer [A-Za-z0-9_.-]{20,4096}$/.test(bearer)) return reply(401, "unauthorized");
  if (env.FORM_ERROR_ALERTS_ENABLED !== "true" || !env.CLOUDFLARE_EMAIL_SEND_TOKEN || !env.SUPABASE_SECRET_KEY || !env.VITE_SUPABASE_ANON_KEY) return reply(503, "alerts_not_ready");
  try {
    if (Number(request.headers.get("Content-Length") || 0) > 128 || (await request.text()).trim() !== "{}") return reply(400, "invalid_request");
    const headers = { apikey: env.VITE_SUPABASE_ANON_KEY, Authorization: bearer, "Content-Type": "application/json" };
    const auth = await fetch(`${project}/rest/v1/rpc/crm_staff_authorized_v1`, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(4000) });
    if (!auth.ok) return reply(auth.status === 401 || auth.status === 403 ? 403 : 503, "authorization_unavailable");
    if (await auth.json() !== true) return reply(403, "forbidden");
    const result = await recordFormFailure(env, { id: testId, occurred_at: new Date().toISOString(), request_id: null,
      form_kind: "unknown", stage: "configuration", error_code: "controlled_delivery_test", http_status: 503 });
    if (result !== "not_sent") {
      await fetch(`${project}/rest/v1/rpc/crm_resolve_form_error_v1`, { method: "POST", headers, body: JSON.stringify({ p_id: testId }), signal: AbortSignal.timeout(4000) });
    }
    return reply(result === "accepted" ? 200 : result === "not_sent" ? 409 : 503,
      result === "accepted" ? "accepted" : result === "not_sent" ? "already_attempted_or_rate_limited" : "delivery_unconfirmed");
  } catch { return reply(503, "result_unconfirmed_do_not_resend"); }
}
export function onRequest() { return reply(405, "method_not_allowed"); }
