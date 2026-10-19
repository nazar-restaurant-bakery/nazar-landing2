# K3 — single synthetic business, seed and reset

Only the configured synthetic `Nazar-test` business is in scope. IDs come from `TEST_BUSINESS_ID`; this tool does not choose a production or cloud-project identity. Existing source identifiers are unchanged.

Generate the seed with one command after setting `TEST_BUSINESS_ID` in the operator session:

```powershell
node tools/test-env/generate-seed.mjs <new-local-output.sql>
```

The output contains one test business, three synthetic customers (`subscribed`, `not_subscribed`, `unsubscribed`), three signups, one catering request and one inactive offer. All rows have `is_test=true`; emails use `example.invalid`, phone is null, names are INTERNAL TEST. No real records or provider credentials are read. The subscribed case is only a synthetic database state; it grants no real marketing consent.

The loader is transactional and refuses absent boolean test-marker columns before the first INSERT. `supabase/migrations/20261019000100_test_record_markers.sql` explicitly adds markers to businesses/customers/offers; signups/catering markers already come from the existing migration. The hosted installer requires the reviewed full baseline first and includes the marker body in its transaction. K3 does not apply this SQL to production; actual test-target execution must be established by the dated installer receipt and independent readback.

`renderSeedSql(fixture)` still emits its own `BEGIN`/`COMMIT`; omitting options or
passing `{ transactional: true }` preserves that default. A caller that already
owns an outer transaction may explicitly use
`renderSeedSql(fixture, { transactional: false })`. This removes only the seed's
outer transaction commands; prerequisites, collision guard and every test flag
remain intact. The option accepts only a boolean; strings such as `"false"`,
numbers and null are rejected. The caller must start and retain the transaction;
this option alone does not verify a hosted target or authorize execution.

**The marker additive SQL contains its own `BEGIN`/`COMMIT`. Do not blindly
nest it inside an outer installer transaction:** its `COMMIT` would commit the
caller's transaction. The separately reviewed hosted compiler below unwraps only
that file's exact pinned hash and known wrapper. The seed regression also proves
all nine unwrapped seed rows disappear on rollback while pre-existing synthetic
Auth/storage fixture rows and managed schemas stay.

Customer `identity_key` uses the unchanged application RPC convention
`email:<normalized-email>`. The generator and validator must agree with that rule;
adding a business prefix would make the later form create a duplicate customer.
The configured business UUID must be compatible with the existing reviewed
baseline; this preparation does not change its historical business guard.

For the eventual Preview write proof, select one reserved-email identity from
this freshly generated seed and record its customer ID and aggregate before-counts
privately. Use that same identity in the single synthetic form submission. Verify
the existing customer is reused and remains `is_test=true`, one request key and
one additional test signup are recorded, and an exact repeated request adds no
second signup. Every seeded identity already has one signup, so the expected
same-email signup count becomes two, not one. Production must still have zero
matches for this request and synthetic identity. A fresh unseeded identity is not
interchangeable: the unchanged RPC marks its signup/catering request through test
classification, but the newly added customer marker defaults to false. Do not
claim all its records are marked without a separately verified test-only action.

The seed regression test executes the actual reviewed SQL baseline, marker
additive, generated seed and existing idempotent signup RPC in an in-memory
PostgreSQL-compatible fixture. Only psql client restrict/unrestrict directives
are removed for that SQL-only fixture. It does not establish a hosted reset,
real Auth/JWT behavior, Preview deployment or production write proof.

After the selected test target is independently verified, a PostgreSQL operator session must set `app.k3_test_environment=isolated-test` before executing the generated seed. This session flag is a human checkpoint, not proof of server identity; never use it to excuse an unverified connection. An existing non-fixture business row is never renamed or retagged by the loader: it refuses the collision. The reviewed test baseline must create/identify Nazar-test explicitly before reusing an existing business UUID. No seed is loaded by the generator itself.

Local reset entry point:

```powershell
pwsh -NoProfile -File tools/test-env/reset-local.ps1 -ValidateOnly
pwsh -NoProfile -File tools/test-env/reset-local.ps1
```

The historical local entry point remains deliberately blocked; it must not be used to replay the old migration chain. It uses explicit `--local` and cannot reset a remote/linked project. It never runs the generator or claims a successful cloud reset. Do not use generic `db reset --linked` commands.

## Gated hosted application reset

`tools/test-env/verify-hosted-reset-gates.mjs` checks the actual private capture,
review, exact local recovery readback, production/local privileges, current health
and manual Pages/Clover disconnection evidence. Status flags alone cannot pass.
This verifier is offline and does not authorize or execute a reset.

