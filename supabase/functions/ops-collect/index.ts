import { ACTIONS, allowedOrigin, NAZAR_BUSINESS, uuid, type ActionName, type ClaimedAction, type Environment, type SafeResult } from "./contracts.ts";
import { OpsStore } from "./store.ts";
import { CollectorError, metric, type CollectorContext, type CollectorResult, type MetricSnapshot } from "./collectors.ts";
import { parseCloverCsv } from "./clover_csv.ts";
import { createCommissionPdf } from "./commission_report.ts";
import { collect as clover } from "./clover_api.ts";
import { collect as klaviyo } from "./klaviyo.ts";
import { collect as reviews } from "./places.ts";
import { collect as site } from "./site_ping.ts";
import { collect as ga4 } from "./ga4.ts";
import { collect as googleAds } from "./google_ads.ts";
import { collect as meta } from "./meta.ts";
import { collect as scheduler } from "./scheduler.ts";
import { scheduleSecretMatches, validScheduleSecret } from "./schedule_auth.ts";

const messages = {
  collected: "Bağlı kaynaklar kontrol edildi. Eksik bağlantılar ve kaynak hataları ayrı kaydedildi.",
  collectPartial: "Bazı kaynaklar okunamadı. Başarılı kaynakların snapshot kayıtları korundu.",
  csv: "CSV doğrulandı ve nitelikli net satış komisyon kaydına işlendi. İadeler ikinci kez düşülmedi.",
  csvLimited: "CSV ölçüleri kaydedildi; kanal / tutar kapsamı doğrulanmadığından komisyon yazılmadı.",
  csvEstimate: "Mevcut ayın doğrulanmış MTD verisinden yalnız komisyon tahmini üretildi; commissions tablosuna kayıt yazılmadı.",
  offer: "Onaylı mevcut teklif durumu değiştirildi. Marketing email gönderilmedi.",
  report: "Doğrulanmış aylık CSV kaynağından private komisyon PDF’i üretildi.",
  disconnected: "Bağlantı veya doğrulanmış yetki bekleniyor; işlem uygulanmadı.",
  failed: "İşlem tamamlanamadı. Sonucu kontrol edin; otomatik tekrar yapılmadı.",
};

async function collectSources(store: OpsStore, ctx: CollectorContext) {
  const snapshot = await store.snapshot();
  ctx.previous = snapshot.previous;
  const sources: CollectorResult[] = [];
  for (const [source, run] of [["clover", clover], ["klaviyo", klaviyo], ["reviews", reviews], ["site", site], ["ga4", ga4], ["google_ads", googleAds], ["meta", meta]] as const) {
    try { sources.push(await run(ctx)); }
    catch { sources.push({ source, status: "error", metrics: [], error: "collector_failed", requestsUsed: 0 }); }
  }
  // An optional migration/credential is not a verified connection. Until both
  // activation and terminal snapshot proof exist, the scheduler stays grey.
  let scheduleEvidence;
  if (validScheduleSecret(ctx.env.OPS_SCHEDULE_SECRET)) {
    try { scheduleEvidence = await store.scheduleStatus(); } catch { /* Optional migration is not installed. */ }
  }
  sources.push(await scheduler(ctx, scheduleEvidence));
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
  const schedulerMetrics = [metric(ctx, "scheduler", "scheduler_mode", null, sources.find(source => source.source === "scheduler")?.status === "connected" ? "pg_cron; 10:00 UTC" : "manual; scheduler awaiting activation and snapshot proof"),
    metric(ctx, "scheduler", "manual_runs_24h", typeof snapshot.scheduler.runs_24h === "number" ? snapshot.scheduler.runs_24h : null),
    metric(ctx, "scheduler", "manual_failed_24h", typeof snapshot.scheduler.failed_24h === "number" ? snapshot.scheduler.failed_24h : null)];
  return { metrics: [...sources.flatMap(source => source.metrics), ...schedulerMetrics], sources };
}

