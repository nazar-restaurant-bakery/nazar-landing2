# Catering price and menu decisions

Talip and Yücel use the existing shared Nazar CRM access. Talip can flag a
catering request when its price or menu requires Yücel's decision. After Yücel
confirms the answer, either staff member can record it in the same queue;
Talip sees the outcome in the customer record and continues follow-up. The CRM
stores which authenticated account recorded the answer. Since the account is
shared, it cannot prove which person entered it.

## Local implementation

- `database/20261013_catering_decision_queue.sql` adds a private decision table
  and staff-only functions. A person with existing Nazar staff access can record
  Yücel's confirmed answer. No existing customer or catering request is changed
  by the migration.
- `/staff` shows pending price/menu decisions, lets staff send a specific
  request to the queue, and lets staff record the answer
  directly from the queue even when the request is outside the 100-record list.
  The queue refreshes while the staff page is open.
- The decision is visible to authorized staff after it is saved. It does not
  silently change the catering request status or quote a customer.
- `database/20261013_catering_decision_notifications.sql` records one private,
  retryable notification event when a decision is requested and another when
  it is answered. It sends no email; a sender must consume these events.

## Activation and checks

1. The decision migration was applied to Nazar-production on 13 October 2026.
   The anonymous role cannot read the decision table or execute the listing
   function; the authenticated role can execute it, subject to the active staff
   check inside the function. No new login or role was granted.
2. PR #17 was merged into `main` and Cloudflare Pages production deployment
   `fe6f1b85` succeeded on 13 October 2026. The live `/staff` screen loaded
   the decision queue for the existing staff session.
3. An existing synthetic catering request was sent to the queue, answered
   with an explicitly labeled test answer, and verified again after reloading
   the live page. The test neither quoted nor contacted a customer.
4. Future work: send new CRM decision alerts to the shared staff inbox,
   `ctnazarbakery@gmail.com`, so Talip and Yücel can both see them. The current
   system has no outbound transactional email service for CRM alerts; this
   address is a routing target, not an active notification. Apply the separate
   notification migration, add a sender that consumes its outbox, prevent
   duplicate alerts on retries, and verify delivery before activation.
   Keep VIP marketing email and its consent status in Klaviyo. SMS or Telegram
   may be added later without changing the decision queue.

No notification has been sent to Yücel. The decision migration did not change
existing customer records or catering requests.
