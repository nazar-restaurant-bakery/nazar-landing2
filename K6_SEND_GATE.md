# K6: one campaign/flow email gate

This change prepares the shared database gate and a **synthetic-only** orchestration model. It includes no real provider transport, email endpoint, key, scheduler or campaign/flow activation. Existing VIP confirmation, K5 profile synchronization, public forms and GA4 are unchanged.

## Quota and reservation

`core.message_send_settings` stores the business setting. The default interval is **168 hours** (the Nazar requirement). Missing settings and `enabled=false` both deny dispatch. The migration does not enable sending or insert a fixed business identity. A future activation must provision the selected business explicitly; the window is not accepted from a campaign, flow or browser request.

`core.message_log` is the common email ledger. Both message kinds use the same business/person lock and quota; changing campaign, flow or idempotency key does not reset it. A message key identifies one recipient delivery, not a whole batch. Payload and recipient/identity fingerprints are bound to that delivery. Only terminal sent rows age out of the rolling window; unresolved reservations, claimed/sending/unknown and blocked records continue to block until an explicitly reviewed recovery action. There is no automatic quota refund, expired-lease retry or recovery UI in this change.

Service-only RPC contract:

1. `message_send_reserve_v1`: validate the intent, current eligibility and shared window under the person lock; reserve or deny.
2. `message_send_claim_v1`: acquire a single durable lease. A lost claim acknowledgement never grants a second dispatch.
3. `message_send_context_v1`: recheck consent/suppression, identity, setting and time, then consume the authorization once.
4. `message_send_finalize_v1`: record sent/unknown/blocked. An uncertain acknowledgement never triggers another send.

The setting/log tables remain in private `core`, with RLS enabled and no direct anon/authenticated/service-role table grants. Only the four allowlisted RPCs are executable by service role. No positive-consent or suppression state is changed. Customer eligibility reuses the reviewed K5 rule. The SQL contract requires Read Committed isolation; other isolation levels fail closed instead of relying on a stale snapshot after a lock wait.

The TypeScript gate accepts only the exact agreed intent and a transport explicitly declared synthetic. It has no production adapter or fetch implementation. Test `sent` results always carry `synthetic:true`; they are not real email receipts. Real campaign/flow adapters must use the same complete reservation path before any future send.

## Vendor boundary

Klaviyo's account UI is an independent execution surface. This database cannot prevent a human from manually activating a native Klaviyo flow or campaign. The read-only Nazar inspection found one flow, **Nazar VIP — Welcome (draft)**, with Draft status and no other flows. No vendor setting was changed. A future activation must keep every marketing campaign/flow behind the gate; a native direct-send bypass is not authorized by K6. The existing double-opt-in confirmation path remains separate.

## Migration and operator

Migration: `supabase/migrations/20261020000800_message_send_gate.sql`, deployment order **5**, after Ops (3) and K7 (4). Real dependency tables/functions are checked before DDL; missing dependencies abort. The pending K7 migration is not copied into this PR or applied remotely.

See [K6_OPERATOR.md](K6_OPERATOR.md) for the one-command **PowerShell 7** launcher. It uses the same pinned psql 18.6 / Direct connection / TLS validation method as K4/K5, validates LF bytes and hashes before asking Talip for a masked password, and requires a matching successful K6 TEST receipt before Production. No credentials belong in the command, config, report or PR. This delivery does not run a hosted migration. Production remains a later Talip action after the required earlier migrations.

Evidence covers synthetic 167-hour refusal, 169-hour authorization, shared campaign/flow quota, and two native PostgreSQL sessions competing for one authorization. Exact results and tooling limits belong in the delivery receipt; no real sends are performed.
