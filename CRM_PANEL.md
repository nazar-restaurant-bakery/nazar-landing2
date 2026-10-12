# Nazar customer follow-up screen

Status: code complete locally; **not yet enabled on the live website or database**.

The private `/staff` route offers customer search, the latest signup source and local consent state, internal notes, and catering requests with status, owner, and next follow-up. The screen displays a maximum of 100 matching customers and 100 matching requests; search runs on the server, not on a public data dump. Open catering requests require a follow-up time when edited.

The browser authenticates with Supabase email links and calls only three narrowly scoped `public` RPCs. Each RPC checks `auth.uid()` against the private `core.crm_staff` allowlist. Neither `core` nor the customer tables are exposed directly to browser roles. The local consent state is **not** the definitive Klaviyo subscription state.

## Activation sequence

1. Review and run `database/20261011_crm_staff_draft.sql` on Nazar-production. It creates the staff allowlist, notes table, and RPCs in one transaction. It adds no staff member; every signed-in user remains denied.
2. In Supabase Auth, invite the owner's chosen address and add the exact `https://www.nazarrestaurantandbakery.com/staff` redirect URL. Verify the invite email and Auth user ID.
3. Insert the verified Auth user ID into `core.crm_staff` with role `owner`. Never match by user-entered email alone.
4. Test an unauthenticated request and an authenticated but unlisted user: both must be denied. Test the owner account: list/search only Nazar records, add a note, and edit a disposable test catering request; verify saved values and follow-up order.
5. Publish the website branch and confirm `/staff` works on desktop and mobile. Keep the route out of public navigation and search indexing. Review Supabase Auth rate limits and MFA before adding more staff.

Do not publish the route as working until steps 1–5 pass. No customer email or marketing message is sent by this screen.
