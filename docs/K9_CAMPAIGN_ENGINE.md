# K9 — Private campaign engine (schema version 1)

This PR prepares database code and synthetic tests. It does not deploy a
migration, activate a campaign, call Clover/Klaviyo, send a message, or add a
staff tab. K9 PR merge remains blocked until K7 day reconciliation closes.
Operational migration order is **K7 optional-scope report patch `20261020000900`
(6) → K8 `20261021000100` (7) → K9 `20261021000200` (8)**. The K7 patch
is registered from main PR #66; its sandbox/production application is not
claimed by this delivery. It remains separate from historical K3 reset/replay.
K8 is a separate work item; this migration does not claim to install/test it.

## Objects and trust boundary

`core.campaigns` is separate from publication-only `core.offers`, linked by
`(offer_id,business_id)`. Configuration is reviewed SQL only. Every new table
has `business_id`, RLS enabled, and no grants/policies for anon, authenticated,
or service_role. `core` stays closed to the Data API. No fixed restaurant,
project, merchant, customer, campaign value or credential is seeded.

Additive `k9_offers_id_business` and `k9_customers_id_business` unique indexes
allow true composite foreign keys. They also prevent a later parent tenant
move from breaking a historical campaign/customer link. No prior SQL file,
public RPC body, customer permission or provider adapter is replaced.

The only public entry point is service_role-only, `SECURITY DEFINER`, with an
empty `search_path`:

```sql
public.campaign_evaluate_v1(
  p_business_id uuid,
  p_campaign_id uuid,
  p_order_id uuid,
  p_units integer DEFAULT 1,
  p_source text DEFAULT 'clover_trace',
  p_staff_actor uuid DEFAULT NULL,
  p_staff_note text DEFAULT NULL
) RETURNS jsonb
```

It returns `{applied,code}` and, where relevant, `redemptionId`, `status`,
`periodKey`, `units` or `rightsRestored`. A denial inserts no redemption and
does not mutate identity/consent. It is not an instruction to send a message
or to apply a new checkout discount. It records an already evidenced grant.
`core.clover_order_status_v1` from K7 is the sole order-status interpreter.

## Campaign parameters

| Field | Meaning / validation |
| --- | --- |
| `business_id`, `offer_id`, `name`, `is_test` | Coupled tenant/offer; campaign and customer test flags must agree. |
| `benefit_type` | `item` is an evidenced free inventory item; `discount` is one evidenced configured monetary or percentage discount. |
| `target_clover_item_id` | Clover **inventory** `raw_response.item.id`, never the order line `clover_item_id`. Required for item; optional for discount. |
| `benefit_code`, `clover_discount_id` | Exact code / Clover discount identity that must occur on the qualifying provider record. An application-only flag is not evidence. |
| `discount_amount_cents`, `discount_percentage` | For `discount`, exactly one must be set. Amount is positive configured cents, matched to the provider's negative discount amount; percentage is `(0,100]`. These are null for `item`. |
| `min_amount_cents`, `include_tax`, `include_tip` | Inclusive threshold `amount >= minimum`; default excludes both tax and tip. Reliable provider allocations are mandatory. |
| `order_type_ids` | Explicit nonempty Clover order-type allow-list, no free-text channel inference. |
| `starts_at`, `ends_at`, `tz_name` | Order-created interval `[start,end)`, valid PostgreSQL timezone; future orders denied using the database clock. |
| `weekdays`, `local_start`, `local_end` | ISO weekdays 1–7; optional paired local `[start,end)` time window. Overnight windows are not supported in v1; configure separate campaigns. |
| `eligibility` | `subscribed_only` requires subscribed and not suppressed; `everyone` does not change consent. Both require an exact/staff-resolved customer match belonging to the tenant. |
| `max_units_per_order`, `period`, `max_total_units` | Units 1–1000 per order (`discount` uses exactly 1); `week` / `campaign` / `unlimited`; optional total units cap. |
| `restore_on_full_refund`, `restore_on_partial_below_minimum` | Whether a void releases person/period and total capacity, read from the original immutable application snapshot. Defaults false. |
| `status`, `schema_version`, `version` | `draft` / `active` / `stopped`; schema version 1 and trigger-incremented configuration version. No automatic activation. |

Configuration changes append to private `core.campaign_events`; creation,
activation, stop and parameter changes are separate evidence events. Events
are not stored in `consent_events`, whose existing meaning is consent only.
After any redemption, tenant, offer, benefit identity/amount, period/timezone
and test identity cannot be changed to reset old rights. Other changes produce
a new version; old redemptions retain their original full configuration.

## Money evidence and refunds

Clover payment `amount` includes tax but excludes `tipAmount`; a charge's gross
is `amount + tipAmount`. Clover refund `amount` includes both refunded tax and
tip. Therefore the default merchandise basis is:

```text
sum(payment.amount − payment.taxAmount)
− sum(refund.amount − refund.taxAmount − refund.tipAmount)
```

`include_tax=true` retains paid tax less refunded tax. `include_tip=true` adds
paid tips less refunded tips. Payment tips are never subtracted twice.
K7 `net_cents = payment.amount − refund.amount` is retained as evidence, but
is not silently treated as tax-free merchandise sales.

The K7 snapshot must also carry `orders.raw_response.refundsVerified` as the
JSON boolean `true`. Boolean `false`, a missing value, JSON `null`, and the
string `"true"` all deny evaluation and reconciliation. An empty local refund
array is insufficient evidence of zero refunds. These denials do not create or
void ledger rows and do not release existing person/period or total quota.

