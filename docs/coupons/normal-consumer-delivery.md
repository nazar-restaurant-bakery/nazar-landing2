# Normal Welcome consumer - Draft source delivery

Base main: `b232a6cc8ac496eb7515e6232084ebcc8a098610`. Source and synthetic tests only; runtime/DB settings remain OFF. No hosted SQL, deploy, flags, keys, cron execution, real event, email or new participant test was performed.

- Added HMAC-only Edge entry, durable per-business lease and pre-HTTP coupon attempt, bounded normal dispatch and receipt consumer. No automatic retry after uncertain HTTP/ACK/crash. Receipt backoff never requeues a send or changes immutable K6 history.
- New SQL sources stay in `tools/test-env/welcome-automation/`, outside canonical migrations. Root must review/assign the sequence before any application. Existing migration bytes and bootstrap/K6 function definitions are unchanged. The separate cron/Vault candidate prepares an inactive job with no target or secret seed.
- `supabase/config.toml` explicitly sets `coupon-welcome-run.verify_jwt=false`; mandatory purpose-bound HMAC, 60-second freshness, exact business and durable UUID replay gate replace gateway user-JWT authentication. Default OFF returns before DB/network. Exact target/headers/canonical form and environment NAMES are in [contract](normal-consumer-contract.md).
- Existing normal Pages entry now shares an initial/inter-read 4.2-second Accounts pacer within its own request instance. Bootstrap code/pacing and public forms, staff, GA4 and frontend sources stay unchanged. This is not a global cross-isolate/account quota.

Validation: **326/326 total, zero skips**: 25/25 closed cron/native-facade + canonical HMAC tests, 282/282 targeted unit/workerd regressions, 19/19 native PostgreSQL 18.6 cases. Native cases include two-session run/claim races, expiry, unknown response recovery, K6 167/168/169-hour prefilter, future/ended campaign, test flags and scoped status. One integrated workerd case executes consumer -> actual normal Pages route/shared pacer -> native SQL/K6 -> synthetic provider 202 -> exact receipt; one event, no bootstrap, one receipt, K6 unknown byte-identical. TypeScript and targeted ESLint pass. Production-mode baseline/candidate builds have 213/213 byte-identical files with APP_ENV and TEST variables absent and only synthetic public keys. Logs and parity JSON: [evidence](normal-consumer-evidence/production-parity.json).

Remaining hosted acceptance: reviewed migration sequence and exact bytes; target-specific extension/Vault setup; inactive cron/gateway deploy verification; explicit decision to enable. pg_net can follow redirects: only the exact Edge URL receives an ephemeral business/run/time HMAC, never static credentials or participant/coupon content. Static-credential DB/Pages/provider transports remain no-follow. Local cron/net/Vault facades do not prove actual hosted queue/transport behavior. No hosted acceptance or global automation completion is claimed.

Candidate SQL SHA256 (LF, no BOM):

- `tools/test-env/welcome-automation/forward-candidate.sql`: `54240ba1d4e6efe2e778c94efbb3a4ced92ca0e3a66cf5d30d7f62d7307dc842`
- `tools/test-env/welcome-automation/cron-candidate.sql`: `6b7bc4e3e8d8e7e6d09476d90906f14d2caa9039787c359660555a2704887548`

Final source SHA values and the last LF cron test proof are frozen in [validation summary](normal-consumer-evidence/validation-summary.json). Earlier CRLF proof hashes were not reused. Root reports Production PostgreSQL 17.6, pg_cron 1.6.4 and pg_net 0.20.4 available but NOT installed; this is not installation-ready. See [prerequisite recipe](normal-consumer-extension-prerequisites.md), review only. Local PG18.6 is not claimed to be exact hosted-server parity.
