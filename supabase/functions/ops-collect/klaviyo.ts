import { CollectorError, allowedUrl, budget, failure, metric, notConnected, nyDate, object, previousAt, providerJson, sanitizeText, type CollectorContext, type CollectorResult } from "./collectors.ts";
// Read-only APIs; no client subscription, suppression change or campaign send.
// https://developers.klaviyo.com/en/reference/get_accounts
// https://developers.klaviyo.com/en/reference/get_profiles_for_list
// https://developers.klaviyo.com/en/reference/query_campaign_values
const accountId = "W6Kr7z", listId = "UeJynm", host = "a.klaviyo.com";
const testName = /\b(?:internal\s+test|test\s+only|crm\s+test|verify)\b|^nazar\s+(?:vip|website|catering)?\s*test\b/i;
function isTest(attributes: Record<string, unknown>) {
  const email = typeof attributes.email === "string" ? attributes.email.trim().toLowerCase() : "";
  const props = object(attributes.properties) ? attributes.properties : {};
  const name = [attributes.first_name, attributes.last_name].filter(v => typeof v === "string").join(" ");
  return props.is_test === true || props.internal_test === true || /@(?:[^@]+\.)?example\.com$|@[^@]+\.invalid$/.test(email)
    || /\+(?:viptest|test|verify)[^@]*@/.test(email) || testName.test(name);
}
function eligible(profile: unknown): boolean {
  if (!object(profile) || typeof profile.id !== "string" || !object(profile.attributes)) throw new CollectorError("klaviyo_invalid_profile");
  const attributes = profile.attributes; if (isTest(attributes)) return false;
  if (typeof attributes.email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(attributes.email)) throw new CollectorError("klaviyo_invalid_email_profile");
  const subscriptions = attributes.subscriptions;
  if (!object(subscriptions) || !object(subscriptions.email) || !object(subscriptions.email.marketing)) throw new CollectorError("klaviyo_missing_consent_fields");
  const marketing = subscriptions.email.marketing;
  if (typeof marketing.consent !== "string" || typeof marketing.can_receive_email_marketing !== "boolean" || !Array.isArray(marketing.suppression) || !Array.isArray(marketing.list_suppressions)) throw new CollectorError("klaviyo_missing_consent_fields");
  if (marketing.list_suppressions.some(item => !object(item) || typeof item.list_id !== "string")) throw new CollectorError("klaviyo_missing_consent_fields");
  return marketing.consent === "SUBSCRIBED" && marketing.can_receive_email_marketing && marketing.suppression.length === 0
    && !marketing.list_suppressions.some(item => !object(item) || item.list_id === listId);
}
export async function collect(ctx: CollectorContext): Promise<CollectorResult> {
  const key = ctx.env.KLAVIYO_OPS_READ_KEY;
  if (!key) return notConnected("klaviyo", "Nazar Klaviyo read-only API key bekleniyor.");
  const start = budget(ctx).remaining;
  // The supported July revision matches the existing status/send_time campaign reader.
  const headers = { Authorization: "Klaviyo-API-Key " + key, accept: "application/vnd.api+json", revision: "2026-07-15" };
  try {
    const identity = await providerJson(ctx, "https://a.klaviyo.com/api/accounts/?fields[account]=timezone,preferred_currency", host, { headers }, "/api/accounts");
    if (!object(identity) || !Array.isArray(identity.data) || identity.data.length !== 1 || !object(identity.data[0]) || identity.data[0].id !== accountId) throw new CollectorError("klaviyo_account_mismatch");
    async function all(url: string): Promise<unknown[]> {
      const expected = new URL(url).pathname.replace(/\/$/, ""); const rows: unknown[] = []; const visited = new Set<string>();
      while (url) {
        if (visited.has(url)) throw new CollectorError("klaviyo_pagination_loop"); visited.add(url);
        const parsed = allowedUrl(url, host);
        if (parsed.pathname.replace(/\/$/, "") !== expected) throw new CollectorError("klaviyo_pagination_scope");
        const data = await providerJson(ctx, parsed.href, host, { headers });
        if (!object(data) || !Array.isArray(data.data) || !object(data.links) || !["string", "object"].includes(typeof data.links.next)
          || (data.links.next !== null && typeof data.links.next !== "string")) throw new CollectorError("klaviyo_invalid_page");
        rows.push(...data.data); if (rows.length > 3000) throw new CollectorError("klaviyo_pagination_incomplete");
        url = typeof data.links.next === "string" ? data.links.next : "";
      }
      return rows;
    }
    const profiles = await all("https://a.klaviyo.com/api/lists/" + listId + "/profiles/?additional-fields[profile]=subscriptions&fields[profile]=email,first_name,last_name,properties,subscriptions&page[size]=100");
    const unique = new Map<string, unknown>();
    for (const profile of profiles) {
      if (!object(profile) || typeof profile.id !== "string") throw new CollectorError("klaviyo_invalid_profile");
      if (unique.has(profile.id) && JSON.stringify(unique.get(profile.id)) !== JSON.stringify(profile)) throw new CollectorError("klaviyo_conflicting_profile");
      unique.set(profile.id, profile);
    }
    const subscribers = [...unique.values()].filter(eligible).length;
    const campaigns = await all("https://a.klaviyo.com/api/campaigns/?fields[campaign]=name,status,send_time,created_at&page[size]=100&filter=and(equals(messages.channel,%22email%22),equals(archived,false))");
    const sent = campaigns.filter(campaign => object(campaign) && typeof campaign.id === "string" && object(campaign.attributes)
      && typeof campaign.attributes.name === "string" && !testName.test(campaign.attributes.name) && !/technical|authentication test|delivery and unsubscribe/i.test(campaign.attributes.name)
      && String(campaign.attributes.status).toLowerCase() === "sent" && typeof campaign.attributes.send_time === "string" && Number.isFinite(Date.parse(campaign.attributes.send_time)))
      .sort((a, b) => Date.parse((b as { attributes: { send_time: string } }).attributes.send_time) - Date.parse((a as { attributes: { send_time: string } }).attributes.send_time));
    const last = sent[0] as { id: string; attributes: { name: string; send_time: string } } | undefined;
    let openRate: number | null = null, clickRate: number | null = null;
    const conversionMetric = ctx.env.KLAVIYO_CONVERSION_METRIC_ID;
    if (last && conversionMetric) {
      if (!/^[A-Za-z0-9]{1,100}$/.test(conversionMetric) || !/^[A-Za-z0-9]{1,100}$/.test(last.id)) throw new CollectorError("klaviyo_invalid_metric_id");
      const data = await providerJson(ctx, "https://a.klaviyo.com/api/campaign-values-reports/", host, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ data: { type: "campaign-values-report", attributes: { timeframe: { key: "last_12_months" }, conversion_metric_id: conversionMetric,
          filter: 'equals(campaign_id,"' + last.id + '")', statistics: ["open_rate", "click_rate"], group_by: ["campaign_id", "campaign_message_id", "send_channel"] } } }),
      }, "/api/campaign-values-reports");
      if (!object(data) || !object(data.data) || !object(data.data.attributes) || !Array.isArray(data.data.attributes.results)) throw new CollectorError("klaviyo_invalid_report");
      const results = data.data.attributes.results.filter(row => object(row) && object(row.groupings) && row.groupings.campaign_id === last.id && row.groupings.send_channel === "email");
      // Never average multiple message/variation rates without their denominators.
      if (results.length === 1 && object(results[0]) && object(results[0].statistics)) {
        const stats = results[0].statistics;
        if (typeof stats.open_rate === "number" && stats.open_rate >= 0 && stats.open_rate <= 1) openRate = stats.open_rate * 100;
        if (typeof stats.click_rate === "number" && stats.click_rate >= 0 && stats.click_rate <= 1) clickRate = stats.click_rate * 100;
      }
    }
    const now = ctx.now ?? new Date(); const prior = previousAt(ctx, "klaviyo", "subscribers", new Date(now.getTime() - 7 * 86_400_000));
    return { source: "klaviyo", status: "connected", metrics: [metric(ctx, "klaviyo", "subscribers", subscribers, "Klaviyo SUBSCRIBED ve suppression yok; testler hariç. Bu sayım gönderim yetkisi vermez."),
      metric(ctx, "klaviyo", "net_growth_7d", prior ? subscribers - prior.value_num! : null,
        prior ? "Net uygun abone snapshot farkı; başlangıç " + prior.collected_at + "; hedef 7 gün, en çok 24 saat tolerans." : "7 günlük başlangıç snapshot'ı yok.",
        prior ? nyDate(prior.collected_at) : null, nyDate(now)),
      metric(ctx, "klaviyo", "last_campaign_name", null, last ? sanitizeText(last.attributes.name) : "Doğrulanmış gerçek gönderilmiş campaign yok."),
      metric(ctx, "klaviyo", "last_campaign_open_rate", openRate, "Yüzde puanı; çoklu mesaj veya eksik report varsa bilinmiyor."),
      metric(ctx, "klaviyo", "last_campaign_click_rate", clickRate, "Yüzde puanı; çoklu mesaj veya eksik report varsa bilinmiyor.")],
      note: "Yalnız toplu sonuç; profil/iletişim verisi saklanmaz. Eksik pagination'da sayı üretilmez.", requestsUsed: start - budget(ctx).remaining, capabilities: [] };
  } catch (error) { return failure(ctx, "klaviyo", start, error); }
}
