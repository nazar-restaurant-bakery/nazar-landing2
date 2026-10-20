# Nazar ops-collect — deployment preparation only

This PR does **not** apply the migration, deploy an Edge Function, create a live bucket, add secrets, change an offer or campaign, upload a real CSV, or send email. Talip controls deployment and acceptance. The inherited single-business model remains. The same release is tested on the isolated project with explicit `OPS_PROJECT_REF`; Production defaults retain their existing guard. This is not multi-tenant completion.

## Execution and scope

First release is **manual only**. There is no cron, `scheduled()`, n8n, timer, or notification replay. Existing Pages `waitUntil` remains request-bound. This Edge Function uses `EdgeRuntime.waitUntil` only to finish the one action a staff user explicitly requested. The scheduler tile remains not connected; separate manual run counters and the action log describe actual ops history.

Talip's latest decision supersedes the specification's §6 “günde 1 (06:00)” requirement for this release: only **“istekle” / Şimdi topla** applies. No schedule migration, scheduler module or scheduler credential/callback route is included. Daily automatic collection requires a separate future decision. The `scheduler` source name remains only as the requested grey UI tile and aggregate manual-history labels; it cannot execute scheduled work.

The primary request is `{action, payload: {..., clientRequestId: UUID}}`. The server validates the user JWT through Auth and `crm_staff_authorized_v1`, calls the narrow `ops_request_action` with that **user** JWT, then claims the row using the service role **before** acknowledging it. The response is `{code, action: safeAction}`. An acknowledgement contains no private input, source CSV, claim token, provider key or user profile. The frontend polls only action history, not another execution request.

`{actionId: UUID}` is a recovery path for a known queued action, not automatic retry. It still checks the requesting user and performs one atomic claim. A lost internal enqueue response is recovered by exact `request_key`; no action/time guessing or second enqueue occurs. A terminal grey intent is returned immediately without claim or worker execution.

Action parameters (all also include `clientRequestId`):

| Action | Payload | Implemented behavior |
|---|---|---|
| `collect` | `{}` | Read connected sources independently, persist aggregate snapshots and source states. One failing source does not discard successful snapshots. |
| `sync_clover_csv` | `{csv,fileName,periodStart,periodEnd}` | Parse/export coverage, transactions, channels and refunds. Full closed month may persist a commission; current MTD is estimate only. |
| `retry_failed_job` | `{actionId}` | Once only, a known failed **manual collect** requested in the last 24 hours. Never replay a customer notification or unknown outbox. |
| `offer_set_active` | `{offerId,active,approvalReference?}` | Existing supported setter only; actual test flag or trusted owner-provisioned approval of current terms. No offer creation or email. |
| `commission_report` | `{month:"YYYY-MM"}` | Only a qualified full-month CSV import. Compute/persist using existing engine and produce private one-page PDF. |
| `ads_set_status` | `{source,campaignId,status}` | **Not connected.** Write adapter/target approval not implemented; read credentials never enable writes. |
| `product_set_channel` | `{productId,channel,available}` | **Not connected.** Inventory write adapter/target approval not implemented. |

Unconnected buttons can submit an empty-target intent; SQL logs `not_connected` when that capability has no verified live source/target. Connected mutations still require valid target fields. CSV upload and collect capabilities are bootstrapped without claiming an established provider connection; `connected` requires a verified snapshot. CSV state survives a later collect even while the Clover API mapping remains unapproved.

## Financial boundaries

- A source must explicitly establish export period coverage. Selecting dates in the UI is not evidence that a file is complete.
- Clover aggregate Sales Report CSV can supply sales snapshots but lacks the required channel proof, so it does not by itself authorize commission persistence.
- Normalized transaction CSV requires `export_period_start` and `export_period_end` on each row as well as order/transaction identifiers, payment/refund type, offset timestamp, channel and net product sales.
- Uber Eats/Grubhub are excluded. Unknown channels or amounts block qualified commission values. Empty fields remain unknown.
- Net sales already include refund rows, dated in the refund's own period. The existing commission engine receives `p_refunds=0`; no second deduction occurs.
- SQL independently permits persistence only for a complete calendar month whose last day is **before** today's New York date.
- A verified current-month-first through today/yesterday file may call `core.compute_commission(...,false)` and store `value_text="estimate"` snapshots. It never writes `core.commissions` and cannot produce a persisted full-month report.
- `core.compute_commission(uuid,date,numeric,numeric,boolean)` and `public.record_commission(uuid,date,numeric,numeric)` must actually exist. No invented public `compute_commission` is called. The historical engine formula is unchanged.
- A calculation is not a profit report, proof of marketing uplift, invoice, contract signature, or payment authorization.

## Database and storage

Migration: `supabase/migrations/20261020000100_ops_panel.sql`. Review and apply first in sandbox, then Production with the same LF file and psql 18.6. `core` remains unexposed; no direct table grants are added. Staff reads aggregate public RPCs and requests narrow actions. Claim, finish, source context, budget, finance, offer and reconciliation RPCs are service-role only. Every security-definer function uses an empty search path.

The spec's nullable `period_start` cannot be part of a primary key. Metrics therefore have a surrogate UUID plus a unique snapshot expression with a null sentinel. Connections use `(business_id,source)`, not a globally shared source key. Additional private tables hold only import metadata, a daily call budget, and trusted offer approvals; raw CSV is retained only in the action payload until finish/reconciliation and is never returned by staff reads.

