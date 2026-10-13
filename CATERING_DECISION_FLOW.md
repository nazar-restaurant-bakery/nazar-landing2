# Catering price and menu decisions by email

Talip marks a catering request for Yücel in the private staff CRM. Yücel alone sets the final menu and price; Talip sees the answer in the same queue. The customer is not quoted or charged automatically.

## Intended workflow

1. Talip opens the request in CRM and marks the price/menu question for Yücel.
2. Talip reviews the prepared text in CRM and clicks **Send request to Yücel**. The server sends it from `info@nazarrestaurantandbakery.com` to the verified destination `ctnazarbakery@gmail.com`, with Reply-To set to `crm-decisions@nazarrestaurantandbakery.com`. No Gmail Send-as alias is needed. The subject contains a unique marker for this CRM decision.
3. Yücel replies **from `ctnazarbakery@gmail.com`**. Above the quoted message he writes `Decision: ...` and `Signed: Yücel`.
4. A dedicated Cloudflare Email Worker receives the reply at `crm-decisions@`, parses it, and sends it to the Nazar-production Supabase import function. The function matches the decision marker, accepts the first answer, and makes the source address and answer visible to staff. The Worker forwards the valid reply to the shared Gmail inbox too. Repeated delivery of the same Message-ID does not create another decision.

The existing `info@` forwarding rule remains unchanged and still delivers to the shared Gmail inbox. The capture address is for CRM processing only. The rejected shared-CRM-login decision writer from draft PR #23 is not used, and `core.catering_decision_makers` remains empty. Cloudflare documents free sends to verified Email Routing destinations, including on Workers Free; this specific account still needs a real send test before the workflow is called operational.

## Release sequence

- Apply `database/20261013_catering_decision_email_import.sql` to Nazar-production. Verify the staff token RPC is limited to active staff and the import RPC to `service_role`; direct table access remains denied.
- Create a narrowly scoped Cloudflare Email Sending API token and save it only as `CLOUDFLARE_EMAIL_SEND_TOKEN` in the Nazar Pages project's secret variables. The backend uses it solely to send from `info@` to the existing verified `ctnazarbakery@gmail.com` destination. Confirm the Cloudflare account accepts that free verified-destination send before publishing the button.
- Deploy `workers/catering-decision-email/worker.mjs` as `nazar-catering-decision-email`, storing the Nazar-production `SUPABASE_SECRET_KEY` as a Worker secret. Never copy the key into source, an email, or a browser field that displays it.
- Add one Cloudflare Email Routing rule for `crm-decisions@nazarrestaurantandbakery.com` to this Worker. Do not alter the active `info@` or `admin@` forwarding rules.
- Publish the staff UI and send function only after the database, Worker route and sending token are ready.
- Run a clearly labeled test: Talip reviews and sends a synthetic request from CRM; Yücel replies from `ctnazarbakery@gmail.com` with the required two lines; Talip refreshes CRM and sees the answer under Recent decisions. Confirm the reply is also in the shared inbox. Retry the same message and confirm no duplicate answer. Send a message from a different address and confirm it changes nothing.

As of 13 October 2026 this is prepared locally, not published. No migration has been applied, Worker deployed, routing rule created, email sent, or human acceptance test completed for this version. The live CRM queue continues to work as before.
