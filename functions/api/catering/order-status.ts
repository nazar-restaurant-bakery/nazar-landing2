type Env = {
  CATERING_CHECKOUT_ENABLED?: string;
  CLOVER_ENVIRONMENT?: string;
  CATERING_SANDBOX_SUPABASE_URL?: string;
  SITE_PRODUCTION_SUPABASE_URL?: string;
  SITE_BUSINESS_ID?: string;
  SUPABASE_SECRET_KEY?: string;
};
type Context = { request: Request; env: Env };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reply(status: number, value: Record<string, unknown>): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export async function onRequestPost({ request, env }: Context): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin) return reply(403, { code: "forbidden" });
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return reply(415, { code: "invalid_content_type" });
  }
  if (env.CATERING_CHECKOUT_ENABLED !== "true" ||
      !UUID_RE.test(env.SITE_BUSINESS_ID ?? "") ||
      !env.SUPABASE_SECRET_KEY?.startsWith("sb_secret_")) {
    return reply(503, { code: "status_unavailable" });
  }
  let input: { orderId?: unknown; requestId?: unknown };
  try {
    const body = await request.text();
    if (body.length > 512) return reply(413, { code: "too_large" });
    input = JSON.parse(body) as { orderId?: unknown; requestId?: unknown };
  } catch { return reply(400, { code: "invalid_reference" }); }
  const orderId = input?.orderId;
  const requestId = input?.requestId;
  if (typeof orderId !== "string" || typeof requestId !== "string" ||
      !UUID_RE.test(orderId) || !UUID_RE.test(requestId)) {
    return reply(400, { code: "invalid_reference" });
  }
  const databaseUrl = env.CLOVER_ENVIRONMENT === "sandbox"
    ? env.CATERING_SANDBOX_SUPABASE_URL : env.SITE_PRODUCTION_SUPABASE_URL;
  if (!databaseUrl || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(databaseUrl) ||
      (env.CLOVER_ENVIRONMENT === "sandbox" &&
       databaseUrl === env.SITE_PRODUCTION_SUPABASE_URL)) {
    return reply(503, { code: "status_unavailable" });
  }
  try {
    const result = await fetch(`${databaseUrl}/rest/v1/rpc/site_order_customer_status_v1`, {
      method: "POST", headers: { apikey: env.SUPABASE_SECRET_KEY!,
        "Content-Type": "application/json" },
      body: JSON.stringify({ p_business_id: env.SITE_BUSINESS_ID,
        p_site_order_id: orderId, p_request_id: requestId }),
    });
    if (!result.ok) return reply(503, { code: "status_unavailable" });
    const state = await result.json() as { status?: string; orderId?: string;
      requestedAt?: string; totalCents?: number; emailStatus?: string } | null;
    if (!state || state.orderId !== orderId) return reply(404, { code: "not_found" });
    return reply(200, { code: "order_status", status: state.status,
      orderId: state.orderId, requestedAt: state.requestedAt,
      totalCents: state.totalCents, emailStatus: state.emailStatus });
  } catch { return reply(503, { code: "status_unavailable" }); }
}

export function onRequest(): Response { return reply(405, { code: "method_not_allowed" }); }
