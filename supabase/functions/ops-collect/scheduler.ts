import { metric, type CollectorContext, type CollectorResult } from "./collectors.ts";

export type ScheduleEvidence = { enabled: boolean; active: boolean; verified: boolean; secret_sha256: string | null; runs_24h: number; failed_24h: number; last_failure_name: string | null; last_failure_at: string | null };
// Prepared SQL is not installation or execution evidence. Only the private
// service RPC can attest to an active job AND a terminal scheduled snapshot.
export async function collect(ctx: CollectorContext, evidence?: ScheduleEvidence): Promise<CollectorResult> {
  const secret = ctx.env.OPS_SCHEDULE_SECRET || "";
  let secretMatches = false;
  if (/^[a-f0-9]{64}$/i.test(secret) && /^[a-f0-9]{64}$/.test(evidence?.secret_sha256 || "")) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    secretMatches = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") === evidence?.secret_sha256;
  }
  if (secretMatches && evidence?.enabled === true && evidence.active === true && evidence.verified === true
    && Number.isSafeInteger(evidence.runs_24h) && evidence.runs_24h >= 0 && Number.isSafeInteger(evidence.failed_24h) && evidence.failed_24h >= 0 && evidence.failed_24h <= evidence.runs_24h) {
    return { source: "scheduler", status: "connected", requestsUsed: 0,
      note: "pg_cron + pg_net doğrulandı. Sabit 10:00 UTC: 06:00 EDT / 05:00 EST; Şimdi topla bağımsızdır.",
      metrics: [metric(ctx, "scheduler", "runs_24h", evidence.runs_24h), metric(ctx, "scheduler", "failures_24h", evidence.failed_24h),
        metric(ctx, "scheduler", "last_failure_name", null, evidence.last_failure_name), metric(ctx, "scheduler", "last_failure_at", null, evidence.last_failure_at)] };
  }
  return { source: "scheduler", status: "not_connected", metrics: [], requestsUsed: 0,
    note: `Scheduler için aktif job, credential ve tamamlanmış snapshot kanıtı bekleniyor; ilk sürüm Şimdi topla ile kullanılır. Kontrol ${(ctx.now || new Date()).toISOString()}.` };
}
