// Google Ads API read for market-ads: campaign x day rows only.
// OAuth refresh and the v26 searchStream call follow ops-collect/google_ads.ts (copied, not
// changed there). Developer tokens were sunset on 2026-09-09; access belongs to the OAuth project.
// https://developers.google.com/google-ads/api/rest/common/search
type Env = Record<string, string | undefined>;
export const ADS_CUSTOMER = "6478477284";
export const ADS_API = "https://googleads.googleapis.com/v26/customers/";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
// OAuth token + account check (currency, time zone) + campaign report.
export const PLANNED_CALLS = 3;
const MAX_BODY = 5_000_000;

export class AdsError extends Error { code: string; constructor(code: string) { super(code); this.code = code; } }
export class CapReached extends Error {}
export type AdsRow = { campaign_id: string; campaign_name: string | null; report_date: string; impressions: number;
  clicks: number; spend: number; conversions: number };

// OAuth refused or revoked: the alert asks for reconnecting the account.
export const reconnectNeeded = (code: string) => code.startsWith("oauth_") || code === "ads_unauthenticated" || code === "ads_permission_denied";

export function reportQuery(start: string, end: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new AdsError("invalid_period");
  return "SELECT campaign.id, campaign.name, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, "
    + "metrics.conversions FROM campaign WHERE segments.date BETWEEN '" + start + "' AND '" + end + "'";
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
// int64 arrives as a string; proto3 JSON leaves out zero values, so a missing metric in a returned row is 0.
function int(value: unknown): number | null {
  if (value === undefined) return 0;
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function real(value: unknown): number | null {
  if (value === undefined) return 0;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// Only returned rows are kept; a day without a row stays absent (no invented zeros).
export function parseReport(results: unknown[], start: string, end: string): AdsRow[] {
  const rows: AdsRow[] = [], seen = new Set<string>();
  for (const item of results) {
    if (!object(item) || !object(item.campaign) || !object(item.segments)) throw new AdsError("ads_invalid_payload");
    const metrics = object(item.metrics) ? item.metrics : {};
    const id = item.campaign.id, date = item.segments.date, name = item.campaign.name;
    const impressions = int(metrics.impressions), clicks = int(metrics.clicks), micros = int(metrics.costMicros),
      conversions = real(metrics.conversions);
    if (typeof id !== "string" || !/^\d{1,20}$/.test(id) || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || date < start || date > end || impressions === null || clicks === null || micros === null || conversions === null)
      throw new AdsError("ads_invalid_payload");
    if (seen.has(id + "|" + date)) throw new AdsError("ads_duplicate_row");
    seen.add(id + "|" + date);
    rows.push({ campaign_id: id, campaign_name: typeof name === "string" && name.trim() && name.length <= 300 ? name.trim() : null,
      report_date: date, impressions, clicks, spend: micros / 1_000_000, conversions });
  }
  return rows;
}

// Reads the report with at most maxCalls provider requests. Returns rows and the calls used.
export async function readAds(env: Env, fetcher: typeof fetch, period: { start: string; end: string }, maxCalls: number,
  counter: { calls: number }): Promise<AdsRow[]> {
  const call = async (url: string, init: RequestInit): Promise<Response> => {
    if (counter.calls >= maxCalls) throw new CapReached();
    counter.calls++;
    try { return await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20000) }); }
    catch { throw new AdsError(url === TOKEN_URL ? "oauth_request_failed" : "ads_request_failed"); }
  };
  const json = async (response: Response, prefix: "oauth" | "ads"): Promise<unknown> => {
    if (Number(response.headers.get("content-length") ?? 0) > MAX_BODY) throw new AdsError(prefix + "_response_too_large");
    let text: string;
    try { text = await response.text(); } catch { throw new AdsError(prefix + "_body_error"); }
    if (text.length > MAX_BODY) throw new AdsError(prefix + "_response_too_large");
    try { return JSON.parse(text); } catch { throw new AdsError(prefix + "_invalid_json"); }
  };

  const token = await call(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_ADS_CLIENT_ID!, client_secret: env.GOOGLE_ADS_CLIENT_SECRET!,
      refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN!, grant_type: "refresh_token" }) });
  if (!token.ok) {
    if (token.status === 429) throw new AdsError("oauth_rate_limited");
    if (token.status !== 400 && token.status !== 401) throw new AdsError("oauth_http_" + token.status);
    let error: unknown = null;
    try { const body = await token.json() as { error?: unknown }; error = body?.error; } catch { /* code below */ }
    throw new AdsError(error === "invalid_grant" ? "oauth_invalid_grant" : error === "invalid_client" ? "oauth_invalid_client"
      : error === "unauthorized_client" ? "oauth_unauthorized_client" : "oauth_rejected");
  }
  const tokenBody = await json(token, "oauth");
  if (!object(tokenBody) || typeof tokenBody.access_token !== "string" || !tokenBody.access_token) throw new AdsError("oauth_invalid_response");

  const headers: Record<string, string> = { Authorization: "Bearer " + tokenBody.access_token, "Content-Type": "application/json" };
  if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) {
    const login = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID.replaceAll("-", "");
    if (!/^\d{10}$/.test(login)) throw new AdsError("invalid_ads_login_id");
    headers["login-customer-id"] = login;
  }
  const query = async (gaql: string): Promise<unknown[]> => {
    const response = await call(ADS_API + ADS_CUSTOMER + "/googleAds:searchStream", { method: "POST", headers, body: JSON.stringify({ query: gaql }) });
    if (!response.ok) throw new AdsError(response.status === 401 ? "ads_unauthenticated" : response.status === 403 ? "ads_permission_denied"
      : response.status === 429 ? "ads_rate_limited" : "ads_http_" + response.status);
    const data = await json(response, "ads");
    if (!Array.isArray(data) || !data.every(item => object(item) && (item.results === undefined || Array.isArray(item.results))))
      throw new AdsError("ads_invalid_payload");
    return data.flatMap(item => (item as { results?: unknown[] }).results ?? []);
  };

  // Account check first: rows are written only for the Nazar account in USD and America/New_York.
  const identity = await query("SELECT customer.id, customer.time_zone, customer.currency_code FROM customer");
  const customer = identity.length === 1 && object(identity[0]) && object(identity[0].customer) ? identity[0].customer : null;
  if (!customer || String(customer.id) !== ADS_CUSTOMER) throw new AdsError("ads_account_mismatch");
  if (customer.currencyCode !== "USD") throw new AdsError("ads_currency_mismatch");
  if (customer.timeZone !== "America/New_York") throw new AdsError("ads_timezone_mismatch");
  return parseReport(await query(reportQuery(period.start, period.end)), period.start, period.end);
}
