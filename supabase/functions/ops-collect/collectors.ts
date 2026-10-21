// Server-only collector contracts. No keys, provider bodies, PII or arbitrary URLs
// are returned to the browser. Collectors never schedule themselves or send mail.
export type OpsSource = "clover" | "klaviyo" | "google_ads" | "meta" | "site" | "ga4" | "reviews" | "scheduler" | "supabase";
export type MetricSnapshot = {
  source: OpsSource; metric: string; value_num: number | null; value_text: string | null;
  period_start: string | null; period_end: string | null; collected_at: string;
  collector: "edge_fn" | "worker" | "manual_csv" | "manual_entry"; is_test: boolean;
};
export type RequestBudget = { remaining: number };
export type CollectorContext = {
  env: Record<string, string | undefined>; fetch?: typeof fetch; now?: Date;
  businessId?: string; // Trusted server identity; never a browser-selected target.
  budget?: RequestBudget; previous?: MetricSnapshot[];
};
export type CollectorResult = {
  source: OpsSource; status: "connected" | "not_connected" | "error";
  metrics: MetricSnapshot[]; note?: string; error?: string; requestsUsed: number; capabilities?: string[];
};
export class CollectorError extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = "CollectorError"; this.code = code; }
}
export const providerHosts = new Set(["a.klaviyo.com", "places.googleapis.com", "analyticsdata.googleapis.com", "googleads.googleapis.com", "oauth2.googleapis.com", "graph.facebook.com", "api.clover.com", "www.nazarrestaurantandbakery.com"]);
export function sanitizeText(value: unknown, limit = 160): string {
  // eslint-disable-next-line no-control-regex -- Intentionally strip control characters from provider labels.
  return typeof value === "string" ? value.replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[redacted]").replace(/https?:\/\/\S+/gi, "[link]").trim().slice(0, limit) : "";
}
export function budget(ctx: CollectorContext): RequestBudget {
  ctx.budget ??= { remaining: 30 };
  if (!Number.isSafeInteger(ctx.budget.remaining) || ctx.budget.remaining < 0 || ctx.budget.remaining > 30) throw new CollectorError("invalid_budget");
  return ctx.budget;
}
export function allowedUrl(value: string, host: string, pathPrefix?: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new CollectorError("invalid_provider_url"); }
  if (url.protocol !== "https:" || !providerHosts.has(host) || url.hostname !== host || url.port || url.username || url.password
    || (pathPrefix && !url.pathname.startsWith(pathPrefix))) throw new CollectorError("provider_url_rejected");
  return url;
}
export async function providerResponse(ctx: CollectorContext, value: string, host: string, init: RequestInit = {}, pathPrefix?: string): Promise<Response> {
  const url = allowedUrl(value, host, pathPrefix); const cap = budget(ctx);
  if (cap.remaining < 1) throw new CollectorError("request_budget_exhausted");
  cap.remaining--;
  let response: Response;
  try { response = await (ctx.fetch ?? fetch)(url.href, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) }); }
  catch { throw new CollectorError("provider_network_error"); }
  if (response.status >= 300 && response.status < 400) throw new CollectorError("provider_redirect_rejected");
  return response;
}
export async function providerJson(ctx: CollectorContext, value: string, host: string, init: RequestInit = {}, pathPrefix?: string): Promise<unknown> {
  const response = await providerResponse(ctx, value, host, init, pathPrefix);
  if (!response.ok) throw new CollectorError(response.status === 429 ? "provider_rate_limited" : "provider_http_" + response.status);
  if (Number(response.headers.get("content-length") ?? 0) > 2_000_000) throw new CollectorError("provider_response_too_large");
  let text: string;
  try { text = await response.text(); } catch { throw new CollectorError("provider_body_error"); }
  if (text.length > 2_000_000) throw new CollectorError("provider_response_too_large");
  try { return JSON.parse(text); } catch { throw new CollectorError("provider_invalid_json"); }
}
export const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
export function count(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
export function metric(ctx: CollectorContext, source: OpsSource, key: string, value: number | null, text: string | null = null, start: string | null = null, end: string | null = null): MetricSnapshot {
  if (!/^[a-z][a-z0-9_]{0,79}$/.test(key) || (value !== null && !Number.isFinite(value))) throw new CollectorError("invalid_metric");
  return { source, metric: key, value_num: value, value_text: text === null ? null : sanitizeText(text), period_start: start, period_end: end,
    collected_at: (ctx.now ?? new Date()).toISOString(), collector: "edge_fn", is_test: false };
}
export function notConnected(source: OpsSource, note: string): CollectorResult { return { source, status: "not_connected", metrics: [], note: sanitizeText(note), requestsUsed: 0 }; }
export function failure(ctx: CollectorContext, source: OpsSource, startBudget: number, error: unknown): CollectorResult {
  return { source, status: "error", metrics: [], error: error instanceof CollectorError ? error.code : "collector_failed", requestsUsed: startBudget - budget(ctx).remaining };
}
export function nyDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new CollectorError("invalid_date");
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
export function addDays(value: string, days: number): string {
  const date = new Date(value + "T12:00:00Z"); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}
export function periods(ctx: CollectorContext) {
  const today = nyDate(ctx.now ?? new Date()); const yesterday = addDays(today, -1);
  return { today, yesterday, monthStart: today.slice(0, 7) + "-01", sevenStart: addDays(yesterday, -6), sevenEnd: yesterday };
}
export function previousAt(ctx: CollectorContext, source: OpsSource, key: string, target: Date): MetricSnapshot | null {
  const matches = (ctx.previous ?? []).filter(row => row.source === source && row.metric === key && !row.is_test && typeof row.value_num === "number" && Number.isSafeInteger(row.value_num) && row.value_num >= 0
    && Number.isFinite(Date.parse(row.collected_at)) && Date.parse(row.collected_at) <= target.getTime());
  matches.sort((a, b) => Date.parse(b.collected_at) - Date.parse(a.collected_at));
  const found = matches[0];
  // A baseline older than 24h from the requested boundary is not a 7-day comparison.
  return found && target.getTime() - Date.parse(found.collected_at) <= 86_400_000 ? found : null;
}
export async function googleAccessToken(ctx: CollectorContext, prefix: "GA4" | "GOOGLE_ADS"): Promise<string | null> {
  if (ctx.env[prefix + "_ACCESS_TOKEN"]?.trim()) return ctx.env[prefix + "_ACCESS_TOKEN"]!.trim();
  if (prefix === "GOOGLE_ADS") {
    const client = ctx.env.GOOGLE_ADS_CLIENT_ID, secret = ctx.env.GOOGLE_ADS_CLIENT_SECRET, refresh = ctx.env.GOOGLE_ADS_REFRESH_TOKEN;
    if (!client || !secret || !refresh) return null;
    const body = new URLSearchParams({ client_id: client, client_secret: secret, refresh_token: refresh, grant_type: "refresh_token" });
    const response = await providerJson(ctx, "https://oauth2.googleapis.com/token", "oauth2.googleapis.com", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (!object(response) || typeof response.access_token !== "string" || !response.access_token) throw new CollectorError("oauth_invalid_response");
    return response.access_token;
  }
  if (!ctx.env.GA4_SERVICE_ACCOUNT_JSON) return null;
  let credentials: unknown;
  try { credentials = JSON.parse(ctx.env.GA4_SERVICE_ACCOUNT_JSON); } catch { throw new CollectorError("invalid_service_account"); }
  if (!object(credentials) || typeof credentials.client_email !== "string" || !/^[^@\s]+@[^@\s]+\.gserviceaccount\.com$/.test(credentials.client_email)
    || typeof credentials.private_key !== "string") throw new CollectorError("invalid_service_account");
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const encode = (value: unknown) => b64(new TextEncoder().encode(JSON.stringify(value)));
  const issued = Math.floor((ctx.now ?? new Date()).getTime() / 1000);
  const unsigned = encode({ alg: "RS256", typ: "JWT" }) + "." + encode({ iss: credentials.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: issued, exp: issued + 3600 });
  let signature: ArrayBuffer;
  try {
    const pem = credentials.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
    const bytes = Uint8Array.from(atob(pem), char => char.charCodeAt(0));
    const key = await crypto.subtle.importKey("pkcs8", bytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  } catch { throw new CollectorError("invalid_service_account_key"); }
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + b64(new Uint8Array(signature)) });
  // Ignore token_uri in user-supplied JSON; the token host is fixed and allowlisted.
  const response = await providerJson(ctx, "https://oauth2.googleapis.com/token", "oauth2.googleapis.com", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!object(response) || typeof response.access_token !== "string" || !response.access_token) throw new CollectorError("oauth_invalid_response");
  return response.access_token;
}
