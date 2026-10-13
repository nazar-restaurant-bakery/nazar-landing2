type Env = { VITE_SUPABASE_ANON_KEY?: string; CLOUDFLARE_EMAIL_SEND_TOKEN?: string };
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
  let send = false;
  try {
    if (Number(request.headers.get("Content-Length") || 0) > 256) return reply(413, "too_large");
    const raw = await request.text();
    if (raw.length > 256) return reply(413, "too_large");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reply(400, "invalid_decision");
    const value = (parsed as Record<string, unknown>).decisionId;
    if (typeof value !== "string" || !uuid.test(value)) return reply(400, "invalid_decision");
    decisionId = value;
    send = (parsed as Record<string, unknown>).send === true;
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

    const tokenResult = await fetch(`${SUPABASE_URL}/rest/v1/rpc/crm_decision_email_token_v1`, {
      method: "POST", headers: rpcHeaders, body: JSON.stringify({ p_decision_id: decisionId }),
    });
    if (!tokenResult.ok) return reply(503, "decision_email_unavailable");
    const token: unknown = await tokenResult.json();
    if (typeof token !== "string" || !uuid.test(token)) return reply(503, "decision_email_unavailable");

    const subject = `Nazar catering decision [NazarDecision:${decisionId}:${token}]`;
    const body = [
      "Yücel,", "", "Please review this catering request and decide the final menu and price:",
      decision.question.slice(0, 1000), "",
      `Request ID: ${decision.request_id}`, "Open the request in the private CRM: https://www.nazarrestaurantandbakery.com/staff", "",
      "Please reply from ctnazarbakery@gmail.com. Above the quoted message, start one line with Decision: followed by the final menu and price. End with a line starting Signed: followed by your name.", "",
      "Your reply goes to the private CRM address and will appear on this request. Talip will see it there.",
    ].join("\n");
    if (!send) return reply(200, "ok", { from: "info@nazarrestaurantandbakery.com", to: "ctnazarbakery@gmail.com", replyTo: "crm-decisions@nazarrestaurantandbakery.com", subject, body });
    if (!env.CLOUDFLARE_EMAIL_SEND_TOKEN) return reply(503, "email_not_configured");
    const sent = await fetch("https://api.cloudflare.com/client/v4/accounts/50a358ead900374fd545df744bd28bef/email/sending/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CLOUDFLARE_EMAIL_SEND_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "info@nazarrestaurantandbakery.com", to: "ctnazarbakery@gmail.com", replyTo: "crm-decisions@nazarrestaurantandbakery.com", subject, text: body }),
    });
    if (!sent.ok || (await sent.json() as { success?: boolean }).success !== true) return reply(503, "email_delivery_failed");
    return reply(200, "sent");
  } catch { return reply(503, "connection_unavailable"); }
}

export function onRequest(): Response { return reply(405, "method_not_allowed"); }
