# First real coupon event: closed setup protocol

This is a forward migration and default-disabled setup candidate. It does not create a customer, campaign, coupon, credential, provider event or Flow. Application order is unassigned; proposed order 23 requires Talip's decision. Apply to Sandbox before Production only through a separately reviewed operator step. Do not include this SQL in historical replay or K3 reset.

## Why this exists

The normal Welcome processor requires the real delivery Flow/message before posting an event, but the named metric does not exist until its first genuine event. Production has no historical coupon/DOI evidence. This protocol emits one genuine authorization event and uses Klaviyo's supported Add past profiles operation to deliver that same event later. There is no synthetic seed, backfill, replay, resend or second event UUID.

## Local boundaries

- A private permit selects one existing issued, unexpired, non-test coupon, confirmed customer, provider profile, account and outbox job. An active platform operator with write membership in that business must explicitly approve it. Creating a permit does not enable the runtime.
- The runtime has separate `COUPON_BOOTSTRAP_ENABLED` and `COUPON_BOOTSTRAP_MODE` gates, both closed by default. It accepts only a permit ID and a narrow action, authenticates with the existing trusted internal process key and rejects browser-origin requests. Isolated environments cannot inherit Production credentials.
- Existing K6 reserve/claim/current-state/finalize functions are reused without changing their definitions. The normal handler cannot supply the internal bootstrap protocol port. Durable claim plus business serialization prevents duplicate dispatch; the original job is permanently excluded from the normal selector.
- A 202 remains UNKNOWN. A timeout or interrupted POST is never retried. `recover` only finalizes the original lease/job as unknown; it cannot post an event. `verify-event` reads the original event and records a matching account/profile/metric/UUID/coupon proof. Provider-generated event UUIDs are not confused with the submitted unique ID.
- Bootstrap GETs have streaming per-response and aggregate byte limits; pagination must remain on the exact Metrics endpoint and complete. Redirects, partial lists, conflicting receipts and wrong identity fail closed.
- All other normal jobs in the business wait until the bootstrap receipt exists and a different permanent Flow has been configured. No gate times out into marketing permission. Activation readiness is always false for this setup route.

## Hosted acceptance sequence — not executed by this delivery

1. Review/install the new SQL, deploy the closed code, and verify current account, credential scopes, quotas, consent and existing Flow inventory. The production account is independently verified at execution time. Secrets and final irreversible clicks remain Talip's actions.
2. Separately authorize one real consenting volunteer and a genuine eligible coupon. Create the bounded permit; enable only the approved setup path. Dispatch once through K6, then verify the exact provider event. Do not repeat a form, dispatch or event after uncertainty.
3. Once the real metric exists, prepare a **separate bootstrap Flow**, exactly one email in **Manual**, no other actions, and explicit first profile/coupon/event restrictions. The proposed setup-only delay is **120 minutes**. This does not alter the permanent zero-delay Flow.
4. Add the original event through **Add past profiles** after Klaviyo's recent-data snapshot can include it (at least 30 minutes), **before** the configured delay elapses. An event already outside the Flow timeline cannot be recovered by this procedure. Re-entry criteria are not checked by Add past profiles: they do not prove uniqueness.
5. After the delay, inspect the actual **single Needs Review** record and rendered coupon content. Any extra recipient, missing/wrong coupon or downstream action stops the procedure. Record only sanitized evidence and hashes, not customer content or coupon codes. Human review fields are attestations, not provider-verified claims.
6. Recheck current permission, suppression, coupon validity and K6 context; bind the proven original unknown reservation to the actual bootstrap Flow/message/native Received Email metric. The SQL requires a fresh review, at least 60 minutes of Flow delay and recovery time beyond the event plus delay plus a 30-minute margin. Talip alone performs the final single-message send.
7. Reconcile the actual native Received Email using the existing exact account/profile/metric/Flow/message/time receipt path. No receipt means no delivery claim. Receipt-only reconciliation can still record a real delivery after later opt-out; it never grants another send. The immutable message log remains unknown and the original 168-hour window is computed from actual delivery evidence.
8. Keep the bootstrap Flow out of normal traffic. Configure the separate permanent Flow with explicit exclusion of the already delivered first profile, verify its no-re-entry/consent/template settings, and separately accept normal operation. Until that handoff, other normal jobs remain queued.

If the event never appears, the Manual queue cannot be proven, the permitted recovery window expires or the sender fails, stop. Never substitute a fake cancellation, SENT value, new UUID, automatic replay or an empty GET for terminal evidence. Existing audited provider-cancellation handling remains a separate, evidence-based resolution path.

## Validation scope

Native PostgreSQL tests exercise the captured application schema and real K6/receipt functions with fresh synthetic local records; no hosted test flags are changed. Workerd tests exercise the actual transport/runtime against synthetic services. Neither suite proves Klaviyo's real scheduler, queue, account quota or delivery. Those remain explicit hosted acceptance gates.

Relevant suites: `couponBootstrapDb.test.mjs`, `couponBootstrapRecoveryDb.test.mjs`, `couponBootstrapInventory.test.mjs`, `couponBootstrapTransportReview.test.mjs`, `couponBootstrapWorkerd.test.mjs`, `bootstrapReadBudget.test.mjs`, plus the existing Welcome/receipt regression suites.

Official references: [Add past profiles behavior](https://help.klaviyo.com/hc/en-us/articles/115002779231), [operator procedure](https://help.klaviyo.com/hc/en-us/articles/360049924272), [Events API](https://developers.klaviyo.com/en/reference/events_api_overview), [Metrics API integration identity](https://developers.klaviyo.com/en/reference/metrics_api_overview).
