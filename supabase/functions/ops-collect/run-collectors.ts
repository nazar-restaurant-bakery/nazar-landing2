import type { OpsStore } from "./store.ts";
import { metric, type CollectorContext, type CollectorResult } from "./collectors.ts";
import { collect as clover } from "./clover_api.ts";
import { collect as klaviyo } from "./klaviyo.ts";
import { collect as reviews } from "./places.ts";
import { collect as site } from "./site_ping.ts";
import { collect as ga4 } from "./ga4.ts";
import { collect as googleAds } from "./google_ads.ts";
import { collect as meta } from "./meta.ts";
export async function collectSources(store: Pick<OpsStore, "snapshot">, ctx: CollectorContext) {
  const snapshot = await store.snapshot();
  ctx.previous = snapshot.previous;
  const sources: CollectorResult[] = [];
  for (const [source, run] of [["clover", clover], ["klaviyo", klaviyo], ["reviews", reviews], ["site", site], ["ga4", ga4], ["google_ads", googleAds], ["meta", meta]] as const) {
    try { sources.push(await run(ctx)); }
    catch { sources.push({ source, status: "error", metrics: [], error: "collector_failed", requestsUsed: 0 }); }
  }
  // A visible waiting tile is not a scheduler implementation. This release
  // accepts authenticated staff requests only and never installs a timer/job.
  sources.push({ source: "scheduler", status: "not_connected", metrics: [], requestsUsed: 0,
    note: "Bu sürüm yalnız Şimdi topla ile çalışır. Günlük otomatik toplama ayrı karardır." });
  const importProof = snapshot.metrics.find(item => item.metric === "last_clover_import_at" && item.value_text);
  if (importProof) {
    const cloverStatus = sources.find(item => item.source === "clover");
    if (cloverStatus?.status === "not_connected") {
      cloverStatus.status = "connected"; cloverStatus.capabilities = ["sync_clover_csv"];
      cloverStatus.note = "Doğrulanmış CSV kaynağı mevcut; otomatik Clover API aktarımı bağlı değil.";
    }
  }
  const cloverSource = sources.find(source => source.source === "clover");
  if (cloverSource) cloverSource.capabilities = ["sync_clover_csv"];
  sources.push({ source: "supabase", status: "connected", metrics: snapshot.metrics, capabilities: snapshot.capabilities,
    requestsUsed: 0, note: "Yalnız gerçek başvuruların aggregate sayımı. Sütunu / kaynağı olmayan ölçü bilinmiyor." });
  const schedulerMetrics = [metric(ctx, "scheduler", "scheduler_mode", null, "manual; daily scheduler not installed"),
    metric(ctx, "scheduler", "manual_runs_24h", typeof snapshot.scheduler.runs_24h === "number" ? snapshot.scheduler.runs_24h : null),
    metric(ctx, "scheduler", "manual_failed_24h", typeof snapshot.scheduler.failed_24h === "number" ? snapshot.scheduler.failed_24h : null)];
  return { metrics: [...sources.flatMap(source => source.metrics), ...schedulerMetrics], sources };
}

