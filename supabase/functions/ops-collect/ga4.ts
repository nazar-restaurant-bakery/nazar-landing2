import { CollectorError, budget, count, failure, googleAccessToken, metric, notConnected, object, periods, providerJson, type CollectorContext, type CollectorResult } from "./collectors.ts";
// https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart
export async function collect(ctx: CollectorContext): Promise<CollectorResult> {
  if (!ctx.env.GA4_ACCESS_TOKEN && !ctx.env.GA4_SERVICE_ACCOUNT_JSON) return notConnected("ga4", "GA4 Data API erişimi bekleniyor.");
  if (ctx.env.GA4_PROPERTY_ID && ctx.env.GA4_PROPERTY_ID !== "551076037") return notConnected("ga4", "Yalnız Nazar GA4 mülkü kullanılabilir.");
  const start = budget(ctx).remaining;
  try {
    const token = await googleAccessToken(ctx, "GA4"); if (!token) return notConnected("ga4", "GA4 credentials bekleniyor.");
    const period = periods(ctx);
    const data = await providerJson(ctx, "https://analyticsdata.googleapis.com/v1beta/properties/551076037:runReport", "analyticsdata.googleapis.com", {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ dateRanges: [{ startDate: period.sevenStart, endDate: period.sevenEnd }], metrics: [{ name: "sessions" }], limit: 1 }),
    }, "/v1beta/properties/551076037:");
    if (!object(data) || !object(data.metadata) || data.metadata.timeZone !== "America/New_York" || !Array.isArray(data.metricHeaders)
      || !object(data.metricHeaders[0]) || data.metricHeaders[0].name !== "sessions") throw new CollectorError("ga4_invalid_scope_or_payload");
    const rows = data.rows; let visits: number | null = null;
    if ((rows === undefined || (Array.isArray(rows) && rows.length === 0)) && data.rowCount === 0) visits = 0;
    else if (Array.isArray(rows) && rows.length === 1 && object(rows[0]) && Array.isArray(rows[0].metricValues) && object(rows[0].metricValues[0])) visits = count(rows[0].metricValues[0].value);
    if (visits === null) throw new CollectorError("ga4_incomplete_report");
    return { source: "ga4", status: "connected", metrics: [metric(ctx, "ga4", "visits_7d", visits, "GA4 sessions; sipariş veya form başvurusu değildir.", period.sevenStart, period.sevenEnd)], requestsUsed: start - budget(ctx).remaining };
  } catch (error) { return failure(ctx, "ga4", start, error); }
}
