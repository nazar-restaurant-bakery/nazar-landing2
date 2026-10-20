import { CollectorError, budget, count, failure, googleAccessToken, metric, notConnected, object, periods, providerJson, type CollectorContext, type CollectorResult } from "./collectors.ts";
// Read-only GAQL. https://developers.google.com/google-ads/api/rest/common/search
const customer = "6478477284";
export async function collect(ctx: CollectorContext): Promise<CollectorResult> {
  // Developer tokens were sunset on 2026-09-09; access belongs to the OAuth Cloud project.
  // https://developers.google.com/google-ads/api/docs/api-policy/developer-token
  if (![ctx.env.GOOGLE_ADS_CLIENT_ID, ctx.env.GOOGLE_ADS_CLIENT_SECRET, ctx.env.GOOGLE_ADS_REFRESH_TOKEN, ctx.env.GOOGLE_ADS_CUSTOMER_ID].every(value => value?.trim())) return notConnected("google_ads", "Ads OAuth erişimi ve müşteri hesabı bekleniyor.");
  if (ctx.env.GOOGLE_ADS_CUSTOMER_ID!.replaceAll("-", "") !== customer) return notConnected("google_ads", "Yalnız Nazar Google Ads hesabı kullanılabilir.");
  const start = budget(ctx).remaining;
  try {
    const token = await googleAccessToken(ctx, "GOOGLE_ADS"); const period = periods(ctx);
    const headers: Record<string, string> = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    if (ctx.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) { const login = ctx.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replaceAll("-", ""); if (!/^\d{10}$/.test(login)) throw new CollectorError("invalid_ads_login_id"); headers["login-customer-id"] = login; }
    async function query(query: string) {
      const data = await providerJson(ctx, "https://googleads.googleapis.com/v26/customers/" + customer + "/googleAds:searchStream", "googleads.googleapis.com", { method: "POST", headers, body: JSON.stringify({ query }) }, "/v26/customers/" + customer + "/");
      if (!Array.isArray(data) || !data.every(item => object(item) && (item.results === undefined || Array.isArray(item.results)))) throw new CollectorError("ads_invalid_payload");
      return data.flatMap(item => item.results ?? []);
    }
    const identity = await query("SELECT customer.id, customer.time_zone, customer.currency_code FROM customer");
    if (identity.length !== 1 || !object(identity[0]) || !object(identity[0].customer) || String(identity[0].customer.id) !== customer
      || identity[0].customer.timeZone !== "America/New_York" || identity[0].customer.currencyCode !== "USD") throw new CollectorError("ads_account_or_timezone_mismatch");
    const stats = await query("SELECT metrics.cost_micros, metrics.clicks, metrics.conversions FROM customer WHERE segments.date BETWEEN '" + period.sevenStart + "' AND '" + period.sevenEnd + "'");
    const campaigns = await query("SELECT campaign.id, campaign.status FROM campaign WHERE campaign.status != 'REMOVED'");
    if (!campaigns.every(row => object(row) && object(row.campaign) && typeof row.campaign.id === "string" && ["ENABLED", "PAUSED"].includes(String(row.campaign.status)))) throw new CollectorError("ads_invalid_campaigns");
    let spend: number | null = null, clicks: number | null = null, conversions: number | null = null;
    if (stats.length === 1 && object(stats[0]) && object(stats[0].metrics)) {
      const values = stats[0].metrics; const micros = count(values.costMicros); spend = micros === null ? null : micros / 1_000_000;
      clicks = count(values.clicks); conversions = typeof values.conversions === "number" && Number.isFinite(values.conversions) && values.conversions >= 0 ? values.conversions : null;
    }
    if (stats.length > 1 || (stats.length === 1 && [spend, clicks, conversions].some(value => value === null))) throw new CollectorError("ads_incomplete_statistics");
    const unique = new Map(campaigns.map(row => [row.campaign.id, row.campaign.status]));
    return { source: "google_ads", status: "connected", metrics: [metric(ctx, "google_ads", "spend_7d", spend, null, period.sevenStart, period.sevenEnd), metric(ctx, "google_ads", "clicks_7d", clicks, null, period.sevenStart, period.sevenEnd), metric(ctx, "google_ads", "conversions_7d", conversions, "Ads conversion; doğrulanmış sipariş değildir.", period.sevenStart, period.sevenEnd), metric(ctx, "google_ads", "active_campaigns", [...unique.values()].filter(status => status === "ENABLED").length), metric(ctx, "google_ads", "paused_campaigns", [...unique.values()].filter(status => status === "PAUSED").length)], requestsUsed: start - budget(ctx).remaining };
  } catch (error) { return failure(ctx, "google_ads", start, error); }
}
