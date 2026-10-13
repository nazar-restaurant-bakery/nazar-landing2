# Catering price and menu decisions

Talip tracks catering requests in the staff CRM. Yücel alone decides price and menu. Talip must not enter or sign a decision on Yücel's behalf. Each person's email should identify that person, with their own name in the signature.

## Current behavior

- Staff can mark an existing catering request for Yücel's review. This creates an internal queue entry; it does **not** send an email or quote the customer.
- For a pending queue entry, authorized staff can prepare a reviewable email addressed to `ctnazarbakery@gmail.com`, with the website address `info@nazarrestaurantandbakery.com` copied for Talip. Both addresses currently route to the same shared Nazar inbox; the copy is not a separate private mailbox. The staff member must send it from their own mail account. Yücel replies all and signs his name. The CRM does not send or ingest these emails automatically.
- The queue and any recorded decisions are visible to existing authorized staff.
- `database/20261013_catering_decision_owner_guard.sql` adds a separate, private decision-maker allowlist and restricts the answer-writing function to an active person on that list who also has CRM staff access. No user is on the allowlist yet. Therefore no existing shared CRM session can record a new price or menu answer.
- `database/20261013_catering_decision_mfa.sql` is the next migration. It requires both Nazar Auth accounts to exist, grants the website address staff viewing access, and permits the shared Nazar account to record a decision **only in an authenticator-verified AAL2 session**. Until Yücel personally enrolls his device, no decision can be recorded.
- The staff UI contains Yücel's device setup and verification flow, a decision form shown only after verification, and a recent-decision view for Talip. Deploying the UI or migration alone does not complete the human end-to-end test.

## Acceptance test when Yücel is present

1. Talip opens `/staff` with the invited `info@nazarrestaurantandbakery.com` account and confirms he can view the queue but cannot record a price/menu answer.
2. Yücel opens `/staff` with `ctnazarbakery@gmail.com` on his own device, enrolls an authenticator there, and verifies a code without sharing the QR image or code.
3. Use one clearly labeled synthetic catering request. Talip marks it for a decision; Yücel records a test menu/price decision; Talip refreshes and sees the same recorded decision and timestamp.
4. On a fresh unverified Nazar session, attempt decision writing and confirm the database rejects it. Keep the synthetic record labeled as a test.

## Remaining connection

Talip designated the shared Nazar inbox `ctnazarbakery@gmail.com` for Yücel's operational decisions and changed his copied address to the website's `info@nazarrestaurantandbakery.com`. Both addresses reach the same shared inbox, so email alone cannot distinguish the people. An authenticator kept on Yücel's own device provides the second factor for decision writing; Talip's staff session stays read-only for decisions. Yücel's enrollment and a real sign-in must be completed on his device before claiming personal attribution. Automatic email reply ingestion is a separate future step.

The initial queue was deployed through PR #17 and a synthetic request/answer test passed on 13 October 2026. That test predates the owner guard and is explicitly labeled as a test, not a real Yücel decision. Automatic email alerts and reply ingestion have not been enabled.
