type Env = {
  VITE_SUPABASE_ANON_KEY?: string;
  CLOVER_ORDERS_ACCESS_TOKEN?: string;
  CLOVER_MERCHANT_ID?: string;
  CLOVER_ONLINE_ORDER_TYPE_IDS?: string;
};
type Context = { request: Request; env: Env };

const SUPABASE_URL = "https://khgczybubufouraqyrcj.supabase.co";
const headers = { "Content-Type": "application/json", "Cache-Control": "private, no-store" };
const idPattern = /^[A-Z0-9]{8,32}$/i;

function reply(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ code, ...extra }), { status, headers });
}

export async function onRequestGet({ request, env }: Context): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return reply(403, "forbidden");
  const bearer = request.headers.get("Authorization") || "";
  if (!/^Bearer [A-Za-z0-9_.-]{20,4096}$/.test(bearer)) return reply(401, "unauthorized");
  if (!env.VITE_SUPABASE_ANON_KEY) return reply(503, "authorization_unavailable");

  // Only the existing CRM staff allowlist may read merchant order data.
  try {
    const check = await fetch(`${SUPABASE_URL}/rest/v1/rpc/crm_staff_authorized_v1`, {
      method: "POST", signal: AbortSignal.timeout(5000),
      headers: { apikey: env.VITE_SUPABASE_ANON_KEY, Authorization: bearer, "Content-Type": "application/json" },
      body: "{}",
    });
    if (!check.ok) return reply(check.status === 401 || check.status === 403 ? 403 : 503,
      check.status === 401 || check.status === 403 ? "forbidden" : "authorization_unavailable");
    if (await check.json() !== true) return reply(403, "forbidden");
  } catch { return reply(503, "authorization_unavailable"); }

  const merchant = env.CLOVER_MERCHANT_ID?.trim() || "";
  const types = (env.CLOVER_ONLINE_ORDER_TYPE_IDS || "").split(",").map(id => id.trim()).filter(Boolean);
  if (!env.CLOVER_ORDERS_ACCESS_TOKEN || !idPattern.test(merchant) || !types.length
    || types.length > 4 || types.some(id => !idPattern.test(id))) return reply(503, "connection_unavailable");

  try {
    const now = Date.now();
    const since = now - 7 * 24 * 60 * 60 * 1000;
    const results = await Promise.all(types.map(async (typeId) => {
      const url = new URL(`https://api.clover.com/v3/merchants/${merchant}/orders`);
      url.searchParams.append("filter", `createdTime>=${since}`);
      url.searchParams.append("filter", `createdTime<=${now}`);
      url.searchParams.append("filter", `orderType=${typeId}`);
      url.searchParams.set("expand", "orderType");
      url.searchParams.set("orderBy", "createdTime DESC");
      url.searchParams.set("limit", "100");
      const response = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${env.CLOVER_ORDERS_ACCESS_TOKEN}`, Accept: "application/json", "User-Agent": "NazarCRM/1.0" },
      });
      if (!response.ok) throw new Error("Clover unavailable");
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !Array.isArray((body as { elements?: unknown }).elements)) throw new Error("Invalid Clover response");
      const elements = (body as { elements: unknown[] }).elements;
      return elements.map(value => {
        if (!value || typeof value !== "object") throw new Error("Invalid order");
        const order = value as Record<string, unknown>;
        const kind = order.orderType as { id?: unknown; label?: unknown; name?: unknown } | undefined;
        if (kind?.id !== typeId || typeof order.id !== "string" || !idPattern.test(order.id)
          || typeof order.createdTime !== "number" || !Number.isFinite(order.createdTime)) throw new Error("Unexpected order type");
        return {
          id: order.id,
          cloverUrl: `https://www.clover.com/orders/m/${merchant}/orders/${order.id}`,
          createdAt: new Date(order.createdTime).toISOString(),
          orderType: typeof kind.name === "string" ? kind.name : typeof kind.label === "string" ? kind.label : "Online order",
          totalCents: typeof order.total === "number" && Number.isSafeInteger(order.total) ? order.total : null,
        };
      });
    }));
    const unique = new Map(results.flat().map(order => [order.id, order]));
    const allOrders = [...unique.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const orders = allOrders.slice(0, 50);
    return reply(200, "ok", { orders, periodDays: 7, truncated: allOrders.length > 50 || results.some(group => group.length === 100), checkedAt: new Date().toISOString() });
  } catch { return reply(503, "provider_unavailable"); }
}

export function onRequest(): Response { return reply(405, "method_not_allowed"); }
