# Actual production schema: private review and bounded local proof

This preparation does not reset or write to a hosted project. It does not replace historical guards or construct a before-definition to make an old patch pass. A production schema capture must exist before a baseline can be reviewed. The earlier native historical replay remains a separate, failed compatibility experiment.

## Input and review

`capture-schema.py` writes the original schema-only archive, full rendered SQL, catalogue, TOC and their SHA-256 manifest to a unique directory beneath the workspace's `20_Yonetim/Teslim_Raporlari/K3_kanit/production-schema-private`. Do not put these private inputs or generated SQL into Git. Production row data and Auth rows are not inputs to this process.

`review-schema.py` is offline. It verifies all original capture hashes and requires mode PRODUCTION, a read-only capture and no exported data. It never connects to a database. Creating a template approves nothing:

```text
python tools/test-env/review-schema.py --capture-dir <actual-private-production-capture> --create-template
```

Codex reviews every TOC entry in a separate private copy of `baseline-review-template.json`. Each entry needs an explicit include/exclude decision and reason. Included entries must be verified application objects, including their required constraints, triggers, policies, grants and row-security settings. Set the four security review flags only after comparing the application schema and access contract: private core, function grants, policy set and SECURITY DEFINER search_path. This records the implementation review; it does not add a new user approval step.

The managed `public.rls_auto_enable` helper and its ACL/comment entries are excluded. The existing public schema, extension-owned objects, platform event triggers, row data and public/platform default ACLs are excluded. **Reviewed core application default ACLs are preserved**: application ALTER DEFAULT PRIVILEGES/REVOKE rules must not disappear through a blanket `--no-acl`. The recorded review must resolve every synthetic-ID ACL/ROW SECURITY/comment entry to the corresponding approved application object.

Only after review may offline pg_restore render a new private `reviewed_<time>/reviewed-baseline.sql` using the exact approved TOC IDs:

```text
python tools/test-env/review-schema.py --capture-dir <actual-private-production-capture> --render-review <completed-review-filename.json> --pg-bin <trusted-native-pg-bin>
python tools/test-env/review-schema.py --validate-rendered <private-reviewed-directory>
```

Rendering never supplies a database target, runs SQL, disables all ACLs, copies data, or changes the raw capture. It records source archive, capture manifest, review, selection and resulting SQL hashes. A successful render is **not** a restore result or hosted-environment acceptance.

## Local restore plan

The local proof uses only the already-owned PostgreSQL 18 cluster on `127.0.0.1:55473`, creates a uniquely named empty database, verifies the endpoint/data directory identity and executes the exact hash-validated reviewed baseline. It must preserve and stop the owned server in finally, retain its uniquely named database/evidence, and refuse another path, port, unowned directory or occupied endpoint. No DROP/reset of an existing database is needed.

`restore-reviewed-local.ps1` implements this bounded local path. It requires the actual reviewed directory and validates the complete input hash chain before starting a server. `-ValidateOnly` reads provenance and reports the plan without starting a service. Do not run the executing form until the actual capture and independent review exist:

```text
pwsh -NoProfile -File tools/test-env/restore-reviewed-local.ps1 -ReviewedDirectory <private-reviewed-directory> -ValidateOnly
pwsh -NoProfile -File tools/test-env/restore-reviewed-local.ps1 -ReviewedDirectory <private-reviewed-directory>
```

A minimal, explicitly simulated empty Auth compatibility fixture may provide `auth.users` and `auth.uid()` plus the standard local roles needed by the captured DDL. That is not a copy of Auth data, GoTrue or signed-JWT validation. Missing dependencies stop the proof; no platform functions or historical before-definitions are invented to make the restore pass.

The first SQL error stops execution. Record the original baseline hash before/after, native version, exact owned endpoint, schema inventory, grants, policies, RLS flags and SECURITY DEFINER search_path values. Compare the restored application contract with the reviewed source selection. A DDL success alone does not prove equivalent grants or policies. The core schema must remain absent from the Data API configuration in the later hosted check.

This local result cannot authorize the subsequent remote reset by itself. Sandbox recovery, private complete-row review, restore/readback validation and all other user-required preconditions remain separate evidence. No step is declared complete while an actual capture or required comparison is missing.
