type Env = {
  VITE_SUPABASE_ANON_KEY?: string;
  KLAVIYO_CRM_READ_KEY?: string;
};
type Context = { request: Request; env: Env };
type Profile = {
  attributes?: {
    subscriptions?: {
      email?: { marketing?: {
        consent?: string;
        can_receive_email_marketing?: boolean;
        suppression?: unknown;
        list_suppressions?: unknown;
      } };
    };
  };
};

const SUPABASE_URL = "https://khgczybubufouraqyrcj.supabase.co";
const VIP_LIST_ID = "UeJynm";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const headers = { "Cache-Control": "private, no-store", "Content-Type": "application/json" };
function reply(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ code, ...extra }), { status, headers });
}

export async function onRequestPost({ request, env }: Context): Promise<Response> {
  const origin = new URL(request.url).origin;
  if (request.headers.get("Origin") !== origin) return reply(403, "forbidden");
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return reply(415, "invalid_content_type");
  }
  const bearer = request.headers.get("Authorization") || "";
  if (!/^Bearer [A-Za-z0-9_.-]{20,4096}$/.test(bearer)) return reply(401, "unauthorized");
  if (!env.VITE_SUPABASE_ANON_KEY || !env.KLAVIYO_CRM_READ_KEY) {
    return reply(503, "connection_unavailable");
  }

  let email: string;
  try {
    if (Number(request.headers.get("Content-Length") || 0) > 1024) return reply(413, "too_large");
    const raw = await request.text();
    if (raw.length > 1024) return reply(413, "too_large");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reply(400, "invalid_email");
    const value = (parsed as Record<string, unknown>).email;
    if (typeof value !== "string" || value.length > 254 || !EMAIL_RE.test(value.trim())) {
      return reply(400, "invalid_email");
    }
    email = value.trim().toLowerCase();
  } catch { return reply(400, "invalid_email"); }

  try {
    const auth = await fetch(`${SUPABASE_URL}/rest/v1/rpc/crm_staff_authorized_v1`, {
      method: "POST",
      headers: { apikey: env.VITE_SUPABASE_ANON_KEY,
        Authorization: bearer, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!auth.ok) return reply(auth.status === 401 || auth.status === 403 ? 403 : 503,
      auth.status === 401 || auth.status === 403 ? "forbidden" : "authorization_unavailable");
    if (await auth.json() !== true) return reply(403, "forbidden");

    const endpoint = new URL(`https://a.klaviyo.com/api/lists/${VIP_LIST_ID}/profiles`);
    endpoint.searchParams.set("filter", `equals(email,"${email}")`);
    endpoint.searchParams.set("additional-fields[profile]", "subscriptions");
    endpoint.searchParams.set("page[size]", "1");
    const result = await fetch(endpoint, { headers: {
      Authorization: `Klaviyo-API-Key ${env.KLAVIYO_CRM_READ_KEY}`,
      Accept: "application/vnd.api+json", revision: "2026-07-15",
    } });
    if (!result.ok) return reply(503, "klaviyo_unavailable");
    const body = await result.json() as { data?: Profile[] };
    const profile = body.data?.[0];
    if (!Array.isArray(body.data)) return reply(503, "klaviyo_unavailable");
    const marketing = profile?.attributes?.subscriptions?.email?.marketing;
    const listSuppressed = Array.isArray(marketing?.list_suppressions)
      ? marketing.list_suppressions.some((entry) => entry && typeof entry === "object" &&
        (entry as { list_id?: string }).list_id === VIP_LIST_ID)
      : false;
    const globalSuppressed = Array.isArray(marketing?.suppression)
      ? marketing.suppression.length > 0 : Boolean(marketing?.suppression);
    const suppressed = globalSuppressed || listSuppressed ||
      (marketing?.consent === "SUBSCRIBED" && marketing.can_receive_email_marketing === false);
    const status = !profile ? "not_on_list" : suppressed ? "suppressed"
      : marketing?.consent === "SUBSCRIBED" ? "confirmed"
      : marketing?.consent === "UNSUBSCRIBED" ? "unsubscribed" : "pending";
    return reply(200, "ok", { status, checkedAt: new Date().toISOString() });
  } catch { return reply(503, "connection_unavailable"); }
}

export function onRequest(): Response { return reply(405, "method_not_allowed"); }
