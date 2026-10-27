# Extension prerequisite - REVIEW ONLY, no execution authorization

Root read-only Production inventory: PostgreSQL 17.6; pgcrypto 1.3 and Vault 0.3.1 installed; pg_cron 1.6.4 and pg_net 0.20.4 available but NOT installed. Sandbox inventory has not been established here. This document performs no installation and does not change historical Ops scheduler records.

After separate explicit approval, Sandbox first, then Production:

1. Talip selects the correct project. Inspect the target before any write:

```sql
BEGIN READ ONLY;
SELECT current_setting('server_version') AS server_version;
SELECT name,default_version,installed_version FROM pg_available_extensions
WHERE name IN ('pg_cron','pg_net','pgcrypto','supabase_vault');
SELECT to_regclass('cron.job') AS cron_job,
 to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') AS http_post;
COMMIT;
```

2. Require the reviewed versions to be available on that target. If an installed version differs, stop for review; no automatic upgrade/drop. Future extension-only DDL, to be separately approved and run by Talip with the common LF/psql operator:

```sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron VERSION '1.6.4';
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions VERSION '0.20.4';
COMMIT;
```

The Dashboard alternatives are Integrations -> Cron Postgres Module -> enable pg_cron, and Database -> Extensions -> pg_net. Use one reviewed method, not both. Official instructions: [Cron install](https://supabase.com/docs/guides/cron/install), [pg_net enable/signature](https://supabase.com/docs/guides/database/extensions/pg_net). These steps enable extensions only; no job, Vault entry, secret, request or customer is created by this recipe.

3. Repeat the read-only inventory. Require `cron.job` and the exact `net.http_post` signature to exist; check installed versions. Review `cron.job` names and active counts without changing other jobs. Verify core stays outside exposed Data API schemas and no browser grants were added. A missing/failed prerequisite means the cron candidate stays blocked.

4. Only after Root assigns and reviews the new migration sequence: consumer candidate first, closed cron candidate second. The cron source installs only its new inactive job in one transaction; zero targets are seeded. Verify `coupon-automation-normal.active=false`, zero target rows, consumer/runtime/normal-delivery flags unchanged. Do not enqueue HTTP as part of this prerequisite.

5. Vault names for later setup: `COUPON_AUTOMATION_SIGNING_SECRET`, `COUPON_AUTOMATION_EDGE_URL`. Values are entered and managed only by Talip; Root checks names and target metadata without opening values. Values are never requested in chat or passed via shell/cron command text. Edge signing secret must match its own target Vault value; never share it between environments. URL must match the singleton `core.installation.declared_project_ref` and exact `/functions/v1/coupon-welcome-run` path. No key creation is performed here.

Pause/rollback planning: keep target and runtime disabled; deactivate only the new coupon job after it exists. Do not drop pg_cron/pg_net or alter other scheduler records. Hosted extension transport/queue latency and deployed HMAC gateway still need separate acceptance. pg_net redirects remain the explicitly documented architecture limitation; no hosted no-follow PASS is claimed.
