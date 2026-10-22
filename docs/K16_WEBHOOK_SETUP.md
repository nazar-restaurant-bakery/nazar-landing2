# K16 Hosted Checkout webhook setup

The payment endpoint remains `/api/catering/clover-webhook`. The three Clover
redirect URLs remain `/catering?payment=pending`, `failed`, and `cancelled`.
Neither a redirect nor an unsigned request can mark an order paid.

For a live Clover callback verification code, keep both customer checkout
flags off. Temporarily set `CLOVER_WEBHOOK_VERIFICATION_ENABLED=true` in the
Production Pages environment and redeploy. Only an unsigned POST to the
canonical Nazar hostname with exactly one `verificationCode` field is accepted;
it writes the code to the Function log and returns 200 without reading or
writing orders. Read the code in a Production `wrangler pages deployment tail`
session, enter it in Clover, then disable the flag and redeploy. Do not paste
the code into tickets, GitHub, or chat. Clover's Hosted Checkout documentation
does not specify this verification request shape; if no matching code appears,
stop and inspect the request safely rather than opening checkout.

After Clover issues the signing secret, store it only as the Production Pages
Secret `CLOVER_WEBHOOK_SIGNING_SECRET`. Approved payment notifications require
its valid signature and an independent Payments Read GET. The verified payment
is applied through `site_order_payment_confirm_v1` for a matching private site
order, with idempotent session/payment checks; only an explicitly unknown
site-order session may use the existing legacy catering path. Do not turn on
`CATERING_CHECKOUT_ENABLED` or the client build flag during callback setup.