`tools/test-env/hosted-reset-plan.mjs` compiles the bounded installer offline. Its
private config extends the gate spec with `phase` (`legacy_sandbox` first,
`reviewed_baseline` for repeat), explicit `staffRole`, `testBusinessId`, current
read-only sandbox metadata and provider Data API schema evidence. Project refs
are supplied only in private environment/config files. The test ref must differ
from the existing production guard. A repeat also needs the real prior committed
installation receipt; a claimed status is insufficient.

```powershell
node tools/test-env/hosted-reset-plan.mjs --config <private-config.json> --output <new-private-plan.json>
node tools/test-env/hosted-reset-plan.mjs --validate-plan <private-plan.json>
```

The installer locks and checks an exact application allowlist and row counts
before dropping anything. Drops use `RESTRICT`, never `CASCADE`; Auth, storage,
extensions, the public schema and managed helper are preserved. The existing
staff Auth link and active flag stay in a private transaction-local TEMP table,
are restored with the configured role, and never enter a file or log. The
baseline, bounded marker body and nine synthetic rows run in one transaction.
Unexpected privileges, schema drift or postflight mismatch fail the transaction;
there is no automatic privilege repair. The source baseline and historical SQL
files/checksums are unchanged.

`tools/test-env/hosted-reset-operator.py --validate-config` is local only.
`--gui` opens a masked password window. Required operator variables are
`K3_SANDBOX_PROJECT_REF`, `K3_PRODUCTION_PROJECT_REF`, `K3_SANDBOX_HOST`,
`K3_SANDBOX_PORT`, `K3_SANDBOX_USER`, `K3_SANDBOX_DATABASE`,
`K3_SANDBOX_SSLROOTCERT`, `K3_PG_BIN`, `K3_NODE`, `K3_RESET_PLAN`,
`K3_RESET_PRIVATE_ROOT`, and `K3_STAFF_ROLE`. Use the verified session pooler,
port 5432, database postgres, ref-bound username and TLS `verify-full`.

Talip enters only the sandbox database password in that local window, first
runs read-only inspection, then checks the displayed target and starts the
application reset. The password is held only in window/child-process memory
for at most ten minutes between inspection and submission, never in arguments,
files or logs. A consumed plan cannot automatically run twice. A lost or
unusable acknowledgement means outcome unknown; reconcile read-only before
any new attempt. An accepted SQL receipt is not real Auth/REST acceptance,
Preview write proof or K3 closure; those remain separate checks.

After installation, [tools/test-env/inspect-installed-readonly.sql](tools/test-env/inspect-installed-readonly.sql)
observes aggregate application/test-marker counts, catalogue hashes, function
privileges, RLS and the preserved staff/Auth link without exporting its identity.
It is read-only and does not replace a real HTTP/Auth check. Use the
[existing-account Auth / REST helper](K3_AUTH_REST.md) for that separate test:
Talip enters the existing preserved sandbox staff Email and Auth password only
in its local window. Its private config contains no login credentials, database
password or secret API key. No new Auth account or staff permission is created.
Only a successful real hosted receipt can establish that check; local validation
and mock tests do not. The single Preview submission and production-zero proof
described above remain separately required.

Migration rule: **test first, production later**. Keep the reviewed SQL bytes/checksums in version control, apply to the isolated project, record the successful replay and Preview write, then use those same reviewed files in a separate Talip-controlled production release. Do not use emergency pause, test fixture SQL or an unmerged Ops migration as an ordinary deployment migration. Do not mark a baseline applied in production or run migration repair in K3.

## SQL transport and exact definition checks

Use the target-bound native operator for the ordinary repeat procedure. Do not
paste the raw Windows dump into SQL Editor as an interchangeable transport.
The K3 hosted repeat exposed a concrete difference: the native installation
stored LF function bodies, while SQL Editor retained CRLF from the same dump.
Independent read-only comparison proved that changing only those body line
endings reproduced the original definition MD5 for all 32 functions. Effective
permissions and application rows were unaffected by that transport difference.

The reviewed dump and historical migration guards stay unchanged. Never relax
an MD5 guard or declare a changed definition accepted by comparing only tokens.
Reconcile the actual catalog first. Any explicitly reviewed function-only
transport repair must bind the observed before-catalog and require the exact
original after-catalog, preserve function identity/owner/configuration/ACL and
staff/platform state in one transaction, and roll back on any mismatch. Keep
its execution receipt and independent final readback separately from the
original reset receipt. A local transport fixture alone cannot close hosted
acceptance.