async function execute(action: ClaimedAction, store: OpsStore, ctx: CollectorContext) {
  if (!ACTIONS.includes(action.action)) throw new Error("unsupported_action");
  if (action.action === "collect" || action.action === "retry_failed_job") {
    const collected = await collectSources(store, ctx);
    const failed = collected.sources.some(source => source.status === "error");
    return { status: failed ? "failed" : "done", result: { code: failed ? "partial_collection" : "collected", message: failed ? messages.collectPartial : messages.collected,
      requestsUsed: 30 - (ctx.budget?.remaining ?? 30), ...(action.action === "retry_failed_job" ? { retriedActionId: action.payload.actionId } : {}) }, metrics: collected.metrics, connections: collected.sources } as const;
  }
  if (action.action === "sync_clover_csv") {
    const { csv, fileName, periodStart, periodEnd } = action.payload;
    if (![csv, fileName, periodStart, periodEnd].every(value => typeof value === "string") || new TextEncoder().encode(String(csv)).length > 1048576) throw new Error("invalid_csv_input");
    const parsed = await parseCloverCsv(csv as string, { fileName: fileName as string, periodStart: periodStart as string, periodEnd: periodEnd as string, now: ctx.now });
    let metrics: MetricSnapshot[] = parsed.metrics;
    const hasEstimate = parsed.commissionEstimateReady === true;
    if ((parsed.commissionReady || hasEstimate) && parsed.qualifiedSales !== null) {
      await store.commitCsv(action, { periodStart, periodEnd, qualified: true, qualifiedSales: parsed.qualifiedSales, fingerprint: parsed.fingerprint, importedRows: parsed.counts.rows - parsed.counts.excluded - parsed.counts.duplicates, metrics: parsed.metrics });
      metrics = [];
    }
    metrics = [...metrics, metric(ctx, "supabase", "last_clover_import_at", null, (ctx.now || new Date()).toISOString()), metric(ctx, "supabase", "last_clover_import_source", null, "CSV")];
    return { status: "done", result: { code: parsed.commissionReady ? "csv_imported" : hasEstimate ? "csv_estimate" : "csv_metrics_only", message: parsed.commissionReady ? messages.csv : hasEstimate ? messages.csvEstimate : messages.csvLimited,
      importedRows: parsed.counts.rows, excludedRows: parsed.counts.excluded, periodStart, periodEnd }, metrics,
      connections: [{ source: "clover", status: "connected", metrics: [], requestsUsed: 0, capabilities: ["sync_clover_csv"], note: parsed.commissionReady ? "Kanal ve net tutar kapsamı doğrulandı; tam ay komisyonu kaydedildi." : hasEstimate ? "Doğrulanmış MTD kaynağı; komisyon yalnız tahmindir." : "CSV aggregate ölçüleri var; komisyon kapsamı doğrulanmadı." } as CollectorResult] } as const;
  }
  if (action.action === "offer_set_active") {
    if (await store.setOffer(action) !== true) throw new Error("capability_not_connected");
    return { status: "done", result: { code: "offer_updated", message: messages.offer }, metrics: [], connections: [] } as const;
  }
  if (action.action === "commission_report") {
    const commission = await store.commission(action);
    const path = `${NAZAR_BUSINESS}/ops/commission/${commission.period_month.slice(0, 7)}-${action.id}.pdf`;
    if (await store.claimValid(action) !== true) throw new Error("action_no_longer_running");
    await store.uploadPdf(path, createCommissionPdf(commission));
    return { status: "done", result: { code: "report_created", message: messages.report, downloadPath: path }, metrics: [], connections: [] } as const;
  }
  // No verified write integration/catalog exists for Ads, Meta or Clover inventory.
  // Merely setting a token MUST NOT enable arbitrary external write actions.
  return { status: "not_connected", result: { code: "write_integration_not_verified", message: messages.disconnected }, metrics: [], connections: [] } as const;
}

