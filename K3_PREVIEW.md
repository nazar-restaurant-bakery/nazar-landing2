# K3 — isolated Preview routing (preparation only)

No cloud project, branch, credential, database migration or Cloudflare setting is created by this change. Production uses the same fixed project/business guard and existing secret names. PR #52/#53 are untouched.

All `*.pages.dev` preview hosts and local hosts fail closed unless explicitly configured for the isolated test environment. The existing canonical `nazar-restaurant-website.pages.dev` production root keeps its production behavior; hash/branch preview hosts do not. The browser and server independently reject Nazar-production as a test project target. The test business UUID comes from configuration and may retain the existing UUID for legacy SQL/RPC compatibility: a different project and its separate credentials provide isolation. Do not copy production keys into Preview or reuse a production key under a test variable name.

## Preview-only variables

Public Vite build variables (rebuild required): `VITE_APP_ENV=isolated-test`, `VITE_TEST_SUPABASE_URL`, `VITE_TEST_SUPABASE_ANON_KEY` (test project's publishable key), `VITE_TEST_BUSINESS_ID` (synthetic tenant UUID), `VITE_TEST_TURNSTILE_SITE_KEY=1x00000000000000000000AA`.

Server-only Pages Preview bindings: `APP_ENV=isolated-test`, `TEST_SUPABASE_URL`, `TEST_BUSINESS_ID` (must match browser business), `TEST_SUPABASE_SECRET_KEY` (test project's `sb_secret_` key), `TEST_TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA`, `TEST_TURNSTILE_EXPECTED_HOSTNAME` (exact hostname returned by the public dummy Siteverify response). No `VITE_` secret values.

Use only synthetic seed data and synthetic staff accounts in the isolated project. Reconfigure Auth site/redirect URLs for the Preview origin in that test project, never in production. Creating an environment and applying its schema is Talip's separate setup decision.

## Implemented boundary

- Public offer reads use the validated test target and business setting. Missing/mismatched configuration creates no browser client. The `/staff` UI client is deliberately disabled in Preview/test mode to isolate its provider features; their production-specific routes are unavailable in this preparation.
- `/api/signup` keeps same-origin, payload, Turnstile success **and hostname**, validation and idempotent RPC behavior. Production still requires Siteverify's hostname to equal the request hostname. Isolated mode compares it with the explicitly configured `TEST_TURNSTILE_EXPECTED_HOSTNAME`; missing config or mismatched response rejects the request. Its target and business come from the server configuration, never the request body. Documented Cloudflare test keys are accepted only in explicit isolated configuration; no challenge bypass exists.
- Preview sends no catering email, form-error alert, Klaviyo subscription or production GA4 event. Form-error background recording is intentionally skipped in test mode to avoid calling production helpers. The browser VIP second step reports no marketing handoff because sending is intentionally disabled.
- Existing `/api/staff/*` provider routes return `503 isolated_provider_route_disabled` in Preview/test mode; their hardcoded production implementations are not reused. This includes Clover reads, Klaviyo consent readback, decision email drafts and setup-test email. Direct browser RPC functionality is limited to what the isolated schema actually provides.
- Production Google tag is loaded only on the two existing production domains and the existing canonical Pages production root. No production analytics library is fetched on Pages hash/branch Preview or local hosts.

The browser/server test URL and business bindings must be checked together before use. URL guards cannot prove ownership of an arbitrary opaque secret: provisioning must obtain each key from the chosen test project. Provider credentials remain absent. This K3 setup targets one synthetic Nazar-test business only.

## Verification

`node --test tests/previewEnvironment.test.mjs` uses fake network responses only. It covers missing config, production target refusal, tenant override refusal, challenge failure/hostname rejection, test database failures without production logging/email, staff-route blocking, Klaviyo/analytics blocking and exact production Google-tag loading. No live account or customer data is used.

Cloudflare test-key reference: https://developers.cloudflare.com/turnstile/troubleshooting/testing/ . An approved public dummy-key probe on 19 October 2026 returned `success:true, hostname:"example.com"`; this is an observation, not a permanent provider contract or automatic default. Provisioning must recheck the actual dummy Siteverify response and set `TEST_TURNSTILE_EXPECTED_HOSTNAME` to that exact hostname. This PR does not claim a live Preview form test.