At most **30 external requests per New York calendar day** are reserved atomically across manual runs, in addition to the per-run collector cap. Supabase's internal Auth/RPC/Storage calls are not provider polling calls. No external request occurs if reservation fails. Source targets/identity checks remain fixed or constrained to Nazar; redirects are not followed.

Private report bucket: `nazar-ops`. Object: `<businessId>/ops/commission/YYYY-MM-<actionId>.pdf`. The action ID versions reports and avoids silent overwrite. Staff may obtain a short-lived signed URL; there is no public bucket or browser upload permission. A pre-existing public bucket aborts the migration. Restrictive policies protect this namespace even if unrelated broad Storage read policies already exist.

## Trusted offer approvals

Only verified `is_test=true` offers bypass the real-offer approval list. Do not infer test status from a name. If the table does not have a test flag, it cannot supply a verified test offer.

`core.ops_offer_approvals` starts empty and has no browser grants. An owner must first review the actual offer and Talip's written approval. Provision only that exact ID, with an audit reference and `condition_fingerprint=md5((to_jsonb(offer)-'active'-'created_at'-'updated_at')::text)`. The catalog checks this fingerprint on every action, so editing terms invalidates prior approval. A browser `approvalReference` is never an authorization grant. A missing/unsupported setter or schema fails closed. Neither `Weekday Lunch Special` nor any other live offer is preapproved in this migration.

## Explicit stalled-action reconciliation (privileged, no automatic replay)

If execution/finish fails, the action can remain running and preserve its private payload. The frontend stops polling after its bounded wait and never sends another action automatically. A new action of that type remains blocked.

After **at least five minutes**, a privileged operator must inspect the exact action ID and request key, confirm no worker is still active, and check import/commission rows, current offer state and private report object as applicable. Then call the service-role-only `ops_reconcile_action(p_action_id,p_request_key,p_status,p_reason_code)` through the approved owner/MCP procedure. Never print or copy raw CSV/claim tokens into chat, logs or PR artifacts.

- `done` requires a matching explicit verification reason: `verified_import_committed`, `verified_offer_state`, `verified_report_object`, or `verified_source_snapshot`.
- `failed` can use `verified_no_side_effect` or `operator_abandoned_unknown`. Choosing failed does not assert that an external side effect never happened; record the human review separately.
- Reconciliation locks the row, invalidates its claim, purges its private payload and records the terminal reason. It never executes the action.
- Old claims cannot subsequently finish or call SQL financial/offer helpers. The report claim is checked again immediately before upload. An already-inflight Storage HTTP upload cannot be atomically cancelled by a SQL transaction; its create-only, private, versioned object must be checked/cleaned up by the operator. It does not become publicly downloadable or authorize another commission.

## Secrets and read adapters

Secrets are server-only; values must never enter Vite configuration, snapshots, logs, tests or screenshots.

- Platform: `SUPABASE_URL` (must match trusted `OPS_PROJECT_REF`, or the existing Production default), `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- Optional local development CORS only: `OPS_ALLOW_LOCALHOST=true`; leave unset in production.
- Klaviyo: `KLAVIYO_OPS_READ_KEY`; optional `KLAVIYO_CONVERSION_METRIC_ID` for campaign statistics. Account/list identity and consent/test exclusion are checked.
- Places: `GOOGLE_PLACES_API_KEY`. Rating/total reviews are direct reads. The seven-day value is a net snapshot difference, not a count of newly posted reviews.
- GA4: `GA4_SERVICE_ACCOUNT_JSON` (read-only scoped) or temporary `GA4_ACCESS_TOKEN`; property `551076037` (`GA4_PROPERTY_ID` must match).
- Google Ads: required `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, and `GOOGLE_ADS_CUSTOMER_ID` (`6478477284` or dashed equivalent). Optional `GOOGLE_ADS_LOGIN_CUSTOMER_ID` for manager routing; USD/New York required. OAuth Cloud project needs production API access and the OAuth user needs read-only account access. Developer tokens were sunset on 2026-09-09; no developer-token header is sent and legacy access-token shortcuts are ignored.
- Meta: `META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`, `META_API_VERSION`, optional `META_RESULT_ACTION_TYPE`. Read identity, currency and New York timezone are verified; this is not an ads-management write grant.
- Clover API scaffold: `CLOVER_OPS_READ_TOKEN`, `CLOVER_MERCHANT_ID`, `CLOVER_OPS_API_ENABLED`. Credentials alone do not approve financial/refund/channel mapping or inventory writes; CSV is the first-release path.

Klaviyo growth and review change need a historical snapshot at/before the seven-day boundary with at most 24-hour tolerance. The service context includes both count histories for nine days. Absence of a baseline remains unknown; no first-week zero or invented increase is generated.

## Local verification

No live project or provider access is needed for these checks:

```text
node --test tests/opsServer.test.mjs tests/opsCollectors.test.mjs tests/opsCsv.test.mjs
PGLITE_MODULE=<installed isolated @electric-sql/pglite module URL> node --test tests/opsDb.test.mjs
node node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution bundler --allowImportingTsExtensions --lib ES2023,DOM supabase/functions/ops-collect/index.ts
```

The database test creates an in-memory isolated PostgreSQL fixture and loads the migration there only. The included commission fixture is the existing historical engine; tests verify the actual formula call and absence of a second refund deduction. It is not a production migration.

K1c deploy order and hosted JWT acceptance: [runbook](../../../docs/staff-ops/K1C_DEPLOY.md). Optional `OPS_PROJECT_REF` is deployment configuration, not request input. Leave it unset for Production default or set to that project explicitly; sandbox must set its own ref. No provider credential is required for initial Supabase count and site ping.