All successful payments and nonvoid refunds must contain explicit integral
nonnegative `taxAmount` and `tipAmount` values (explicit zero is valid). Each
refund must reference a successful payment of the same order/business through
both its stored payment ID and provider `payment.id`. Per-payment and aggregate
refund allocations cannot exceed the original tax, tip or gross. Missing,
malformed, negative or inconsistent evidence denies evaluation/reconciliation
without inventing zero. Malformed refund `voided` flags are denied.

Full refund means **exact** refunded gross equals `sum(amount+tipAmount)`;
K7's `refunded` status alone does not mean full refund. Over-refunds are unknown
evidence, not permission to restore rights. A partial refund below the original
minimum voids the use; a partial refund still above it retains the use. Refund
reconciliation runs through the same evaluator **before** current campaign
status/date/consent checks, so stopped or edited campaigns can still reconcile
their historic use under the frozen original policy. Unknown refund evidence
leaves the original reservation in place for review. The void event freezes the
current order/payment/refund raw evidence as well as the derived amounts, so a
later provider refresh cannot overwrite the original reconciliation proof.
No background job is added:
the evaluator must be invoked after a refreshed order snapshot to reconcile it.

Provider semantics sources:
[manual-entry payment tax/amount](https://docs.clover.com/dev/docs/manual-entry-payments),
[payment amount plus tip](https://docs.clover.com/dev/docs/working-with-transaction-data-remote-pay-sdks),
[refund amount/tax/tip](https://clover.github.io/remote-pay-cloud-api/4.0.5/payments.Refund.html),
[negative fixed discounts / percentage](https://docs.clover.com/dev/docs/creating-custom-orders).

## Trace, quantity and staff fallback

For an item benefit, a matching inventory line must have a matching configured
discount identity/code with an explicit 100% line discount. An order-level code,
an unrelated discounted product, a name match, a zero/deleted/voided discount,
or a caller flag is insufficient. Quantity comes from positive integral K7
`quantity`, or a known `PER_UNIT` `unitQty/1000` that is a whole number. Fractional
or absent quantities are denied. The caller's `p_units` must equal the entire
evidenced free target quantity, so underclaiming cannot bypass the total cap.
Fixed-amount free-item inference is not supported: incomplete price/modifier
evidence cannot safely prove a fully free item. For generic discounts, exact
configured positive percentage or negative provider amount must match, and a
targeted discount must occur on that target line.

`staff_mark` is a service-only fallback requiring `p_staff_actor=auth.uid()`,
an active existing `core.crm_staff` actor and a nonblank note. A normal service
key without a verified staff subject **cannot** use it. No new staff login,
browser flag, UI or server impersonation adapter is provided. Its future caller
must establish a trusted staff JWT subject. The fallback still checks financial,
customer, product, time, channel and quota conditions. Matched identity does not
grant marketing permission; unlinked/ambiguous walk-in orders remain denied.

The existing Clover pull preserves original order and child responses, including
`orders.raw_response.raw`; however, its current expansion does not guarantee
order/line discounts or tax/tip/quantity allocations. Missing fields will
**deny** a real evaluation. Provider read enrichment and actual configured
campaigns are later work; this PR neither invents fields nor rewrites K7.

## Atomic quota and retained history

The engine requires READ COMMITTED and locks the campaign row, then the order
and customer. The campaign lock serializes both per-person and total capacity.
Private `core.campaign_usage.reserved_units` is a durable counter, initialized
on campaign creation and updated only by redemption triggers. It counts applied
uses and non-restoring voids; restoring voids decrement it. Direct app edits are
revoked; a guard rejects direct counter edits even from ordinary SQL.

`core.offer_redemptions` stores `units`, immutable identity, original campaign
version/configuration, financial/trace evidence and retained provider snapshots.
The only update is terminal `applied → voided`; neither uses nor evidence events
can be deleted, truncated or overwritten. A campaign's cap cannot be reduced
below already reserved units. An unconditional `(campaign_id,order_id)` unique
key makes the same order exact-once even after a restoring refund. A retry is
idempotent; conflicting units/source/staff evidence are rejected.

Person-period uniqueness is `(campaign_id,customer_id,period_key) WHERE
quota_reserved`. The partial condition is an explicit resolution of the spec's
two requirements: retain the voided row **and** optionally restore the person's
right. An unconditional unique constraint would make restoration impossible
without deleting/relabeling history. Non-restoring voids keep that key; restoring
voids free it for a **new** eligible order. The old voided order cannot be reused.

Period keys use the order's created time in the campaign timezone:
`week:ISOYEAR-WISOWEEK`, `campaign:campaign UUID`, or `order:order UUID` for
unlimited. A week boundary permits a later distinct period; unlimited still
allows only one redemption per order. It does not mean unlimited units.

## Delivery / operations

No hosted migration is run by this PR. Review source SHA and synthetic results,
then apply identical LF bytes using the existing reviewed psql method in the
reserved K8→K9 order, sandbox before production. No secret is printed or stored.
Test fixtures are synthetic only; second-tenant tests do not create a production
tenant or change pre-existing tenant constraints. Test evidence must distinguish
local PostgreSQL rehearsal from hosted K3 application; a local pass alone is
not a claim that the hosted migration was applied.

Failure before migration commit rolls back its new objects/constraints. After
real redemptions exist, stop the campaign and preserve history; do not drop or
delete the ledger to reclaim rights. No irreversible provider grant/refund/send
is performed here. Maintenance is schema/version review plus explicit unknown
evidence review; no new provider subscription, scheduler or paid service is added.
