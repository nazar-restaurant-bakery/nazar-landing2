# K10 preparation: paid-pickup eligibility

Stacked on accepted K9 / #65 `f6cc0a8`. Code and synthetic evidence only; merge waits for K7 closure and #65. No hosted migration, activation, send, provider write, reservation or redemption is performed.

## Data and authorization

`public.campaign_eligibility_check_v1(p_business_id uuid, p_clover_order_id text)` is authenticated-only. It calls `core.staff_authorized_v1(business_id, 'orders.read')`; a denial is SQLSTATE `42501` (PostgREST HTTP 403 for authenticated users). The existing platform-read rule remains; platform read does not grant campaign writes. Direct access to `core` and the private predicate remains revoked.

The RPC reads the local K7 ledger. Its response contains `known`, nullable `eligible`, `reason`, campaign metadata, `remaining`, `checkedAt`, `snapshotAt` and candidate summaries. It contains no customer contact fields or raw provider payload. Person remaining is a count of uses; total remaining is benefit units; `null` means unlimited, never an invented zero. This check does not reserve either counter.

The new forward migration introduces `core.campaign_eligibility_rules_v1(uuid,uuid,uuid,integer,text)` and replaces only K9's evaluator body to call it. `base` checks active/paid/match/customer/consent/channel/date/verified minimum/quantity; `limits` checks the persisted person and total quotas. The writer retains its locks, authorization, fulfillment evidence, idempotency, refund handling and atomic writes. The original K9 SQL and its hash are unchanged. The reader uses the same predicates, without requiring a gift line or 100% discount that has not yet been fulfilled. Multiple eligible or uncertain candidates remain unknown. A previously recorded same-order redemption never becomes a new packing right.

## Staff display

Existing `/staff/orders` load behavior and provider GET remain. After rows load, at most four read RPCs run concurrently using the existing staff session and configured business. The row shows the result, reason, campaign, remaining uses/units, local snapshot time and check time. Missing RPC/order/evidence, 403 or network failure is **Kontrol edilemedi**, not **Yok**. Session changes clear results and discard late replies.

The requested **Simit hakkı** label is used for an item campaign named with the standalone word `simit`; this is presentation only. Other item campaigns use **İkram hakkı**. Discount-only campaigns cannot imply a free item. Eligibility always comes from DB configuration, not the campaign name or a hardcoded product/tenant ID.

## Delivery and operational limits

Migration: `supabase/migrations/20261021000600_campaign_eligibility_check.sql`, LF, inventoried as held/non-executable. Dependency is reviewed K9/shared staff plus K7; it does not depend on K11/K13/K15. The coordination migration sequence must register this forward file after K9 before an operator applies it. Use the same reviewed psql tool and bytes in test then production. Neither was applied in this task.

The provider's recent-order list may contain a paid order not yet in the local ledger. Existing closed-day pulls alone do not establish packing-time freshness; absent orders remain unknown. Real-time K7/K8 ingestion and a separate redemption path must be verified before activation. This work does not silently ingest, reserve, mark use, edit Clover, or send a message.

Existing isolated Preview middleware blocks the Clover orders provider GET. Screenshots and browser evidence use the actual component with synthetic intercepted responses; hosted Preview deployment alone is not proof of a live provider/DB order check. No Production secret or setting changes are included.

## Synthetic verification

`tests/campaignEligibilityDb.test.mjs`: native PostgreSQL, explicit READ ONLY calls and before/after table snapshots, requested eligibility failures and scope ACLs, ambiguous/missing data, refund/same-order behavior. `tests/campaignEligibilityRegression.test.mjs`: original 42 K9 evaluator cases against the forward migration, including concurrent quota races. The fixture creates only local synthetic data.

`node --experimental-strip-types --test tests/campaignEligibilityUi.test.mjs` covers transport/parser/batching/lifetime and copies. `tests/campaignEligibility.browser.mjs` renders the actual component at desktop and 375px; all network is synthetic. Existing CRM/Ops browser scenarios remain unchanged except a strict mock response for the newly read RPC.

Production comparison uses the accepted #65 source as base, four existing public build variables, no `APP_ENV`/`TEST_*`, and synthetic server credentials only. Form, Auth/routes, GA4 and sync behavior must remain equal. Generated staff JS/CSS intentionally changes; unrelated static assets must remain identical and gzip growth stay below 60KB. Detailed receipts are in the delivery evidence directory, outside the source repo.
