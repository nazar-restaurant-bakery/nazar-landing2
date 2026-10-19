export const OPS_SOURCES = ["clover", "klaviyo", "google_ads", "meta", "site", "ga4", "reviews", "scheduler", "supabase"] as const;
export type OpsSource = typeof OPS_SOURCES[number];
export const OPS_ACTIONS = ["collect", "sync_clover_csv", "retry_failed_job", "offer_set_active", "ads_set_status", "product_set_channel", "commission_report"] as const;
export type OpsActionName = typeof OPS_ACTIONS[number];
export type OpsActionStatus = "queued" | "running" | "done" | "failed" | "not_connected";
export type OpsMetric = {
  source: OpsSource; metric: string; value_num: number | null; value_text: string | null;
  period_start: string | null; period_end: string | null; collected_at: string;
  collector: string; is_test: boolean;
};
export type OpsConnection = {
  source: OpsSource; status: "connected" | "not_connected" | "error";
  last_ok_at: string | null; last_error: string | null; note: string | null;
  capabilities: OpsActionName[];
};
export type OpsAction = {
  id: string; request_key: string; action: OpsActionName; requested_by: string | null; requested_at: string;
  actor_kind?: "staff" | "scheduler";
  status: OpsActionStatus; result: { message?: string; code?: string; downloadPath?: string };
  finished_at: string | null;
};
export type OpsDashboard = {
  business_id: string; generated_at: string; metrics: OpsMetric[];
  offers: { id: string; name: string; is_test: boolean; active: boolean; approved: boolean }[];
  failed_jobs: { id: string; name: string; failed_at: string }[];
  campaigns: { id: string; name: string; source: "google_ads" | "meta"; status: string }[];
  products: { id: string; name: string; channel: string; available: boolean }[];
};

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 500): v is string => typeof v === "string" && v.length <= max;
const nullable = (v: unknown) => v === null || text(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const member = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && list.includes(value as T);
const list = (v: unknown, max: number) => Array.isArray(v) && v.length <= max;
export const opsPending = (value: unknown) => object(value) && ["PGRST202", "PGRST204", "42883", "42P01", "MISSING_CONFIG"].includes(String(value.code));
export const opsDenied = (value: unknown) => object(value) && (["42501", "403"].includes(String(value.code)) || value.status === 403);

export function validOpsDashboard(v: unknown): v is OpsDashboard {
  return object(v) && uuid(v.business_id) && text(v.generated_at)
    && list(v.metrics, 1000) && (v.metrics as unknown[]).every(m => object(m)
      && member(OPS_SOURCES, m.source) && text(m.metric, 100) && /^[a-z][a-z0-9_]+$/.test(m.metric)
      && (m.value_num === null || typeof m.value_num === "number" && Number.isFinite(m.value_num))
      && nullable(m.value_text) && nullable(m.period_start) && nullable(m.period_end)
      && text(m.collected_at) && text(m.collector, 30) && typeof m.is_test === "boolean")
    && list(v.offers, 100) && (v.offers as unknown[]).every(o => object(o) && uuid(o.id) && text(o.name, 200)
      && typeof o.is_test === "boolean" && typeof o.active === "boolean" && typeof o.approved === "boolean")
    && list(v.failed_jobs, 50) && (v.failed_jobs as unknown[]).every(j => object(j) && uuid(j.id) && text(j.name, 100) && text(j.failed_at))
    && list(v.campaigns, 100) && (v.campaigns as unknown[]).every(a => object(a) && text(a.id, 100) && text(a.name, 200) && member(["google_ads", "meta"], a.source) && text(a.status, 30))
    && list(v.products, 100) && (v.products as unknown[]).every(p => object(p) && text(p.id, 100) && text(p.name, 200) && text(p.channel, 30) && typeof p.available === "boolean");
}
export function validOpsConnections(v: unknown): v is { items: OpsConnection[] } {
  if (!object(v) || !list(v.items, OPS_SOURCES.length)) return false;
  const seen = new Set<string>();
  return (v.items as unknown[]).every(c => {
    if (!object(c) || !member(OPS_SOURCES, c.source) || seen.has(c.source)) return false;
    seen.add(c.source);
    return member(["connected", "not_connected", "error"], c.status) && nullable(c.last_ok_at)
      && nullable(c.last_error) && nullable(c.note) && list(c.capabilities, OPS_ACTIONS.length)
      && (c.capabilities as unknown[]).every(a => member(OPS_ACTIONS, a));
  });
}
export function validOpsAction(v: unknown): v is OpsAction {
  return object(v) && uuid(v.id) && uuid(v.request_key) && member(OPS_ACTIONS, v.action) && nullable(v.requested_by)
    && (!("actor_kind" in v) || member(["staff", "scheduler"], v.actor_kind))
    && (v.actor_kind === "scheduler" ? v.requested_by === null && v.action === "collect" : v.actor_kind !== "staff" || uuid(v.requested_by))
    && text(v.requested_at) && member(["queued", "running", "done", "failed", "not_connected"], v.status)
    && nullable(v.finished_at) && object(v.result)
    && [v.result.message, v.result.code, v.result.downloadPath].every(s => s === undefined || text(s));
}
export function opsCanResume(action: OpsAction, identity: string) {
  return action.actor_kind !== "scheduler" && action.status === "queued" && uuid(identity) && action.requested_by === identity;
}
export function validOpsActions(v: unknown): v is { items: OpsAction[] } {
  return object(v) && list(v.items, 50) && (v.items as unknown[]).every(validOpsAction);
}
export function opsReportPath(action: OpsAction, businessId: string) {
  const path = action.result.downloadPath;
  if (action.action !== "commission_report" || action.status !== "done" || !uuid(businessId) || !path) return null;
  const prefix = businessId + "/ops/commission/";
  return path.startsWith(prefix)
    && new RegExp("^\\d{4}-(0[1-9]|1[0-2])-" + action.id + "\\.pdf$").test(path.slice(prefix.length))
    ? path : null;
}
function nyDay(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find(part => part.type === type)?.value || "";
  return get("year") + "-" + get("month") + "-" + get("day");
}
function shiftDay(day: string, amount: number) {
  const value = new Date(day + "T12:00:00Z");
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
export function selectOpsMetric(metrics: OpsMetric[], source: OpsSource, key: string, now = new Date()) {
  const today = nyDay(now), yesterday = shiftDay(today, -1), monthStart = today.slice(0, 7) + "-01";
  return metrics.filter(item => {
    if (item.source !== source || item.metric !== key || item.is_test || !Number.isFinite(Date.parse(item.collected_at))) return false;
    if (key.endsWith("_yesterday")) return item.period_start === yesterday && item.period_end === yesterday;
    if (key.endsWith("_mtd") || ["baseline", "rate"].includes(key)) {
      return item.period_start === monthStart && !!item.period_end && item.period_end >= monthStart && item.period_end <= today;
    }
    if (["net_growth_7d", "new_reviews_7d"].includes(key)) return !!item.period_end && !!item.period_start
      && [today, yesterday].includes(item.period_end) && item.period_start >= shiftDay(item.period_end, -8)
      && item.period_start <= shiftDay(item.period_end, -6);
    if (key.endsWith("_7d")) return !!item.period_end && [today, yesterday].includes(item.period_end)
      && item.period_start === shiftDay(item.period_end, -6);
    return true;
  }).sort((a, b) => Date.parse(b.collected_at) - Date.parse(a.collected_at))[0];
}
