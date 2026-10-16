# Clover storefront order visibility — staged

The existing Clover Online Ordering storefront remains the live ordering system. This change adds a **read-only** section to Nazar's private `/staff/crm` screen. Staff explicitly loads recent orders; the server uses the existing `crm_staff_authorized_v1` allowlist before requesting Clover. The browser never receives a Clover token. The response contains only Clover order ID, time, order type, total, order state, and payment state. It does not copy customer contact details into Nazar's CRM or claim that a Clover order came from the Nazar website.

## Activation prerequisites

1. Obtain production Clover OAuth authorization for Nazar's merchant with **Read orders** permission. Clover production access tokens expire; arrange secure refresh/rotation before relying on this operationally. A sandbox token is not a production credential. Store the active token only as Cloudflare Pages secret `CLOVER_ORDERS_ACCESS_TOKEN`.
2. Store the verified production merchant ID as `CLOVER_MERCHANT_ID` and the verified Clover Online Ordering pickup/delivery order-type IDs as comma-separated `CLOVER_ONLINE_ORDER_TYPE_IDS`. Do not guess from display names or reuse POS order types. These are server variables, not `VITE_` browser variables. The Nazar merchant dashboard URL confirmed the production merchant ID **`F8Q154GMDKFD1`** on October 16, 2026; the online order-type IDs remain unverified.
3. With an allowlisted staff account, load the last seven days in `/staff/crm`. Confirm that the October 15 test delivery order **`VC9D60CHEKW4M`** appears **once**, with **$44.53** and **PAID** as shown in Clover Orders on October 16, 2026. Check one POS sale does **not** appear. Confirm an unlisted authenticated account and an anonymous visitor cannot access the route.
4. If the read fails or reaches a page limit, use Clover Orders as the source of truth and investigate. The panel explicitly marks partial results. No customer order-history linkage, marketing attribution, or new-order alert is implied by this view.

Without the secrets/configuration, the panel says the connection is not set up. Production order details above were checked manually in the merchant dashboard; the CRM API connection has not read production orders yet. No database migration is required.

Reference: Clover [REST API base URLs and production OAuth](https://docs.clover.com/dev/docs/making-rest-api-calls), [list orders](https://docs.clover.com/dev/reference/ordergetorders), [order permissions](https://docs.clover.com/dev/docs/gdp-set-app-permissions).
