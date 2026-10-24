# K10 receipt transport — 24 October 2026

Scope: existing `liveReceiptProvider` GET transport only. Separate worktree/branch `tmp/nazar-receipt-workers-redirect` / `fix/coupon-receipt-workers-redirect`, based on main `308cab975c8629b669af573b2b52097690367ff3`. Open PR inventory was checked before development; no receipt transport PR existed. Pickup #101 (`0286d3b35508fb8dfe0ccee8a2f436ce05738468`) and signup #102 (`86ad1364fdb2207b2e316eb2a2b09953921e3c73`) were not changed. This is a coordinator delivery, not instructions to Talip.

## Finding and change

The real adapter failed in local workerd with `redirect:'error'` before an outbound request. Before the change the constructor regression passed and the valid-200 reconciliation regression failed (`pending` instead of `delivered`). The fix selects `redirect:'manual'`. The existing exact `status === 200` condition rejects all other statuses before any provider body is read. No redirect destination is fetched; the private key stays on the original fixed Klaviyo host.

Fixed GET-only endpoints, query allowlist, revision `2026-07-15`, five-second timeout, body size bound, account/native metric/profile/flow/message/time matching, receipt digest and all consent/activation gates remain unchanged. No event creation, first-event bootstrap, Flow or SQL changes. The existing mock transport assertion was updated to expect manual mode.

## Evidence

- Before: actual workerd rejected legacy `redirect:error` with TypeError and zero intercepted outbound requests; the success-path test failed on unchanged code.
- After: **96/96 passed, 0 skipped**: **30 actual workerd regressions + 66 existing receipt/Welcome mock tests**.
- Runtime: Miniflare **5.20261006.2-beta**, workerd **1.20261006.1**, esbuild **0.28.2**, compatibility date **2026-10-06**. These are installed local tools; no installation or dependency change.
- A valid synthetic native Received Email takes exactly three intercepted GETs and records the expected safe digest through an in-memory store. This is not hosted delivery evidence. `activationReady=true` in that fixture reflects synthetic context only, not permission to activate anything.
- 301/302/303/307/308 at accounts, metrics and events stop at the original request count; no redirect-host request, record or activation. Same-host and relative redirects also stop. 202/400/401/403/429/500, malformed 200, wrong native message, closed activation gate and arbitrary paths stay blocked/pending as appropriate.
- All network operations from workerd terminate in a synthetic outbound service with no fetch/proxy fallback. No hosted SQL, real provider requests, customer profile, event or email. Test store callbacks are in-memory, not SQL. Provider response bodies and key values are not in the result evidence.

Reproduce with the existing Miniflare 5/workerd 1/esbuild modules on Node's module path:

```text
node --test tests/couponDeliveryWorkerd.test.mjs tests/couponDelivery.test.mjs tests/couponWelcome.test.mjs
```

Missing optional native tooling is explicitly reported as skipped, never counted as a native pass. The recorded run had no skips. [Structured evidence](evidence/receipt-workerd-20261024.json).

## Boundary and remaining acceptance

Draft PR targets main; merge remains with Talip/coordinator. No main push, hosted/account/secret/Flow/event/email/deployment operation was performed. Management files were not edited. This removes only the runtime transport blocker; it does not resolve the first-event setup cycle or authorize a real Welcome acceptance run. Hosted acceptance remains gated by the separate K10 plan. No direct operator action is issued in this delivery.
