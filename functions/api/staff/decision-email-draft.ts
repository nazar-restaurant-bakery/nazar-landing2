type Env = { VITE_SUPABASE_ANON_KEY?: string };
type Context = { request: Request; env: Env };
type Decision = { id: string; request_id: string; question: string; recorded_at: string | null };

const SUPABASE_URL = "https://khgczybubufouraqyrcj.supabase.co";
const headers = { "Cache-Control": "private, no-store", "Content-Type": "application/json" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function reply(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ code, ...extra }), { status, headers });
}

export async function onRequestPost({ request, env }: Context): Promise<Response> {
  if (request.headers.get("Origin") !== new URL(request.url).origin) return reply(403, "forbidden");
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return reply(415, "invalid_content_type");
  const bearer = request.headers.get("Authorization") || "";
  if (!/^Bearer [A-Za-z0-9_.-]{20,4096}$/.test(bearer)) return reply(401, "unauthorized");
  if (!env.VITE_SUPABASE_ANON_KEY) return reply(503, "connection_unavailable");

  let decisionId: string;
  try {
    if (Number(request.headers.get("Content-Length") || 0) > 256) return reply(413, "too_large");
    const raw = await request.text();
    if (raw.length > 256) return reply(413, "too_large");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reply(400, "invalid_decision");
    const value = (parsed as Record<string, unknown>).decisionId;
    if (typeof value !== "string" || !uuid.test(value)) return reply(400, "invalid_decision");
    decisionId = value;
  } catch { return reply(400, "invalid_decision"); }

  try {
    const rpcHeaders = { apikey: env.VITE_SUPABASE_ANON_KEY, Authorization: bearer, "Content-Type": "application/json" };
    const auth = await fetch(`${SUPABASE_URL}/rest/v1/rpc/crm_staff_authorized_v1`, {
      method: "POST", headers: rpcHeaders, body: "{}",
    });
    if (!auth.ok) return reply(auth.status === 401 || auth.status === 403 ? 403 : 503, "authorization_unavailable");
    if (await auth.json() !== true) return reply(403, "forbidden");

    const result = await fetch(`${SUPABASE_URL}/rest/v1/rpc/crm_catering_decisions_v1`, {
      method: "POST", headers: rpcHeaders, body: "{}",
    });
    if (!result.ok) return reply(503, "decision_unavailable");
    const data = await result.json() as { items?: Decision[] };
    const decision = data.items?.find((item) => item.id === decisionId && !item.recorded_at);
    if (!decision) return reply(404, "decision_not_found");

    const subject = `Nazar catering price/menu decision — ${decision.request_id.slice(0, 8)}`;
    const body = [
      "Yücel,", "", "Please review this catering request and decide the final menu and price:",
      decision.question.slice(0, 1000), "",
      `Request ID: ${decision.request_id}`, "Open the request in the private CRM: https://www.nazarrestaurantandbakery.com/staff", "",
      "Please reply all with your decision and sign your name. Talip is copied for visibility.",
    ].join("\n");
    return reply(200, "ok", { to: "ctnazarbakery@gmail.com", cc: "talipbalik@gmail.com", subject, body });
  } catch { return reply(503, "connection_unavailable"); }
}

export function onRequest(): Response { return reply(405, "method_not_allowed"); }
