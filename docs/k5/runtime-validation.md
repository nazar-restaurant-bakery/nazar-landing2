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

Use the stable branch Preview origin for subsequent human acceptance so later deployments do not require a different-origin login: `https://feat-klaviyo-profile-sync.nazar-restaurant-website.pages.dev/staff/profile-sync`. Talip performs login. Then verify the real authorized queue read, one manual mock command, and a read-only refresh. Three marked test customers should produce zero jobs/zero eligible profiles; that empty run is not profile-upsert or hosted error-row evidence. Real-account writes still require separate method approval.

Primary implementation reference: [Cloudflare workerd Request redirect modes](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/http.h). Private operator/runtime receipts and screenshots stay outside Git under the local K5 evidence folder; no credential values belong in this document.
