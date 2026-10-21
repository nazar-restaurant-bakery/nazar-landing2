import { CollectorError, allowedUrl, budget, count, failure, metric, notConnected, object, periods, providerJson, type CollectorContext, type CollectorResult } from "./collectors.ts";
import { parseCents } from "./clover_csv.ts";
// Read-only Marketing API adapter. Never requests ads_management or changes status.
// https://developers.facebook.com/docs/marketing-api/insights/
export async function collect(ctx: CollectorContext): Promise<CollectorResult> {
  const token = ctx.env.META_ACCESS_TOKEN, account = ctx.env.META_AD_ACCOUNT_ID, version = ctx.env.META_API_VERSION;
  if (!token?.trim() || !account?.trim() || !version?.trim()) return notConnected("meta", "Meta read-only token, Nazar ad account ve API sürümü bekleniyor.");
  if (!/^\d{5,30}$/.test(account) || !/^v\d{1,2}\.0$/.test(version)) return notConnected("meta", "Meta account veya API sürümü geçersiz.");
  const start = budget(ctx).remaining, host = "graph.facebook.com", prefix = "/" + version + "/act_" + account;
  const headers = { Authorization: "Bearer " + token };
  try {
    const identity = await providerJson(ctx, "https://" + host + prefix + "?fields=account_id,currency,timezone_name", host, { headers }, prefix);
    if (!object(identity) || identity.account_id !== account || identity.currency !== "USD") throw new CollectorError("meta_account_mismatch");
    if (identity.timezone_name !== "America/New_York") throw new CollectorError("meta_timezone_mismatch");
    const period = periods(ctx), range = encodeURIComponent(JSON.stringify({ since: period.yesterday, until: period.yesterday }));
    const data = await providerJson(ctx, "https://" + host + prefix + "/insights?fields=spend,reach,impressions,clicks,actions,date_start,date_stop&level=account&time_range=" + range, host, { headers }, prefix + "/insights");
    if (!object(data) || !Array.isArray(data.data) || data.data.length > 1 || (object(data.paging) && data.paging.next)) throw new CollectorError("meta_incomplete_insights");
    let spend: number | null = null, reach: number | null = null, impressions: number | null = null, clicks: number | null = null, results: number | null = null;
    const row = data.data[0];
    if (row !== undefined) {
      if (!object(row) || typeof row.spend !== "string" || count(row.reach) === null || count(row.impressions) === null || count(row.clicks) === null || row.date_start !== period.yesterday || row.date_stop !== period.yesterday) throw new CollectorError("meta_invalid_insights");
      const cents = parseCents(row.spend); spend = cents === null ? null : cents / 100; reach = count(row.reach); impressions = count(row.impressions); clicks = count(row.clicks); if (cents === null || cents < 0) throw new CollectorError("meta_invalid_insights");
      const actionType = ctx.env.META_RESULT_ACTION_TYPE;
      if (actionType && Array.isArray(row.actions)) {
        const matches = row.actions.filter(item => object(item) && item.action_type === actionType);
        if (matches.length === 1 && object(matches[0])) results = count(matches[0].value);
      }
    }
    let url = "https://" + host + prefix + "/campaigns?fields=id,effective_status&limit=100";
    const campaigns = new Set<string>(), visited = new Set<string>();
    while (url) {
      if (visited.has(url)) throw new CollectorError("meta_pagination_loop"); visited.add(url);
      if (allowedUrl(url, host).pathname !== prefix + "/campaigns") throw new CollectorError("meta_pagination_scope");
      const page = await providerJson(ctx, url, host, { headers });
      if (!object(page) || !Array.isArray(page.data) || !page.data.every(item => object(item) && typeof item.id === "string" && typeof item.effective_status === "string")) throw new CollectorError("meta_invalid_campaigns");
      for (const campaign of page.data) if (!["DELETED", "ARCHIVED"].includes(campaign.effective_status)) campaigns.add(campaign.id);
      const next = object(page.paging) ? page.paging.next : null;
      if (next !== null && next !== undefined && typeof next !== "string") throw new CollectorError("meta_invalid_pagination");
      url = typeof next === "string" ? next : "";
    }
    return { source: "meta", status: "connected", metrics: [metric(ctx, "meta", "spend_yesterday", spend, null, period.yesterday, period.yesterday), metric(ctx, "meta", "reach_yesterday", reach, null, period.yesterday, period.yesterday), metric(ctx, "meta", "impressions_yesterday", impressions, null, period.yesterday, period.yesterday), metric(ctx, "meta", "clicks_yesterday", clicks, null, period.yesterday, period.yesterday), metric(ctx, "meta", "results_yesterday", results, ctx.env.META_RESULT_ACTION_TYPE ? (results === null ? "Seçilen sonuç olayı raporda doğrulanamadı." : "Seçilen Meta sonuç olayı; doğrulanmış satış değildir.") : "Sonuç olayı seçilmedi.", period.yesterday, period.yesterday), metric(ctx, "meta", "campaigns", campaigns.size)], requestsUsed: start - budget(ctx).remaining, capabilities: [] };
  } catch (error) { return failure(ctx, "meta", start, error); }
}
