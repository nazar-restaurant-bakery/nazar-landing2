import type { OpsAction, OpsConnection, OpsMetric } from "../../../lib/opsUi";

// The connection contract has no last_error_at. Fail closed unless the last
// collection's receipt proves that all three failed ping measurements belong
// to that same attempt. Never reuse a prior successful (or prior failed) ping.
export function observedSiteFailure(metrics: OpsMetric[], connection: OpsConnection | undefined, actions: OpsAction[] | null) {
  if (connection?.status !== "error" || !/^site_http_[45]\d{2}$/.test(connection.last_error || "")) return null;
  const lastAttempt = (actions || []).filter(action => ["collect", "retry_failed_job"].includes(action.action)
    && Number.isFinite(Date.parse(action.requested_at)))
    .sort((a, b) => Date.parse(b.requested_at) - Date.parse(a.requested_at))[0];
  if (!lastAttempt || lastAttempt.status !== "failed" || !lastAttempt.finished_at) return null;
  const requested = Date.parse(lastAttempt.requested_at), finished = Date.parse(lastAttempt.finished_at);
  if (!Number.isFinite(finished) || finished < requested) return null;
  const newest = (key: string) => metrics.filter(item => item.source === "site" && item.metric === key && !item.is_test
    && Number.isFinite(Date.parse(item.collected_at)))
    .sort((a, b) => Date.parse(b.collected_at) - Date.parse(a.collected_at))[0];
  const up = newest("is_up"), http = newest("http_status"), duration = newest("response_ms");
  if (!up || !http || !duration || up.value_num !== 0 || http.value_num === null
    || !Number.isInteger(http.value_num) || http.value_num < 400 || http.value_num > 599
    || duration.value_num === null || !Number.isFinite(duration.value_num) || duration.value_num < 0
    || connection.last_error !== `site_http_${http.value_num}`
    || up.collected_at !== http.collected_at || up.collected_at !== duration.collected_at) return null;
  const collected = Date.parse(up.collected_at);
  if (collected < requested || collected > finished) return null;
  return new Map([up, http, duration].map(item => [item.metric, item]));
}
