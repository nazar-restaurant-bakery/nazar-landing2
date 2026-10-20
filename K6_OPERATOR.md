# K6 — human-operated migration package

Preparation only. This package has not prompted for a real password, opened a credential window or applied hosted SQL. Ops (order 3) and K7 (order 4) must already be installed in the selected target before K6. Their reviewed LF source hashes are pinned; the operator never installs those dependencies or invents Supabase migration-history entries.

## Files and prerequisites

- `tools/test-env/k6-run.ps1`: PowerShell 7 single-command launcher. Local validation precedes the masked human prompt; `-ValidateOnly` never prompts.
- `tools/test-env/k6-migrate.py`: backend with read-only dependency/target preflight, frozen SQL, bounded psql processes and durable attempt/success/failure receipts. It reuses reviewed pure helpers from the unchanged `k5-migrate.py`, whose source hash is pinned.
- `tools/test-env/k6-operator.example.json`: inert placeholders only. Root prepares a real **non-secret local config**, outside Git, using reviewed file paths/hashes and target settings. The final reviewed K6 migration hash must be frozen in the backend before it can run.
- Migration: `supabase/migrations/20261020000800_message_send_gate.sql`. Acceptance: `tools/test-env/k6-acceptance.sql`, synthetic fixtures inside `BEGIN` / `ROLLBACK` only.
- Same reviewed **psql 18.6** executable, Python executable and TLS CA, each SHA256-pinned. Direct host must be exactly `db.<configured project ref>.supabase.co`, port 5432, user `postgres`, database `postgres`, TLS `verify-full`. No automatic pooler fallback, DNS loop or retry.

The config contains no database password, key or customer content. Test and Production refs must be distinct. Source IDs come from reviewed configuration; no restaurant ID is introduced by the operator. Do not copy secret environment files into this config.

`dependency_sources` must contain orders 3 and 4, in that order, with the reviewed Ops/K7 SQL file paths and registered hashes. `dependency_evidence` may retain hashes of actual existing evidence in its original format; no fabricated success-receipt format is imposed. Read-only preflight independently requires the actual Ops/K7 tables, K7 signatures, RLS, closed core, K4/K5 guards and an absent K6 installation. This proves object/signature presence; it does **not** claim byte-for-byte hosted function-body parity with those source files.

## Test first — Talip only, after separate release authorization

Use an absolute local config path and a new empty receipt directory. This readiness command has no prompt or DB connection; it may run only the pinned executable's `--version` check:

```powershell
pwsh -NoProfile -File .\tools\test-env\k6-run.ps1 -Config '<absolute reviewed test config>' -Target test -ValidateOnly
```

When the prerequisite installations and release are approved, the single operator command is:

```powershell
pwsh -NoProfile -File .\tools\test-env\k6-run.ps1 -Config '<absolute reviewed test config>' -Target test -ConfirmTarget
```

The console shows the project, ref, Direct host and migration SHA256. Talip enters that project's **database password**, masked. It is separate from staff login, Supabase web login and archive password. Enter starts this one operation. The UTF-8 private stdin pipe preserves symbols and Unicode without shell/URL escaping; the value is never placed in command arguments, a config/receipt file or the parent environment. Only the psql child receives ephemeral `PGPASSWORD`; inherited libpq settings are removed. Raw SQL errors and stderr are never printed or stored.

The operator claims an exclusive attempt before connecting, checks the selected target in a read-only transaction, applies the exact frozen LF SQL using `-X --no-password --set=ON_ERROR_STOP=1`, then runs rollback-only acceptance in Test. A failure after commit is not marked successful. Process calls have a 120-second limit and the operation a 300-second budget. A successful TEST receipt binds project/business, observed preflight, SQL/acceptance hashes, tool/support/launcher/CA hashes and all successful acceptance checks.

## Production — separate human release

No Production release is authorized by this package. A later Production config must select a fresh receipt directory and pin the existing successful K6 TEST receipt through `test_success_path` / `test_success_sha256`. Production requires the identical migration and acceptance bytes, psql/Python/CA/operator/launcher/support, matching test business/ref and successful test preflight/acceptance. The actual Production Ops/K7 dependency catalogue must also pass. The explicit later command additionally needs `-AllowProduction`:

```powershell
pwsh -NoProfile -File .\tools\test-env\k6-run.ps1 -Config '<absolute reviewed production config>' -Target production -AllowProduction -ConfirmTarget
```

Production does not run synthetic acceptance or enable the gate. No provider request or email is performed by either command.

K6 RPCs require READ COMMITTED. The preflight verifies the current psql session's default isolation and stops before DDL if it differs; the operator never changes the database or role default.

## Stop and evidence

Keep the whole receipt directory, including frozen SQL and the last attempt phase. Never rerun after a stopped, timed-out or lost-result attempt. Root first reviews the fixed error code/phase and performs a separately authorized read-only readback. A new directory is not an automatic retry permission. Existing receipts are never deleted or overwritten to bypass this stop.

Operator tests use inert executables and mocked psql only. Wrapper tests use a fake backend and a mocked masked prompt, including a Unicode/symbol fixture; no real prompt, credential or account is used. Run locally:

```powershell
<reviewed Python executable> -m unittest discover -s tests -p test_k6_operator.py -v
```
