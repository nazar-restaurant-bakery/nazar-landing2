# K1c — Talip-controlled installation and acceptance

Status: pre-merge preparation. No hosted SQL, deploy, secret or account action was executed by Codex. Coordination must first register the delivery in `Migration_Sirasi.md`; the file was not found in this workspace and has not been invented or edited.

## Exact migration

- File: `supabase/migrations/20261020000100_ops_panel.sql`
- SHA256 of exact LF bytes: `3204eab72b8b0a9dc64eefc2f02d05ff0fde7a96489e010eb125896347007fa4`
- No CR bytes; Git pins this file to LF. Do not rename, reformat or change SQL between test and Production. Coordination confirms this timestamp is free before application; a changed name/hash requires a new receipt.
- Existing application baseline, K3 marker, K4 and K5 migrations precede it. This additive delivery stays outside K3 historical/reset replay.
- Existing business guards remain; only the installation project guard takes the trusted session setting below. Missing setting retains the inherited Production guard. Sandbox and Production use the same installed single-business schema; no second tenant is introduced.

## Talip: migration (first sandbox; then wait)

Use the existing `Nazar-catering-sandbox — database password` entry for sandbox and `Nazar-production — database password` for Production. Staff login passwords are unrelated. Password entry, login and credential storage stay with Talip. Use a password-free database connection URL copied from the correct project's Connect panel; let psql prompt for the database password. Do not put passwords into URLs, arguments, logs or this file.

From the repository root, Talip sets `NAZAR_SANDBOX_DB_URL` to the correct password-free connection URL, then runs:

```powershell
$opsPsql = 'C:/Users/Talip/scoop/apps/postgresql/current/bin/psql.exe'
& $opsPsql --version
Get-FileHash -Algorithm SHA256 'supabase/migrations/20261020000100_ops_panel.sql'
& $opsPsql -X -W --set ON_ERROR_STOP=on --dbname $env:NAZAR_SANDBOX_DB_URL -c "SET app.ops_project_ref='uxiseddbeszklkrvysxf'" -f 'supabase/migrations/20261020000100_ops_panel.sql'
```

Require psql **18.6**, matching SHA256 and a successful COMMIT. Any error stops this sequence; the migration is transactional. Do not rerun a committed migration blindly. The empty Ops action queue is expected before collection. Test the installed schema and authorization before Production; read-only verification is `tools/test-env/k1c-verify.sql`.

After sandbox function/authorization/count acceptance and Talip’s release decision, use **the same executable and LF file** with the Production URL:

```powershell
& $opsPsql -X -W --set ON_ERROR_STOP=on --dbname $env:NAZAR_PRODUCTION_DB_URL -c "SET app.ops_project_ref='khgczybubufouraqyrcj'" -f 'supabase/migrations/20261020000100_ops_panel.sql'
```

## Talip: Edge Function (first sandbox; then Production)

The installed CLI is invoked from the repository root so it reads `supabase/config.toml`. Talip performs any `supabase login` flow himself. Neither command applies SQL. Only deploy after that environment's SQL is accepted.

1. In [sandbox Secrets](https://supabase.com/dashboard/project/uxiseddbeszklkrvysxf/functions/secrets), Talip adds deployment configuration `OPS_PROJECT_REF=uxiseddbeszklkrvysxf`. No provider key is needed.
2. Talip runs `supabase functions deploy ops-collect --project-ref uxiseddbeszklkrvysxf --use-api`.
3. Open the new sandbox function, **Details → Function configuration**. Verify JWT verification is **ON**; Codex reads it without changing it. Repository config is `[functions.ops-collect] verify_jwt = true`. Do not pass `--no-verify-jwt`.
4. First verify missing/invalid authorization is refused by the gateway; a valid existing nonstaff user must reach the application check and get **403**, with no action/snapshot write. Login is Talip’s task. If gateway rejects legitimate staff JWTs, stop and diagnose signing-key compatibility; do not disable JWT verification.
5. With the existing authorized test account, invoke one manual collect through the supported application request: Supabase counts and canonical-site ping succeed; external sources are `not_connected`, not fabricated zero. Compare stored counts to independent SQL (`k1c-verify.sql`). A test session or a reviewed isolated UI path is required; synthetic tests alone are not hosted acceptance.
6. After sandbox proof and Talip’s release decision, deploy identically: `supabase functions deploy ops-collect --project-ref khgczybubufouraqyrcj --use-api`. Production may leave `OPS_PROJECT_REF` unset (existing Production default) or set it to its own ref. Recheck the hosted JWT switch and authorization before an authorized collect.
7. Talip merges #53 separately; Cloudflare publishes the frontend automatically. Codex verifies the exact live `/staff/ops` acceptance and stops at closure.

## Names only, never values

Supabase-provided runtime bindings: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Configuration: `OPS_PROJECT_REF`; optional local-only `OPS_ALLOW_LOCALHOST` remains unset hosted. First release requires **no external provider key**. Leave these unconfigured for initial acceptance: `KLAVIYO_OPS_READ_KEY`, `KLAVIYO_CONVERSION_METRIC_ID`, `GOOGLE_PLACES_API_KEY`, `GA4_SERVICE_ACCOUNT_JSON`, `GA4_ACCESS_TOKEN`, `GA4_PROPERTY_ID`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_CUSTOMER_ID`, `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_API_VERSION`, `META_RESULT_ACTION_TYPE`, `CLOVER_OPS_READ_TOKEN`, `CLOVER_MERCHANT_ID`, `CLOVER_OPS_API_ENABLED`.

## Current hosted observation and limits

Production Edge Functions list was read without mutation: it shows **Deploy your first Edge Function**; `ops-collect` does not exist. Thus hosted `verify_jwt=true` is **not yet verified**. The repository setting does not prove deployment. No provider credentials, scheduler or messaging action is needed or enabled by this delivery. Existing Ops guards/source IDs are inherited; multi-tenant completion remains deferred.

Official references: [deployment](https://supabase.com/docs/guides/functions/deploy), [JWT configuration](https://supabase.com/docs/guides/functions/function-configuration), [runtime bindings](https://supabase.com/docs/guides/functions/secrets).
