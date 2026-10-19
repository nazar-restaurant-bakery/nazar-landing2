# K3 — single synthetic business, seed and reset

Only the configured synthetic `Nazar-test` business is in scope. IDs come from `TEST_BUSINESS_ID`; this tool does not choose a production or cloud-project identity. Existing source identifiers are unchanged.

Generate the seed with one command after setting `TEST_BUSINESS_ID` in the operator session:

```powershell
node tools/test-env/generate-seed.mjs <new-local-output.sql>
```

The output contains one test business, three synthetic customers (`subscribed`, `not_subscribed`, `unsubscribed`), three signups, one catering request and one inactive offer. All rows have `is_test=true`; emails use `example.invalid`, phone is null, names are INTERNAL TEST. No real records or provider credentials are read. The subscribed case is only a synthetic database state; it grants no real marketing consent.

The loader is transactional and refuses absent boolean test-marker columns before the first INSERT. `supabase/migrations/20261019000100_test_record_markers.sql` explicitly adds markers to businesses/customers/offers; signups/catering markers already come from the existing migration. This additive SQL has not been applied to production or a hosted test project. It requires the reviewed full baseline first.

After the selected test target is independently verified, a PostgreSQL operator session must set `app.k3_test_environment=isolated-test` before executing the generated seed. This session flag is a human checkpoint, not proof of server identity; never use it to excuse an unverified connection. An existing non-fixture business row is never renamed or retagged by the loader: it refuses the collision. The reviewed test baseline must create/identify Nazar-test explicitly before reusing an existing business UUID. No seed is loaded by the generator itself.

Local reset entry point:

```powershell
pwsh -NoProfile -File tools/test-env/reset-local.ps1 -ValidateOnly
pwsh -NoProfile -File tools/test-env/reset-local.ps1
```

It fails closed while the canonical baseline/full replay is unverified. It uses explicit `--local` and cannot reset a remote/linked project. It never runs the generator or claims a successful cloud reset. A hosted reset is not supplied until the new project identity and a reviewed canonical migration chain exist; generic `db reset --linked` instructions would risk the wrong environment.

Migration rule: **test first, production later**. Keep the reviewed SQL bytes/checksums in version control, apply to the isolated project, record the successful replay and Preview write, then use those same reviewed files in a separate Talip-controlled production release. Do not use emergency pause, test fixture SQL or an unmerged Ops migration as an ordinary deployment migration. Do not mark a baseline applied in production or run migration repair in K3.
