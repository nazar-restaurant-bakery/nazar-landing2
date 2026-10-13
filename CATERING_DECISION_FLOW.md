# Catering price and menu decisions

Talip tracks catering requests in the staff CRM. Yücel alone decides prices and menus. Talip must not enter or sign a decision on Yücel's behalf.

## Shared-login workflow

1. Talip marks a request as needing Yücel's price/menu decision. The CRM keeps it in the pending decision queue.
2. Yücel opens the existing Nazar CRM account (`ctnazarbakery@gmail.com`), reviews the request, types the final decision himself, and enters his own name in the signature field.
3. The CRM records the decision against the request. Talip refreshes the queue and sees the signed answer in Recent decisions.

There is no additional CRM account or authenticator setup. The existing decision-maker allowlist remains the server-side gate: only the shared Nazar login is added, and other CRM staff logins do not gain decision-writing access. The signature is self-declared. Because Talip and Yücel share one login, the system cannot independently establish which person typed a decision. If independently verified attribution becomes necessary, separate personal logins will be required.

The email draft is optional for notifying Yücel. Opening it does not send a message or record a decision. Automatic email alerts and reply ingestion are not enabled. No CRM decision sends a quote or charges a customer by itself.

## Release and acceptance

The database migration `database/20261013_catering_decision_shared_login.sql` and staff UI must both be deployed. Before production release, verify the shared Nazar user is the sole active decision maker, another staff user cannot call the record function, and anonymous access is rejected. For the human acceptance test, use an explicitly labeled test catering request: Talip places it in the queue, Yücel personally enters and signs a test decision, and Talip refreshes to confirm it appears. Do not mark that final test complete until Yücel has actually performed his step.
