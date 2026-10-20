# Sandbox recovery: explicit offline review and bounded local readback

These preparation tools never reset a hosted database, contact a remote service,
copy production rows or recreate a real staff/Auth identity. Actual execution
requires a successful immutable sandbox capture; no fixture result is K3 proof.

## Review the actual capture

Use the configured sandbox project ref as an argument, never a new source constant.
Keep every file below the private `K3_kanit/sandbox-recovery` directory, outside Git.

```text
python tools/test-env/review-sandbox-recovery.py --capture-dir <actual-capture> --expected-project-ref <sandbox-ref> --create-template
```

Copy `sandbox-review-template.json` to a separate completed review filename.
Privately review every TOC entry and give an explicit reason for inclusion or
exclusion. Review core privacy, grants, policies and SECURITY DEFINER search_path;
preserve application core default ACLs. Platform/schema data entries cannot be
included. Both recovery tables must be selected.

The separate `recovery_review` flags require genuine review of all four complete
order records, anonymous staff metadata and all included executable definitions
for external I/O. Marker/email classification alone is insufficient. Missing
dependencies must stop restoration; do not invent platform functions or modify
the historical schema to force a pass.
The external-I/O flag is a manual code review attestation, not an operating-system
egress firewall or a proof of network isolation for arbitrary captured code.

```text
python tools/test-env/review-sandbox-recovery.py --capture-dir <actual-capture> --expected-project-ref <sandbox-ref> --render-review <completed-review.json> --pg-bin <trusted-native-pg-bin>
python tools/test-env/review-sandbox-recovery.py --validate-rendered <reviewed-directory> --expected-project-ref <sandbox-ref>
```

Rendering calls `pg_restore` with a file target and the exact reviewed TOC, never
a database. Original capture files, including pending-review proof and manifest,
remain unchanged. The new `derived-recovery/` package contains exact original
order/staff bytes, reviewed schema and separately updated review attestations.
The proof binds source capture, review, TOC, schema and every derived artifact hash.
The existing recovery validator validates this derived package before any server
can start.

## Bounded native local restore

```text
pwsh -NoProfile -File tools/test-env/restore-sandbox-recovery-local.ps1 -ReviewedDirectory <reviewed-directory> -ExpectedProjectRef <sandbox-ref> -ValidateOnly
pwsh -NoProfile -File tools/test-env/restore-sandbox-recovery-local.ps1 -ReviewedDirectory <reviewed-directory> -ExpectedProjectRef <sandbox-ref>
```

`-ValidateOnly` reads provenance and runs offline validators only. Executing form
requires the existing owned PostgreSQL 18 cluster, matching ownership marker and
free endpoint `127.0.0.1:55473`. It creates a uniquely named database. There is no
DROP/reset or cluster initialization. An occupied endpoint or different directory
is refused. Inherited PG settings are removed; host, port and database are fixed
for every native invocation. The owned server is stopped and checked in `finally`.

The minimal empty Auth fixture supplies only `auth.users(id)`, `auth.uid()` and
standard local roles. It has no users, credentials or real JWT validation. The
anonymous staff record is validated as metadata but never inserted: no actual or
invented Auth identity is reconstructed. A later hosted application-only reset
must preserve Auth and privately relink the known existing principal.

Order bytes are base64 encoded without parsing them in PowerShell or JavaScript.
PostgreSQL decodes the exact document and binds its JSON value through
`EXECUTE ... USING`, inserts exactly four rows into an empty destination, and
checks the source includes every original column. Identity values are preserved;
generated columns are recomputed and compared in the full-column readback.
Original reviewed triggers are retained. Failure or a changed result is an error,
with no retry, repair, trigger disabling or invented value.

Full-column PostgreSQL JSON is written privately and compared by the Node 24+
exact-number validator. Large integers and decimals are never rounded by a client
JSON round-trip. An original/reviewed hash check runs again afterward. Reports
include success flags and hashes, not row contents or staff identity. Raw errors,
readback and table/security inventory remain private. Security-contract comparison
against the reviewed source is separate; a matching readback does not prove
hosted Auth/REST or authorize the conditional remote reset.

## Isolated tests

`tests/test_sandbox_recovery_review.py` uses synthetic files and mocked file-only
rendering. `tests/testEnvSandboxRestore.test.mjs` parses PowerShell without running
its body, and executes only the literal insertion SQL in a temporary in-memory
PGlite database. It covers exact numbers, inert SQL-like text, column loss/addition,
destination/count guards and generated/identity columns. No native service or
owned cluster is opened by these tests.
