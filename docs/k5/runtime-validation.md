# K5 runtime compatibility validation

19 October 2026, America/New_York. No hosted database, credential or provider mutation was used to reproduce this failure.

The signed-in hosted Preview showed an unavailable queue; Cloudflare recorded a completed GET in 4 ms with no exception escaping the handler. A separate credential-free synthetic bearer probe returned HTTP 503 / `connection_unavailable`. Auth itself had succeeded. Local workerd reproduced the cause: `redirect:'error'` throws synchronously before an outbound request. The original Node fetch mocks accepted the option and therefore missed the runtime incompatibility.

The fix uses `redirect:'manual'` in the RPC and provider transports. It does not follow Location, relax an allowlist or expose an error body. RPC rejects all non-2xx responses; the provider engine rejects 3xx. No schema, permission, password, key or Production binding changes are needed.

Validation after the fix:

- 61/61 targeted Node tests: engine, runtime, API and actual local SQL integration. The first transitional run had stale `redirect:'error'` assertions in the injected test fixtures; those were updated before the passing run. That transitional run is not the workerd reproduction evidence.
- 11/11 actual local workerd tests: real handler GET/empty POST; RPC and provider GET/POST 302, 307 and 308 responses cannot cause a second request to the redirect destination. All outbound requests are intercepted synthetic services. Miniflare 5.20261006.2-beta, workerd 1.20261006.1 and esbuild 0.28.2; compatibility date 2026-10-06. Metadata fetching and telemetry are disabled.
- Strict Functions TypeScript, targeted ESLint, application TypeScript and Vite build passed. Existing Browserslist/bundle warnings remain.
- Independent review found no redirect credential-forwarding regression. Migration bytes remain SHA-256 `d28672a87149839c71e44c72116ebbf3b96b2e76c7ec42a2a79c1f7b9f4fabc2`.

Run `node --test tests/profileSyncWorkerd.test.mjs` with the documented installed tooling. It needs local loopback permission for Miniflare, not external network access. Without tooling the group reports an explicit skip; this must not be counted as runtime acceptance.

Use the stable branch Preview origin for human acceptance so later deployments do not require a different-origin login: `https://feat-klaviyo-profile-sync.nazar-restaurant-website.pages.dev/staff/profile-sync`. Talip performs login.

Hosted empty-mock acceptance passed on 19 October against runtime commit `9f0a607`, deployment `9f7bda55-7e82-442f-b516-497008a5bb66`. The actual signed-in staff UI displayed mock mode and a valid empty queue. Exactly one manual command completed with processed/succeeded/blocked/retry/failed all zero; one subsequent manual read-only refresh preserved the empty queue, mock banner and enabled command without an error. Eight saved UI-evidence checks passed. No login, password or token was automated/read by Codex, and no real provider request was made. This is observed validated UI acceptance, not an independent raw network trace.

Three existing marked test customers were correctly excluded. This proves hosted session/queue/API/RPC empty-run plumbing; it does not establish profile upsert, duplicate reconciliation, hosted error-row rendering or delivery. Test flags were not cleared and no positive fixture was added. Real-account writes still require separate method approval; overall K5 remains open. Private before/after/refresh snapshots, screenshot and receipt stay in the local K5 evidence folder.

Primary implementation reference: [Cloudflare workerd Request redirect modes](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/http.h). Private operator/runtime receipts and screenshots stay outside Git under the local K5 evidence folder; no credential values belong in this document.

## Subsequent controlled acceptance — current status

The empty-mock paragraphs above preserve their original point-in-time scope and pending-approval status; they are not rewritten as provider-write evidence. Talip subsequently approved the separate controlled method. [Controlled acceptance and cleanup](controlled-acceptance.md) records the later mock error row, real single-profile success, unchanged second command, key revocation, provider deletion and scoped fixture cleanup. The tested runtime source and migration bytes were unchanged. Preview is now keyless and disabled. Formal Talip acceptance, the Production migration and merge remain separate; the historical empty-run evidence alone does not close K5.
