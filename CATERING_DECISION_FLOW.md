# Catering price and menu decisions

Talip tracks catering requests in the staff CRM. Yücel alone decides price and menu. Talip must not enter or sign a decision on Yücel's behalf. Each person's email should identify that person, with their own name in the signature.

## Current behavior

- Staff can mark an existing catering request for Yücel's review. This creates an internal queue entry; it does **not** send an email or quote the customer.
- The queue and any recorded decisions are visible to existing authorized staff.
- `database/20261013_catering_decision_owner_guard.sql` adds a separate, private decision-maker allowlist and restricts the answer-writing function to an active person on that list who also has CRM staff access. No user is on the allowlist yet. Therefore no existing shared CRM session can record a new price or menu answer.
- The staff UI does not show a decision-entry field until Yücel's personal identity and the reply flow are established.

## Remaining connection

Verify Yücel's current individual email address from him or a reliable current record. Do not reuse `yucelotay@gmail.com`, which Talip said is not current, or assume that an older shared address belongs only to Yücel. Then connect a personal reply path: the request reaches his own mailbox, his reply is signed with his name, and the CRM preserves the email evidence before displaying his decision to Talip. Test that Talip can view but cannot author or alter it.

The initial queue was deployed through PR #17 and a synthetic request/answer test passed on 13 October 2026. That test predates the owner guard and is explicitly labeled as a test, not a real Yücel decision. Email alerts and reply ingestion have not been enabled.
