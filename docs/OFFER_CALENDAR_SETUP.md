# Nazar offer calendar — operator steps

The November–January calendar is awaiting Yücel's approval. No old-project drafts
are imported by this change. Importing an approved offer records it as inactive;
it does not publish the offer or configure Clover's discount rules.

1. Apply `supabase/migrations/20261021000950_offer_calendar_activation.sql`
   to **Nazar-catering-sandbox** (`uxiseddbeszklkrvysxf`) after order 15. Verify
   `to_regprocedure('public.set_offer_active(uuid,boolean)') IS NOT NULL`.
   Apply the same reviewed bytes to Production only after Sandbox passes and
   Talip decides to proceed. This is proposed migration order **15b**, before
   the pending order 16 migration.
2. After Yücel has approved each exact offer, make a copy of
   `supabase/offer-calendar/approved-offers.template.sql`. Replace the all-zero
   business UUID with the target business ID and the empty JSON array with an
   array of objects containing `name`, `description`, `code`, `starts_at`,
   `ends_at`, and `approval_reference`. Example **format only**, not an approved
   Nazar offer:

   ```json
   [{"name":"EXAMPLE ONLY","description":"Exact customer-facing terms","code":"EXAMPLE-01","starts_at":"2026-11-02","ends_at":"2026-11-08","approval_reference":"Yücel approval YYYY-MM-DD, source"}]
   ```

   Run that exact edited file in Sandbox SQL Editor first. Check its count and
   `active=false`; confirm duplicate code, invalid date, and overlapping date
   variants are rejected in isolated test transactions. Then Talip may run the
   same file in Production. The SQL is atomic: an error rolls back the batch.
   A repeated run intentionally fails rather than duplicating offers. No
   passwords or API keys belong in this file.
3. Sandbox Ops check: `/staff/ops` should show the approved offer and
   `offer_set_active` capability. A staff action goes through
   `ops_request_action` → `ops-collect` → `ops_apply_offer_action` →
   `set_offer_active`. Confirm active=true and active=false in Sandbox only.
   `approvalReference` typed in the browser is an audit note; it never grants
   approval. The trusted approval row stores a fingerprint of the exact terms.
4. Sandbox Specials check: for a **non-test** Sandbox offer valid on the current
   New York date, run `SELECT name FROM public.get_active_offers('<business-id>'::uuid);`
   and confirm the Sandbox `/specials` page shows that name. The Sandbox web
   build must point to `uxiseddbeszklkrvysxf`; otherwise the browser page is
   not a Sandbox check. Future-dated, inactive, or `is_test=true` offers must
   not appear. Deactivate the synthetic offer after the check.

The offer code shown on Specials is display text. This work does not make a
Clover coupon redeemable at checkout; that requires a separate verified
redemption path before customer-facing publication.
