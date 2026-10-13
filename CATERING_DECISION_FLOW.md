# Catering price and menu decisions

Talip tracks catering requests in the staff CRM. Yücel alone decides price and menu. Talip must not enter or sign a decision on Yücel's behalf. Each person's email should identify that person, with their own name in the signature.

## Current behavior

- Staff can mark an existing catering request for Yücel's review. This creates an internal queue entry; it does **not** send an email or quote the customer.
- For a pending queue entry, authorized staff can prepare a reviewable email addressed to `ctnazarbakery@gmail.com`, with `talipbalik@gmail.com` copied. The staff member must send it from their own mail account. Yücel replies all and signs his name. Talip can follow the thread through the shared Nazar inbox and his copied address. The CRM does not send or ingest these emails automatically.
- The queue and any recorded decisions are visible to existing authorized staff.
- `database/20261013_catering_decision_owner_guard.sql` adds a separate, private decision-maker allowlist and restricts the answer-writing function to an active person on that list who also has CRM staff access. No user is on the allowlist yet. Therefore no existing shared CRM session can record a new price or menu answer.
- The staff UI does not show a decision-entry field until Yücel's personal identity and the reply flow are established.

## Remaining connection

Talip designated the shared Nazar inbox `ctnazarbakery@gmail.com` for Yücel's operational decisions and `talipbalik@gmail.com` for his own copy. This is a routing convention, not proof that Yücel personally authored a message from the shared account. Before recording email replies as decisions in CRM, implement a verified reply-ingestion and attribution process and test that Talip can view but cannot author or alter a decision. The decision-maker allowlist therefore remains empty.

The initial queue was deployed through PR #17 and a synthetic request/answer test passed on 13 October 2026. That test predates the owner guard and is explicitly labeled as a test, not a real Yücel decision. Automatic email alerts and reply ingestion have not been enabled.
