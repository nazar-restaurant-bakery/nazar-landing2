# Nazar customer follow-up screen

Status (11 October 2026): code prepared on a separate branch. The database migration succeeded on Nazar-production; the first owner account was invited and added to the staff allowlist. The website route has **not** been published or signed in and tested yet.

The private `/staff` route offers customer search, the latest signup source and local consent state, internal notes, and catering requests with status, owner, and next follow-up. The screen displays a maximum of 100 matching customers and 100 matching requests; search runs on the server, not on a public data dump. Open catering requests require a follow-up time when edited.

The browser authenticates with Supabase email links and calls only three narrowly scoped `public` RPCs. Each RPC checks `auth.uid()` against the private `core.crm_staff` allowlist. Neither `core` nor the customer tables are exposed directly to browser roles. The local consent state is **not** the definitive Klaviyo subscription state.

## Activation sequence

1. Done: `database/20261011_crm_staff_draft.sql` was applied in one transaction. The SQL Editor reported success. It created the staff allowlist, notes table, and RPCs.
2. Done: `ctnazarbakery@gmail.com` was invited in Supabase Auth. The exact `https://www.nazarrestaurantandbakery.com/staff` redirect URL was saved.
3. Done: Auth user ID `452baff4-eab6-4552-8216-afc1a1964cb9` was matched to that email and inserted into `core.crm_staff` with role `owner`, active `true`; SQL returned one row. This does not prove the invitation was accepted or the screen works yet.
4. Test an unauthenticated request and an authenticated but unlisted user: both must be denied. Test the owner account: list/search only Nazar records, add a note, and edit a disposable test catering request; verify saved values and follow-up order.
5. Publish the website branch and confirm `/staff` works on desktop and mobile. Keep the route out of public navigation and search indexing. Review Supabase Auth rate limits and MFA before adding more staff.

Do not publish the route as working until steps 1–5 pass. No customer email or marketing message is sent by this screen.
