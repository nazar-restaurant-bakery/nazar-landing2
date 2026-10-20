import { requiresIsolatedEnvironment } from "../../src/lib/deploymentEnvironment.ts";
type Context = { request: Request; env: Record<string, string | undefined>; next(): Promise<Response> };
// Existing staff routes contain production-specific provider/RPC targets. Only
// the exact K5 route has independent isolated configuration and staff guards.
export async function onRequest(context: Context): Promise<Response> {
  const url = new URL(context.request.url);
  if (url.pathname.startsWith("/api/staff/") && !["/api/staff/profile-sync", "/api/staff/clover-order-pull"].includes(url.pathname)
    && requiresIsolatedEnvironment(url.hostname, context.env.APP_ENV)) {
    return Response.json({ code: "isolated_provider_route_disabled" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
  return context.next();
}
