# K15 common dry-run write gate

Draft only. Merge and hosted setup wait for K12 closure and Talip. No provider
adapter, new secret or scheduler is included. `ops-collect` is unchanged.

The separate `ops-write` Edge Function keeps `verify_jwt=true`, validates Auth,
then calls caller-scoped preview/approve/status and execute-dry-run wrappers.
Prerequisite: shared staff contract v1 from #65. `core.staff_authorized_v1(business_id,
'ops.write')` is the only scope authority; `crm_staff` is not a fallback. Composite
creator/approver FKs reference `core.business_staff(business_id,staff_id)`. No K15
staff or platform membership table is created.

Direct claim/finalize execution is granted only to service_role, but permission
alone is insufficient: non-NULL `auth.uid()`, JWT role authenticated, matching
p_staff_id and shared ops.write scope are mandatory. The Edge keeps the original
verified user JWT (never substitutes its service key) when calling the narrow
SECURITY DEFINER dry-run wrapper. That wrapper calls claim then finalize in one
DB transaction while preserving auth claims; persisted approver and private
single-use claim token must match. No actor or JWT sub is synthesized from input. No tenant/staff is provisioned by
the migration. Each tenant's missing setting or `kill_switch=true` disables
the gate. The operator owns the configuration; no browser setting endpoint exists.

Preview SHA256 includes tenant, `dry_run`, target UUID and the canonical before/
after summary. No raw preview, profile, message or credential is stored. Five
minute expiry is anchored at preview and never extended by repeat approval.
Approval is bound to the creating staff identity. Atomic locked claim transitions
approved -> executing once and issues a private token. Finalize consumes that
token and cannot run twice. A claimed action never returns to approved. Unknown
execution/finalization results require status inspection, not automatic retry.
Changing target/hash requires a new preview and approval. The only adapter is a
local dry-run result; its only network calls are project Auth and RPC.

Future manual setup (not executed):
1. Wait for K12 closure; review/merge this PR with Talip, then refresh main.
2. Apply `20261021000500_ops_write_gate.sql`, LF, psql 18.6, migration order 11,
   sandbox before Production. Verify SHA256 against the delivery receipt.
3. In sandbox only, provision a reviewed existing core.business_staff membership from #65 and a
   settings row initially killed. Existing roles and provider keys stay unchanged.
4. Deploy the full `ops-write` bundle using existing Supabase runtime bindings;
   verify Enforce JWT Verification is on. No new secret is required.
5. With Talip's activation decision, set that tenant kill switch false; exercise
   preview -> explicit Run -> result. Unauthorized and expired/replay tests first.
6. Production uses the same ordered SQL/deploy/check process only when authorized.
   Emergency stop: set tenant `kill_switch=true`; no re-run of executing actions.

Synthetic commands:
`node --experimental-strip-types --test tests/opsWrite.test.mjs`
`python tests/opsWritePostgres.py` (fresh loopback-only PostgreSQL; never hosted)
`node --experimental-strip-types --test tests/opsWritePanel.test.mjs`

The local SQL suite uses minimal contract fixtures, not a hosted baseline copy.
It executes the actual migration and functions on PostgreSQL 18.6, including two
simultaneous authenticated dry-run executions (one succeeds), two generated tenants and all contract user types. Shared foundation fixture is pinned under tests/fixtures; test sessions are trusted synthetic claims, not a live JWT proof. Full hosted baseline
compatibility and live UI acceptance remain future sandbox checks.
