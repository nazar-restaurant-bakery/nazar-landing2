# Nazar customer follow-up screen

Status (12 October 2026): the Cloudflare Pages branch preview passed a real owner sign-in and read/write test. The database migration succeeded on Nazar-production; the first owner account was invited and added to the staff allowlist. The website route has **not** been published on the live domain yet. See pull request #9.

The private `/staff` route offers customer search, the latest signup source and local consent state, internal notes, and catering requests with status, owner, and next follow-up. The screen displays a maximum of 100 matching customers and 100 matching requests; search runs on the server, not on a public data dump. Open catering requests require a follow-up time when edited.

The browser authenticates with Supabase email links and calls only three narrowly scoped `public` RPCs. Each RPC checks `auth.uid()` against the private `core.crm_staff` allowlist. Neither `core` nor the customer tables are exposed directly to browser roles. The local consent state is **not** the definitive Klaviyo subscription state.

## Activation sequence

1. Done: `database/20261011_crm_staff_draft.sql` was applied in one transaction. The SQL Editor reported success. It created the staff allowlist, notes table, and RPCs.
2. Done: `ctnazarbakery@gmail.com` was invited in Supabase Auth. The exact `https://www.nazarrestaurantandbakery.com/staff` redirect URL was saved.
3. Done: Auth user ID `452baff4-eab6-4552-8216-afc1a1964cb9` was matched to that email and inserted into `core.crm_staff` with role `owner`, active `true`; SQL returned one row. This does not prove the invitation was accepted or the screen works yet.
4. Done: SQL role simulation returned 8 customers and 5 catering requests for the allowlisted owner. An authenticated but unlisted user received `42501 Access denied`. Anonymous users have no RPC execute permission or direct table read permission. The owner completed a real email-link sign-in on the branch preview; list/search worked, an internal note was saved on a clearly marked test customer, and a TEST ONLY catering request was moved to `closed` with assignee `CRM Test`.
5. Before publishing, confirm the latest preview deployment includes the fix for a stale loading error message seen on first sign-in. Then publish the website branch and confirm `/staff` works on desktop and mobile. Keep the route out of public navigation and search indexing. Review Supabase Auth rate limits and MFA before adding more staff.

Do not describe the route as working until the owner completes a real sign-in and the screen's read/write flows are verified. No customer email or marketing message is sent by this screen.