export async function handleRequest(request: Request, env: Environment, requestFetch: typeof fetch = fetch, defer?: (promise: Promise<unknown>) => void): Promise<Response> {
  const origin = request.headers.get("Origin");
  const headers = { "Content-Type": "application/json", "Cache-Control": "private, no-store", "Vary": "Origin", ...(origin && allowedOrigin(origin, env) ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-client-info", "Access-Control-Allow-Methods": "POST,OPTIONS" } : {}) };
  const reply = (status: number, code: string) => new Response(JSON.stringify({ code }), { status, headers });
  if (!allowedOrigin(origin, env)) return reply(403, "forbidden");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return reply(405, "method_not_allowed");
  const bearer = request.headers.get("Authorization") || "";
  if (!/^Bearer [A-Za-z0-9_.-]{20,4096}$/.test(bearer)) return reply(401, "unauthorized");
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return reply(415, "invalid_content_type");
  let actionId: string | undefined; let newAction: ActionName | undefined; let payload: Record<string, unknown> = {}; let scheduledKey: string | undefined;
  try {
    if (Number(request.headers.get("Content-Length") || 0) > 1100000) return reply(413, "too_large");
    const raw = await request.text(); if (new TextEncoder().encode(raw).length > 1100000) return reply(413, "too_large");
    const body: unknown = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, "invalid_action");
    const input = body as Record<string, unknown>;
    if (Object.keys(input).length === 2 && input.scheduledCollect === true && uuid(input.runKey)) scheduledKey = input.runKey;
    else if (Object.keys(input).length === 1 && uuid(input.actionId)) actionId = input.actionId;
    else if (Object.keys(input).every(key => ["action", "payload"].includes(key)) && ACTIONS.includes(input.action as ActionName)
      && input.payload && typeof input.payload === "object" && !Array.isArray(input.payload) && uuid((input.payload as Record<string, unknown>).clientRequestId)) {
      newAction = input.action as ActionName; payload = input.payload as Record<string, unknown>;
    } else return reply(400, "invalid_action");
  } catch { return reply(400, "invalid_action"); }
  const schedulerHeader = request.headers.get("x-nazar-ops-schedule-secret");
  if (scheduledKey) {
    if (origin !== null) return reply(403, "forbidden");
    if (!validScheduleSecret(env.OPS_SCHEDULE_SECRET)) return reply(503, "schedule_not_configured");
    if (!scheduleSecretMatches(schedulerHeader, env.OPS_SCHEDULE_SECRET)) return reply(403, "forbidden");
  } else if (schedulerHeader !== null) return reply(403, "forbidden");
  if (env.SUPABASE_URL && env.SUPABASE_URL !== "https://khgczybubufouraqyrcj.supabase.co") return reply(503, "wrong_project_configuration");
  const store = new OpsStore(env, requestFetch); let action: ClaimedAction | null = null;
  try {
    if (scheduledKey) {
      action = await store.enqueueScheduled(scheduledKey);
      if (!action) return reply(202, "scheduled_skipped");
      if (action.action !== "collect" || action.requested_by !== null || action.actor_kind !== "scheduler" || action.request_key !== scheduledKey) return reply(503, "invalid_schedule_receipt");
    } else {
      const userId = await store.authenticate(bearer);
      if (newAction) {
        const enqueued = await store.enqueue(newAction, payload, bearer);
        if (["done", "failed", "not_connected"].includes(enqueued.status)) return new Response(JSON.stringify({ code: enqueued.status, action: enqueued }), { status: 200, headers });
        actionId = enqueued.id;
      }
      if (!actionId) return reply(400, "invalid_action");
      action = await store.claim(actionId, userId);
      if (!action) return reply(409, "already_claimed_or_unavailable");
    }
    const ctx: CollectorContext = { env, now: new Date(), budget: { remaining: 30 }, fetch: async (url, init) => {
      let reserved = false;
      try { reserved = await store.reserveExternal(); }
      catch { if (ctx.budget) ctx.budget.remaining++; throw new CollectorError("daily_budget_unavailable"); }
      if (!reserved) { if (ctx.budget) ctx.budget.remaining++; throw new CollectorError("daily_request_budget_exhausted"); }
      return requestFetch(url, init);
    } };
    const claimed = action;
    const work = async () => {
      try {
        const outcome = await execute(claimed, store, ctx);
        await store.finish(claimed, outcome.status, outcome.result as SafeResult, outcome.metrics, outcome.connections);
      } catch (error) {
        const code = error instanceof Error ? error.message : "ops_failed";
        const notConnected = code === "capability_not_connected";
        try { await store.finish(claimed, notConnected ? "not_connected" : "failed", {
          code: notConnected ? "capability_not_connected" : code === "already_imported_or_busy" ? "already_imported_or_busy" : "ops_failed",
          message: notConnected ? messages.disconnected : messages.failed }); } catch { /* Remains running/unknown; no duplicate or automatic retry. */ }
      }
    };
    if (defer) defer(work()); else await work();
    return new Response(JSON.stringify({ code: "running", action: { id: claimed.id, request_key: claimed.request_key, action: claimed.action, requested_by: claimed.requested_by, actor_kind: claimed.actor_kind || "staff", requested_at: claimed.requested_at, status: "running", result: {}, finished_at: null } }), { status: 202, headers });
  } catch (error) {
    const code = error instanceof Error ? error.message : "ops_failed";
    if (!action) return reply(code === "forbidden" ? 403 : 503, code === "forbidden" ? "forbidden" : "ops_unavailable");
    const notConnected = code === "capability_not_connected";
    try {
      await store.finish(action, notConnected ? "not_connected" : "failed", { code: notConnected ? "capability_not_connected" : code === "already_imported_or_busy" ? "already_imported_or_busy" : "ops_failed", message: notConnected ? messages.disconnected : messages.failed });
    } catch { return reply(503, "finish_not_confirmed"); }
    return reply(200, notConnected ? "not_connected" : "failed");
  }
}

declare const Deno: { env: { toObject: () => Environment }; serve: (handler: (request: Request) => Promise<Response>) => unknown } | undefined;
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void } | undefined;
if (typeof Deno !== "undefined") Deno.serve(request => handleRequest(request, Deno.env.toObject(), fetch, typeof EdgeRuntime !== "undefined" ? promise => EdgeRuntime.waitUntil(promise) : undefined));
