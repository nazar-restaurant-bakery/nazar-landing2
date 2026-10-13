# Catering price and menu decisions by email

Talip marks a catering request for Yücel in the private staff CRM. Yücel alone sets the final menu and price; Talip sees the answer in the same queue. The customer is not quoted or charged automatically.

## Intended workflow

1. Talip opens the request in CRM and marks the price/menu question for Yücel.
2. The **Prepare email to Yücel** button creates a draft with a unique decision marker. Talip sends it **from `info@nazarrestaurantandbakery.com`** to `ctnazarbakery@gmail.com`, copying `crm-decisions@nazarrestaurantandbakery.com`. The mail app's From choice must be checked before sending; `mailto:` cannot set it.
3. Yücel replies all **from `ctnazarbakery@gmail.com`**. Above the quoted message he writes `Decision: ...` and `Signed: Yücel`.
4. A dedicated Cloudflare Email Worker receives the copy at `crm-decisions@`, parses the new reply, and sends it to the Nazar-production Supabase import function. The function matches the decision marker, accepts the first answer, and makes the source address and answer visible to staff. Repeated delivery of the same Message-ID has no further effect.

The existing `info@` forwarding rule remains unchanged and still delivers to the shared Gmail inbox. The capture address is for CRM processing only; the normal email conversation remains in the inbox. The rejected shared-CRM-login decision writer from draft PR #23 is not used, and `core.catering_decision_makers` remains empty.

## Release sequence

- Apply `database/20261013_catering_decision_email_import.sql` to Nazar-production. Verify the staff token RPC is limited to active staff and the import RPC to `service_role`; direct table access remains denied.
- Deploy `workers/catering-decision-email/worker.mjs` as `nazar-catering-decision-email`, storing the Nazar-production `SUPABASE_SECRET_KEY` as a Worker secret. Never copy the key into source, an email, or a browser field that displays it.
- Add one Cloudflare Email Routing rule for `crm-decisions@nazarrestaurantandbakery.com` to this Worker. Do not alter the active `info@` or `admin@` forwarding rules.
- Publish the staff UI and decision email draft function after the database and Worker are ready. Before the Worker route exists, the new draft address must not be used.
- Run a clearly labeled test: Talip sends a draft from `info@`; Yücel replies all from `ctnazarbakery@gmail.com` with the required two lines; Talip refreshes CRM and sees the answer under Recent decisions. Retry the same message and confirm no duplicate answer. Send a message from a different address and confirm it changes nothing.

As of 13 October 2026 this is prepared locally, not published. No migration has been applied, Worker deployed, routing rule created, email sent, or human acceptance test completed for this version. The live CRM queue continues to work as before.
