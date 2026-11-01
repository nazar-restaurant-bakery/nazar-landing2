// Edge market-ads: Google Ads campaign x day report -> market.ad_reports through service_role RPCs.
// Triggered only by market.ads_run_v1 / market.ads_cron_tick_v1 (signed, single use). Dry run: no
// Google call. A failed run sends one alert per error code per New York day. No key, token or
// signature is logged or returned.
import { verifyTrigger, type AdsTrigger } from "./auth.ts";
import { ADS_CUSTOMER, AdsError, CapReached, PLANNED_CALLS, readAds, type AdsRow } from "./ads.ts";
import { sendAlert } from "./alert.ts";
type Env = Record<string, string | undefined>;
type Claim = { claim_token: string; dry_run: boolean; max_calls: number; days: number; period_start: string; period_end: string };
const nyDate = (ms: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

export function marketAdsHandler(fetcher: typeof fetch = fetch, now = () => Date.now(),
  background?: (task: Promise<unknown>) => void) {
  return async (request: Request, env: Env): Promise<Response> => {
    const reply = (status: number, code: string, extra: Record<string, unknown> = {}) =>
      new Response(JSON.stringify({ code, ...extra }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    if (request.method !== "POST") return reply(405, "method_not_allowed");
    let body: AdsTrigger;
    try { const raw = await request.text(); if (raw.length > 1024) return reply(400, "invalid_request"); body = JSON.parse(raw); }
    catch { return reply(400, "invalid_request"); }
    if (!await verifyTrigger(body, request.headers.get("X-Scheduler-Signature") || "", env.SCHEDULER_SIGNING_SECRET || "", now()))
      return reply(401, "unauthorized");
    if (!env.SUPABASE_URL || !/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(env.SUPABASE_URL) || !env.SUPABASE_SERVICE_ROLE_KEY)
      return reply(503, "configuration_missing");
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const key = env.SUPABASE_SERVICE_ROLE_KEY!;
      const r = await fetcher(env.SUPABASE_URL + "/rest/v1/rpc/" + name, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify(args) });
      if (!r.ok) throw Error("database_unavailable");
      return r.json();
    };
    let claim: Claim | null;
    try { claim = await rpc("market_ads_claim_v1", { p_business_id: body.business_id, p_run_id: body.run_id, p_nonce: body.nonce }); }
    catch { return reply(503, "database_unavailable"); }
    if (!claim) return reply(409, "already_claimed");
    const run = claim;
    const ids = { p_business_id: body.business_id, p_run_id: body.run_id, p_claim_token: run.claim_token };
    const log = (fields: Record<string, unknown>) => console.info("market_ads_result " + JSON.stringify({ run_id: body.run_id, ...fields }));
    // Finish, then (failed only) the alert the database allows: at most one per code per day.
    const finish = async (status: "succeeded" | "failed", code: string, calls: number, rows: AdsRow[]) => {
      const written = await rpc("market_ads_finish_v1", { ...ids, p_status: status, p_safe_code: code, p_calls_used: calls, p_rows: rows }) as
        { rows_written: number; alert_due: boolean };
      let alert: string | null = status === "failed" ? "already_sent_today" : null;
      if (written.alert_due) {
        alert = await sendAlert(env.RESEND_ALERTS_API_KEY, nyDate(now()), code, "market-ads-alert-" + body.run_id, fetcher);
        try { await rpc("market_ads_alert_v1", { ...ids, p_alert_status: alert }); } catch { /* alert stays 'pending' */ }
      }
      log({ status, safe_code: code, period_start: run.period_start, period_end: run.period_end, calls_used: calls,
        rows_written: written.rows_written, alert });
      return { rows_written: written.rows_written, alert };
    };

    if (run.dry_run) {
      try { await finish("succeeded", "dry_run", 0, []); } catch { return reply(503, "unknown_result"); }
      return reply(200, "dry_run", { planned_calls: PLANNED_CALLS, max_calls: run.max_calls, period_start: run.period_start, period_end: run.period_end });
    }
    const configured = ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_CUSTOMER_ID"].every(k => env[k]?.trim());
    const work = async () => {
      const counter = { calls: 0 };
      let rows: AdsRow[] = [], status: "succeeded" | "failed" = "succeeded", code = "completed";
      try {
        if (!configured) throw new AdsError("ads_not_configured");
        if (env.GOOGLE_ADS_CUSTOMER_ID!.replaceAll("-", "") !== ADS_CUSTOMER) throw new AdsError("ads_account_mismatch");
        rows = await readAds(env, fetcher, { start: run.period_start, end: run.period_end }, run.max_calls, counter);
        if (!rows.length) code = "no_data"; // an empty report writes nothing
      } catch (error) {
        rows = []; status = "failed";
        code = error instanceof CapReached ? "call_cap_reached" : error instanceof AdsError ? error.code : "unexpected";
      }
      const result = await finish(status, code, counter.calls, rows);
      return reply(status === "failed" ? 503 : 200, status === "failed" ? code : status, { calls_used: counter.calls, ...result });
    };
    const guarded = () => work().catch(() => { log({ status: "unknown_result" }); return reply(503, "unknown_result"); });
    if (background) { background(guarded()); return reply(202, "accepted", { planned_calls: PLANNED_CALLS }); }
    return guarded();
  };
}

declare const Deno: { serve: (fn: (req: Request) => Promise<Response>) => void; env: { toObject: () => Env } };
declare const EdgeRuntime: { waitUntil: (task: Promise<unknown>) => void };
if (typeof Deno !== "undefined") Deno.serve(req => marketAdsHandler(fetch, () => Date.now(),
  typeof EdgeRuntime !== "undefined" ? task => EdgeRuntime.waitUntil(task) : undefined)(req, Deno.env.toObject()));
