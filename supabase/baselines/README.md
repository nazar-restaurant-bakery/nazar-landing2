# Reviewed application baseline — 19 October 2026

`20261019_application_schema.sql` is an explicitly reviewed schema-only export of
the existing production application, not a replay or modification of legacy SQL.
It is outside `supabase/migrations/` and is not automatically applied by this PR.
No hosted reset, production migration or migration-history repair has occurred.

SHA-256 of the exact SQL bytes:
`f3583bb461ba8ae50dea04ae03d6c5c4dbe729aacdec1ed7dd57982b7e25d230`.
The directory's attributes preserve these reviewed bytes in Git, treating native
function-body CRLF and the dump's final blank line as generated formatting. Use a PostgreSQL
18+ `psql` client for the dump's `\restrict`/`\unrestrict` directives; do not paste
the client directives into a database-only SQL execution API.

The source was PostgreSQL 17.6, captured read-only with `pg_dump` 18.6 and verified
TLS. Production row data was not exported. The private archive/manifest, explicit
entry-by-entry review, original hashes and raw evidence remain outside Git.
The reviewed archive SHA-256 is
`5d595d3fbb5130f13a74d170b6ba486ccabc4b46141ca3bb1000ee3f09e32aed`.

Of 159 schema entries, 149 application entries were retained: 16 core tables,
2 reporting views, 32 application functions, their constraints/indexes/triggers,
per-function ACLs and enabled RLS. Ten managed public namespace/comment/ACL,
`rls_auto_enable` and public/platform default-ACL entries were excluded. There
were no core default ACL entries in this capture. Existing business constants
were retained unchanged; this does not add a new runtime target or project ref.

An actual new owned local PostgreSQL 18 database restored this baseline. Its
32 function signatures and effective EXECUTE privileges for `anon`,
`authenticated` and `service_role`, role attributes and private-core USAGE matched
a separate live read-only source metadata query. All 16 table RLS flags remained
enabled; all 32 application function search paths remained empty. Local Auth is
an empty compatibility fixture, not a hosted Auth/JWT/REST acceptance test.

Hosted installation remains gated by verified sandbox recovery, health evidence,
Talip's disconnection of the old sandbox Pages/Clover integration and this reviewed
baseline. Preserve Supabase Auth/storage/extensions/platform objects. Existing
hosted default privileges can grant extra function access: compare effective
privileges after installation and fail on unexpected grants, without automatic
repair or blanket ACL removal. Test markers and synthetic data are separate
reviewed steps; never copy production rows or apply this file to production as
part of K3. Configuration/ref values belong in environment settings only.
