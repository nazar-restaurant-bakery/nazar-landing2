# K3 — single synthetic business, seed and reset

Only the configured synthetic `Nazar-test` business is in scope. IDs come from `TEST_BUSINESS_ID`; this tool does not choose a production or cloud-project identity. Existing source identifiers are unchanged.

Generate the seed with one command after setting `TEST_BUSINESS_ID` in the operator session:

```powershell
node tools/test-env/generate-seed.mjs <new-local-output.sql>
```

The output contains one test business, three synthetic customers (`subscribed`, `not_subscribed`, `unsubscribed`), three signups, one catering request and one inactive offer. All rows have `is_test=true`; emails use `example.invalid`, phone is null, names are INTERNAL TEST. No real records or provider credentials are read. The subscribed case is only a synthetic database state; it grants no real marketing consent.

The loader is transactional and refuses absent boolean test-marker columns before the first INSERT. `supabase/migrations/20261019000100_test_record_markers.sql` explicitly adds markers to businesses/customers/offers; signups/catering markers already come from the existing migration. This additive SQL has not been applied to production or a hosted test project. It requires the reviewed full baseline first.

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

It fails closed while the canonical baseline/full replay is unverified. It uses explicit `--local` and cannot reset a remote/linked project. It never runs the generator or claims a successful cloud reset. A hosted reset is not supplied until the new project identity and a reviewed canonical migration chain exist; generic `db reset --linked` instructions would risk the wrong environment.

Migration rule: **test first, production later**. Keep the reviewed SQL bytes/checksums in version control, apply to the isolated project, record the successful replay and Preview write, then use those same reviewed files in a separate Talip-controlled production release. Do not use emergency pause, test fixture SQL or an unmerged Ops migration as an ordinary deployment migration. Do not mark a baseline applied in production or run migration repair in K3.
