# K16 order and payment foundation (proposed migration order 18)

This PR adds private `core.site_orders`, `core.site_order_payments`,
`core.site_order_events`, and `core.site_order_tickets`. Every row has a
`business_id`; order, payment, event, and ticket relations are tenant-bound.
The service-role RPCs create an idempotent order, attach one active Clover
session, confirm an independently verified payment, and optionally link the
later K7 Clover order/payment records. The database refuses an actionable
kitchen ticket without a verified payment. No customer checkout screen or
webhook receiver is enabled by this PR.

The existing catering checkout route remains disabled by
`CATERING_CHECKOUT_ENABLED`. Its configuration now also requires
`SITE_BUSINESS_ID`, `SITE_PRODUCTION_SUPABASE_URL`, and
`CLOVER_TAX_RATE_MICROS` (Clover units; 735000 means 7.35%). Sandbox
requires `CATERING_SANDBOX_SUPABASE_URL` different from the production URL.
`CLOVER_MERCHANT_ID` is read from the environment rather than from code.
The current legacy `public.catering_orders` checkout write path is not yet
switched to `core.site_orders`; that integration belongs to the later customer
checkout PR, after the webhook and staff flow are ready. Keep all live checkout
flags off until those PRs and the sandbox payment reconciliation pass.

The exact LF migration bytes are SHA256
`c8d92ad4a69b0c46ea3578054f92bd2aa675bd92ea5e4e2e161f040445aa0953`.
The operator scripts and the order-17 receipt prerequisite are in the local
`20_Yonetim/Teslim_Raporlari/K16Foundation_kanit` package. The proposed
order-18 line belongs in `Migration_Sirasi.md` after coordination review.
Neither this inventory entry nor this PR applies SQL to a hosted database.
