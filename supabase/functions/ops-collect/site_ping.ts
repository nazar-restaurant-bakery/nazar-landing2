import { budget, failure, metric, providerResponse, type CollectorContext, type CollectorResult } from "./collectors.ts";

export async function collect(ctx: CollectorContext): Promise<CollectorResult> {
  const start = budget(ctx).remaining; const began = performance.now();
  try {
    // Fixed canonical URL, no caller-controlled target and no redirect following.
    const response = await providerResponse(ctx, "https://www.nazarrestaurantandbakery.com/", "www.nazarrestaurantandbakery.com", { method: "GET", headers: { Accept: "text/html" } }, "/");
    const elapsed = Math.max(0, Math.round(performance.now() - began));
    const isUp = response.status >= 200 && response.status < 300;
    await response.body?.cancel();
    return { source: "site", status: isUp ? "connected" : "error", metrics: [metric(ctx, "site", "is_up", isUp ? 1 : 0), metric(ctx, "site", "http_status", response.status), metric(ctx, "site", "response_ms", elapsed)],
      ...(isUp ? {} : { error: "site_http_" + response.status }), requestsUsed: start - budget(ctx).remaining };
  } catch (error) { return failure(ctx, "site", start, error); }
}
