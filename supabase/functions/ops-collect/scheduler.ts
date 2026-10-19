import type { CollectorContext, CollectorResult } from "./collectors.ts";

// The accepted installation uses Pages waitUntil, not a cron/scheduled worker.
// Manual ops action history is provided separately by ops_internal_snapshot_v.
export async function collect(ctx: CollectorContext): Promise<CollectorResult> {
  return { source: "scheduler", status: "not_connected", metrics: [], requestsUsed: 0,
    note: `Günlük scheduler kurulu değil. Yalnız elle toplama; mevcut Pages waitUntil gelen isteğe bağlıdır. Kontrol ${(ctx.now || new Date()).toISOString()}.` };
}
