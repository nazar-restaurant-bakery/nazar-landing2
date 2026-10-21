-- MANUAL OPERATOR STEP ONLY after K7 + K12 closure, sandbox first.
-- Requires pg_cron, pg_net, Vault and extensions.hmac from pgcrypto.
-- Secret values must be entered privately by Talip, never in this file.
-- Vault names: SCHEDULER_SIGNING_SECRET and SCHEDULER_EDGE_URL.
-- Edge + Cloudflare binding: same SCHEDULER_SIGNING_SECRET (>=32 random bytes).
-- No staff JWT, auth role change or ops.write credential is used.
BEGIN;
SELECT cron.schedule('platform-daily-ops','* * * * *','SELECT core.daily_scheduler_tick();');
UPDATE cron.job SET active=false WHERE jobname='platform-daily-ops';
COMMIT;
-- Later, after signed 401/replay/pause/budget checks and tenant configuration:
-- 1. Talip sets the reviewed business_id + fixed Cloudflare worker URL in settings.
-- 2. Talip enables that tenant, then activates ONLY platform-daily-ops.
-- Emergency: set the tenant enabled=false and cron.job.active=false.
