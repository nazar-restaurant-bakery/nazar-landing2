# Catering quote management: local design

The public **Request a Quote** action creates one actionable request in Nazar's catering operations queue. Talip's **Customer follow-up** page shows the same request and its stage, but is not the place where menu and price are approved. A quote is not an order or a payment.

## Request content

Keep one stable request ID across intake, quote versions, customer communication and CRM. Store these fields separately: customer's available contact method, event date, pickup or delivery request, selected trays with sizes and quantities, custom dishes with quantities, free-text message, submitted time, and the price shown on the site if one was shown. A form-only request is valid; a combined tray and custom request must remain one request.

Today `/api/signup` appends a human-readable menu summary to `p_meta.message`. That text is visible in the CRM, but it cannot reliably populate editable product rows in an operations screen. The local change stores a validated `menu_selection` snapshot and a separate `customer_message` alongside that readable summary. The database migration expands the metadata allowlist and preserves retries initiated before this change. It has **not** been applied to Nazar-production; deploying the API before that migration would reject new selections. Compare the deployed `submit_signup` definition with the migration before applying it so later database changes are not overwritten.

The current public form records tray guest size and its displayed quantity. It does not yet ask for a quantity on custom dish ideas; those snapshots explicitly say `quantity: null` and must be clarified during the quote. Do not invent a quantity of one.

## Nazar operations queue

Each new request appears with its ID, customer contact, event date, selected items, customer message and current stage. The stages are **new → reviewing → quote ready → quote sent → accepted/declined**. The queue shows who must act next and when the request last changed. A new request cannot silently become a paid order.

The local `catering_ops_requests_v1` read model joins a request to the structured signup snapshot. Its access list is initially empty and grants nobody new access. The sample preview is still disconnected from this read model.

The development-only `/catering-ops-local` page now reads actual catering requests through the **existing** `crm_overview_v2` staff permission. It requires a local staff session, is read-only, and shows the current request text, customer contact, event date and status. It does not grant any new access. Older requests still have their selections embedded in text; this page does not pretend they have structured item rows. On October 13, a signed-in local staff session loaded seven existing closed test requests; the unauthenticated view disclosed none. There were no open requests to exercise. This is a transitional operations view, not a live quote approval or sending workflow.

Yücel supplies the final menu and price. Talip may read the decision and follow up, but must not be required to enter Yücel's answer. An approved quote captures a version number, menu, amount, pickup/delivery terms and approval time. Changing an approved quote creates a new version rather than silently overwriting what the customer saw. The customer is contacted using the method they supplied; email must not be assumed for phone-only inquiries. A sent quote and the customer's answer are recorded against the same request.

The next local implementation draft uses a 48-hour, one-use review link for the shared Nazar/Yücel mailbox. Staff prepares an email containing the link; Yücel enters his name, final menu, tax-inclusive total and pickup terms on the linked screen. The database records a new immutable quote version. The signed name and possession of the mailbox link are the attribution available in this arrangement; no separate Yücel account or second factor is introduced. Issuing another link invalidates the old one. The token is held in the URL fragment so ordinary page requests do not include it. The SQL and page code are local only; the migration has not been executed on Nazar-production or the sandbox.

For the first delivery version, staff opens the exact approved quote in a Nazar email draft and sends it manually. Only after sending does staff explicitly record delivery against the same quote version. Opening an email draft never marks it sent. The quote email says payment has not occurred. Cloudflare's [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/) requires Workers Paid for arbitrary customer addresses, so automatic sending is deferred.

## Customer follow-up

Talip's page displays the request ID, current stage, last action, approved amount if available, and next follow-up. It links to the operations record but does not substitute for the operations queue. VIP email consent and marketing activity remain separate from a catering quote request.

## Local acceptance before any live release

1. Submit form-only, tray-only and combined synthetic requests; each appears once in the operations queue with intact item quantities and message.
2. Yücel's menu/price decision is visible in the operations record and reflected in Talip's follow-up view without Talip retyping it.
3. Review the exact customer quote before sending. A failed send remains retryable and cannot be marked sent merely because a button was pressed.
4. Record customer acceptance or decline against the quote version they received; do not start payment automatically.
5. Reject unauthorized reads and writes, and prove one customer's request cannot be confused with another.

The `/catering-ops-preview` route is development-only and uses synthetic data. It demonstrates the screen and stage transitions; it does not read real requests, send quotes or take payments. The live site has not been changed by this preview.
