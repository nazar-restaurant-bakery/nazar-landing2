# K4 — suppression, consent evidence and staff offer catalogue

Test first. Production application is performed by Talip. Login, passwords,
email verification and account operations are performed only by Talip.

## Identical migration tool and bytes

Use `tools/test-env/k4-migrate.py` in both environments. It runs **psql 18.6**
(`-X --set=ON_ERROR_STOP=1 --file`), requires TLS `verify-full`, and pins the
binary, reviewed LF SQL and CA hashes. The runtime config contains paths,
separate project refs and hashes; no password. Project refs are not embedded in
source. Talip enters the selected project's existing **database password** in
the masked window and starts the run. No login or retry is automated.

Migration: `supabase/migrations/20261019000200_suppression_consent_offers.sql`.
Do not use SQL Editor to paste it, normalize its line endings or edit a deployed
migration. An exclusive durable attempt record prevents silent retry after a
timeout, window close or lost response. Freeze copies are created before the
first connection. An ambiguous result requires independent readback and a
reviewed follow-up, never deletion of the attempt marker to blindly retry.
The production runner requires a successful test receipt for the same exact
migration, acceptance source, psql version and executable hash.

If a human-started Production run stopped **before DDL**, a reviewed continuation
is available only through `--reviewed-preflight-continuation <absolute-review.json>`.
Normal repeat remains blocked. The review pins the original attempt/failure,
credential-free restricted-DNS/approved-network diagnosis, and a fresh read-only
Production inventory proving every K4 object absent. The old records remain
untouched; a separate exclusive followup marker permits one human-started attempt.
It cannot continue an ambiguous migration-submission or committed phase. The
launcher must run with the verified network access; Talip still enters the
Production database password and starts the migration. Safe psql error categories
are shown without raw server output or credential values.

## What the migration does

- A trigger guards every exit from `unsubscribed` and clearing/backdating its
  suppression timestamp. A customer-supplied GUC does not grant an exception.
- `public.crm_restore_email_consent_v1(customer_id, customer_requested_at,
  evidence_source, evidence_reference, evidence_sha256, customer_initiated,
  staff_approved)` is authenticated, active-staff only. The requester must have
  made a new request after the latest suppression and before approval. Sources:
  `customer_email`, `customer_web`, `customer_in_person`,
  `customer_signed_document`. No additional expiry policy is introduced.
- The function locks the customer, derives approving staff from Auth, records
  an immutable consent event and detailed artifact reference/hash, consumes a
  private one-use transaction capability and updates local consent atomically.
  It returns the event UUID. There is no automatic provider unblock or send.
- Existing `core.suppress_email(text,text)` keeps its signature and ACL. Its
  suppression boundary uses wall-clock time, so multiple changes within one
  transaction cannot reuse consent older than the latest block. The entry
  trigger also protects delayed negative Klaviyo observations.
- Existing request/suppression events and new evidence are append-only. Core
  remains outside Data API access and new private tables have RLS.
- `public.list_offers(p_business_id uuid)` is authenticated active-staff only,
  returns all offers with `active` and `offer_status`, and computes status from
  the business timezone. Anonymous `get_active_offers` is unchanged.

The DB checks structured evidence and an authorized staff assertion. Staff must
verify the actual customer-origin artifact; a hash/reference alone cannot prove
its truth. A trusted DB administrator can redefine enforcement objects. The
existing single-business authorization scope is retained.

## Test and UI proof

The exact `tools/test-env/k4-acceptance.sql` runs in a transaction against a
synthetic-only business and existing test staff, emits aggregate checks, and
**ROLLBACKs** fixtures. No Auth user/account is created or changed. Simulated
JWT claims test SQL authorization; they do not claim a fresh HTTP login.
Identity-only Clover/till ingestion is tested as an upsert contract plus the
existing unconsented form path. A live Clover ingestion adapter/order schema
is not implemented or claimed by K4.

`/staff/offers` uses only Auth and the staff authorization/list RPCs. It shows
live, scheduled, ended and inactive offers together, handles denial and
unavailable data separately from empty data, and offers no edit/publish action.
The old `/staff` provider guard remains intact. PR52/53 are held; their later
rebase can reuse `StaffOffersPanel`/`loadStaffOffers` instead of public offers.

Local verification:

```powershell
$env:PGLITE_MODULE = '<file URL of installed isolated PGlite runtime>'
node --test --test-concurrency=1 tests/*.test.mjs
python -m unittest discover -s tests -p test_k4_migrate.py
```

The local PGlite fixture runs the literal baseline/migration/acceptance SQL.
Hosted psql application and an authorized Offers UI read remain separate proof.
After a successful test application, Talip applies the **same** migration to
production with the same runner. That final receipt is required for K4 closure.

No welcome task, Klaviyo write, order table, production secret change or merge
is part of this delivery. K3's old reset compiler is not extended to silently
apply K4; inventory records K4 separately as reviewed additive SQL.
