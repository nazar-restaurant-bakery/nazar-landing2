# VIP and catering intake

The website already has VIP and catering pages. This change supplies a protected write path for their existing Nazar-production tables. The browser posts to `/api/signup`; a Cloudflare Pages Function validates input and a single-use Turnstile token, then calls the existing `public.submit_signup` function with a Supabase secret key. The secret key is never included in the browser build.

## Required Cloudflare configuration

In the `nazar-restaurant-website` Pages project, set these production variables:

| Name | Type | Value |
| --- | --- | --- |
| `VITE_TURNSTILE_SITE_KEY` | Plain text | Site key for a Turnstile widget limited to `www.nazarrestaurantandbakery.com` and `nazarrestaurantandbakery.com` |
| `TURNSTILE_SECRET_KEY` | Secret | Matching Turnstile secret key |
| `SUPABASE_SECRET_KEY` | Secret | Nazar-production `sb_secret_...` key, never a key from another project |

Keep the existing Nazar-production `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_NAZAR_BUSINESS_ID` build variables. The publishable key is still needed to display public specials. **Do not place the Nazar-production secret key in the Pages preview environment.** A preview can check route availability and form layout while failing closed; a successful write test needs a separate isolated Supabase project. Cloudflare's documented dummy Turnstile keys are suitable for local or isolated automated tests, never production.

## Cutover order

1. Deploy this branch as a Pages preview without a production Supabase secret. Check that both forms show Turnstile and that `/api/signup` is served by the Function, not the static SPA fallback. No real lead should be stored.
2. Add a Cloudflare rate-limit rule for `POST /api/signup` on the production hostname. Turnstile verifies people, but it does not replace request throttling. Choose the threshold after observing normal traffic; avoid blocking a busy shared network without evidence.
3. Set the production variables and deploy the same code. Confirm the production widget and Function route load. Do not use a real customer's details as a test.
4. Run `database/20260923_form_intake_cutover.sql` in **Nazar-production** only. It revokes direct public submission, grants the server role access, and opens intake atomically. Check the project ref in the SQL and in the dashboard before running it.
5. Submit one synthetic VIP and one synthetic catering request from the production site. Verify exactly one row per request and that catering does not become a marketing subscription. Remove test records using a reviewed, record-specific cleanup if needed. Check failure/retry behavior and mobile layout.

If forms must be stopped, run `database/20260923_form_intake_pause.sql` in Nazar-production. This stops new records without removing existing data. Restoring an earlier Pages deployment alone does not restore the previous database grants, so keep the new site deployment or pause intake during rollback.

The VIP consent is recorded as pending review by the existing database function. This change does not connect Klaviyo, send marketing email/SMS, or establish consent evidence beyond the submitted form values.

## Local verification

`node --test tests/signup.test.mjs` tests rejection, Turnstile failure, field mapping, and database failure with mock network responses. `node node_modules/typescript/bin/tsc -b` and `node node_modules/vite/bin/vite.js build` verify the frontend. Full acceptance requires a Cloudflare preview and the controlled live cutover above.
