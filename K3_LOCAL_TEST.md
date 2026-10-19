# K3 native local probe

Single-tenant Nazar LOCAL LEGACY COMPATIBILITY FIXTURE only. This is not a real Supabase/Auth/JWT installation or staging acceptance.

The probe uses only Scoop PostgreSQL 18, 127.0.0.1:55473 and workspace/tmp/k3-postgres-data. It refuses other paths/ports, occupied ports and unowned existing data directories. An adjacent ownership marker is required. The server is stopped in finally; files are retained and never deleted. Each run uses a unique synthetic database.

Historical foundation source: workspace/03_Nazar_Supabase_Kurulum/01_KURULUM.sql. Its human confirmation placeholder is supplied ONLY in an in-memory string on local psql stdin. The source bytes are unchanged. Legacy installation metadata is explicitly simulated, not proof of actual project identity. Before schema execution the probe verifies server address, port, data directory, database and local bootstrap role.

Auth roles, auth.users and auth.uid() are synthetic compatibility fixtures. The claim GUC is not a signed/validated JWT. No GoTrue, PostgREST, Storage service, real customer data, email, cloud API, production credentials or Docker is used.

The candidate chain contains 17 incremental files plus foundation (18 total). Emergency intake pause is deliberately excluded. The first actual SQL/guard/hash error stops replay; no function guard is changed. Narrow privilege observations after that do not resume or repair the replay.

    pwsh -NoProfile -File tools/test-env/probe-local.ps1 -ValidateOnly
    node --test tests/testEnvLocalProbe.test.mjs
    pwsh -NoProfile -File tools/test-env/probe-local.ps1

Run the last command only with normal approval for these owned local files/processes.
Evidence: workspace/20_Yonetim/Teslim_Raporlari/K3_kanit/native_<runid>/.
Exit 1 = first SQL migration failure recorded. Exit 2 = setup/cleanup/source-preservation failure.
Always inspect metadata_simulated, observed_local_identity, first_failure and server_stopped. A native compatibility result must not be relabeled as a connected cloud staging project.

## Recorded native observation — 19 October 2026

Authoritative compatibility run: native_20261019_150059_58ddf4ca (separate JSON step logs and probe-summary.json under K3_kanit).
PostgreSQL 18.6 started on the verified owned loopback endpoint and stopped in finally. Historical foundation and the first 14 incremental files applied. The fifteenth incremental, 20261016_catering_assignee_whitespace.sql, stopped at its unchanged function-hash guard: actual raw MD5 414f2b198d9ff7862e76329a0fd05d04, expected 6964b069513cb32409e80319ce490131. The queue and note-author increments were not attempted afterward. A hash mismatch alone does not establish a semantic SQL difference; the guard was not bypassed.

The narrow privilege observations confirmed anonymous direct-table denial, authenticated nonstaff overview denial, and submit_signup execution denied to anon/authenticated but granted to service_role. These are native PostgreSQL role checks with the explicit synthetic Auth compatibility fixture; they are not signed-JWT or hosted Supabase tests. Original SQL byte hashes matched after execution. Earlier retained run directories record local runner setup/transport repairs, not additional migration acceptance results.