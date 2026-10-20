# Nazar operations panel — review and acceptance

This change adds a separate **Ops** menu at `/staff/ops`; `/staff/system` and its password controls remain unchanged. It contains the ten requested tiles, seven action entry points, aggregate-only source states, the last ten actions, and the existing form-error, notification and session controls. Public pages and existing CRM mutation contracts are unchanged.

## Release boundary

- **Manual collection only**, following Talip's explicit decision. No 06:00 schedule, cron, n8n or automatic retry is installed.
- The specification's §6 “günde 1 (06:00)” line is **not applicable to this release**; “istekle” applies. No scheduler SQL file, module or separate scheduler authorization path is included. Daily automatic collection is a separate decision.
- PR #52 is merged. This delivery includes main `477d617` and is reviewed against main; merge remains Talip’s decision.
- No migration, function, bucket or secrets were installed in production. No real CSV was uploaded, no campaign/offer/inventory state was changed, and no customer communication was sent.
- A Cloudflare frontend preview cannot collect production data until Talip separately reviews/applies the SQL and deploys the function. It shows a truthful waiting state before that. Screenshots and browser tests use synthetic data and a local fake SDK.

## Prepared paths and unavailable behavior

| Path | Prepared behavior | Activation requirement / limitation |
|---|---|---|
| Supabase totals and site ping | Authenticated manual aggregate collection | SQL and Edge Function deployment |
| Clover CSV | Strict server parser; cents, dates, channels, deduplication and refunds checked | Explicit export coverage. Aggregate Sales Report lacks channel/order proof; it cannot alone populate qualified commission or channel totals. |
| Commission | Existing calculation engine; full closed qualified month persists, current MTD remains an estimate | Existing engine/settings and a qualified full-month import for a final PDF |
| Klaviyo | Account/list verification, consent/test exclusions, aggregate counts and campaign observations | Server read key; missing/partial scopes stay unknown |
| Google reviews | Rating and total from Places | Server key; seven-day change requires an earlier snapshot and is a **net snapshot difference** |
| GA4 / Ads / Meta | Read adapters, fixed/checked identity, period and timezone | Appropriate server credentials and successful first snapshot |
| Failed job retry | Once-only retry of a known failed manual collect from the last 24 hours | Never replays email or a customer notification |
| Existing offer toggle | Existing test offer or trusted approval bound to exact current terms | Supported setter and verified target. No real offer is preapproved. |
| Ads status / Clover inventory writes | Visible grey controls and `not_connected` intent receipt | **Write adapters and target approval are not implemented in this release. Adding a read key will not enable them.** |
| Scheduled jobs | Grey tile and manual-only explanation | A future explicit scheduling decision |

Missing measurements remain `—`, never fabricated zero. Selecting an old-month import does not relabel it as current-month sales. Ads conversions, website forms and paid orders stay separate. Unknown subscription status is not an active subscriber. The Ops panel never renders customer names, email addresses, phone numbers or message bodies, including in its legacy sections.

CSV input is either the verified **Sales Report** aggregate layout or the strict normalized transaction format in [the synthetic template](../../tests/fixtures/ops_clover_normalized_synthetic.csv). Arbitrary native Orders/Payments exports are **not** accepted automatically. Required transaction headers and coverage declarations are demonstrated by that template; an export-specific mapping needs separate validation before using a new format. No actual financial source file is committed.

## Differences resolved against the supplied specification

1. The actual accepted scheduler record contains no periodic Worker or pg_cron. Talip selected manual collection for the first release.
2. Nullable `period_start` cannot be a primary-key member: the migration uses a surrogate key and a null-safe unique snapshot index. Connections are business-scoped.
3. The existing engine is `core.compute_commission(...)`; no public function of that name is invented. QICR already contains the baseline deduction. CSV net refunds and the baseline are not subtracted twice.
4. Queue creation and execution acknowledgment are one authenticated Edge request. The Edge Function calls `ops_request_action` with the **user JWT**, claims once, then acknowledges. Lost replies never auto-enqueue or rerun work. An existing queued ID can only be resumed explicitly by its requesting account.
5. Private PDFs use `<businessId>/ops/commission/YYYY-MM-<actionId>.pdf`, not an overwrite-prone shared filename. Downloads require the matching completed action and a short-lived signed URL.
6. Corrected links: GitHub owner `nazar-restaurant-bakery`; GA4 property `551076037` (the `G-...` value is a measurement ID); Ads account selector instead of an invented `ocid`; actual Pages project `nazar-restaurant-website`.

## Review / deployment checklist (Talip; not executed by this PR)

1. Review `supabase/migrations/20261020000100_ops_panel.sql`, including fixed Nazar identity, permissions, existing financial engine compatibility and private Storage rules. Apply through the approved Nazar MCP procedure only.
2. Review [the server README](../../supabase/functions/ops-collect/README.md) for exact secret **names**, provider scopes, action capabilities and explicit stale-action reconciliation. No secret values belong in this repository or Vite variables.
3. Deploy `ops-collect` separately, with JWT verification and the existing staff authorization. Enable only reviewed provider reads. The shared external-call budget is 30 per New York day.
4. Test access denial first, then manual collection, one synthetic qualified closed-month CSV, one verified test offer and the private report. Do not use live customer records or Weekday Lunch Special.
5. Confirm grey source behavior, incomplete-file rejection, lost-reply recovery, test exclusion and 375px mobile layout. Merge remains Talip's decision.

The server README documents raw CSV retention until finish/reconciliation and the privileged, non-replaying cleanup procedure. A stalled worker is not silently marked successful.

## Verification evidence

See [verification.json](evidence/verification.json) and [the latest manual-only browser scenarios](evidence/manual-only/results.json). Latest synthetic screenshots: [desktop](evidence/manual-only/staff-ops-desktop.png) / [375px mobile](evidence/manual-only/staff-ops-mobile.png). The private September source was validated locally against all 180 reference financial cells; only hashes and the comparison count are committed. No live amounts or source file are included.

## K1c installation

See [K1c runbook](K1C_DEPLOY.md) for the exact test-first LF migration, hash, psql 18.6 and function deploy commands. No hosted installation has been performed.
