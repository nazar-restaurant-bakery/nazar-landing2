# K5 controlled profile acceptance and cleanup

Controlled execution and cleanup are complete. Talip subsequently applied the identical Production database migration through a separate handoff; its 20/20 receipt audit and 23/23 read-only post-install DB checks passed. No Production provider key, sync enablement or PR merge was performed. Formal Talip acceptance remains separate; this record does not declare K5 closed. The runtime source and reviewed migration bytes were unchanged during this execution. Private receipts contain exact comparisons; this document contains no contact values, customer/profile identifiers, project/business identifiers or secret values.

## Approved boundary and preflight

Talip approved one synthetic fixture in the isolated database, temporarily simulating `subscribed` with `is_test=false` as an explicit, exact-customer exception. This is neither real customer consent nor permission to weaken ordinary test exclusions. The existing three marked test customers remained excluded. Production was outside the operation.

The intended provider account was confirmed before the test. Observed preflight showed one Draft flow/email, no Scheduled or Sending campaign, a Free plan with 1/250 active profiles, and zero matches for the exact new controlled alias. The approved temporary maximum was two profiles. No email, subscription, list, suppression or event operation was added to the profile writer.

## Execution observations

| Step | Observation | Evidence limit |
|---|---|---|
| Mock failure | One manual mock 429 command produced one retry job at attempt one; the error row was visible in the staff UI. | A synthetic failure, not a provider outage. |
| Scope transition | Mock and live used separate account labels and one pinned customer. | The account label is a queue namespace, not independent proof of a key's provider account. |
| First live command | One processed profile reported success. | No raw request/response trace was captured. |
| Unchanged second command | Zero jobs processed. | No second provider call is inferred from the unchanged succeeded queue and source branch; it is not a raw captured HTTP count. |
| Provider readback | Exactly one matching profile, with the same identifier across checks; `crm_name` and `crm_registered_at` present. | Unknown source, UTM and tags were omitted rather than invented or cleared. |
| Consent | Provider consent remained `NEVER_SUBSCRIBED`. | This is not marketing subscription or a general no-send/no-billing guarantee. |

The second command demonstrates durable unchanged-payload queue idempotence. It does not establish a fresh provider-consent read on every unchanged command: succeeded unchanged jobs are not claimed again. The existing provider-negative rule remains unchanged: observed unsubscribe/suppression blocks property writing and records negative local evidence.

## Usage observations

Before cleanup, displayed email usage remained 1/500 and displayed cost remained $0. A later active-profile index showed two, within the approved allowance of 250. That index count is not proof of unsuppression. The observations are limited to the displayed test period; deletion does not reverse billing history, and no ongoing free-use guarantee is made.

## Cleanup and final state

Talip revoked the temporary provider key and deleted the single newly created profile. The Preview binding was removed, and a keyless disabled deployment succeeded. Fresh readback showed Profile Not Found and zero exact-alias matches. The writer itself still has no delete adapter.

Scoped SQL cleanup committed only the approved synthetic fixture and its two jobs. Full-field MD5 comparisons proved the original three customer records unchanged. Final isolated aggregate counts were:

- Customers: **3**, all marked test.
- Eligible profile-sync customers: **0**.
- Sync jobs: **0**.
- Consent events: **0**.

Preview remains **disabled** without the temporary key binding. No scheduled run, additional provider operation, Production migration or merge is authorized by this completed controlled method.

## Subsequent Production database stage

Under a separate human-operated handoff, Talip applied the migration at **2026-10-20T04:00:35.944397Z (20 October, 00:00 EDT)**. A 20/20 independent receipt audit matched the successful TEST proof and the exact same LF migration, psql 18.6 binary, TLS CA, frozen sources and reviewed operator. Production executed a read-only target preflight and the migration, without running the synthetic acceptance fixture SQL.

The independent read-only post-install database check at **04:04:25.386294Z** passed **23/23**, with zero failed or missing checks and zero jobs. It verified all seven function bodies against the exact reviewed LF migration, closed-core/RLS/grants, the K4 suppression guard, four immutable-evidence ALWAYS guards and two existing staff grants. This is separate database evidence, beyond the commit receipt and file hashes. No provider key was added to Production, sync was not enabled, and no PR was merged by this database stage. Formal acceptance remains Talip's decision.

The earlier [runtime and empty-mock validation](runtime-validation.md) is preserved as historical evidence. [K5 operational and release instructions](../../K5_PROFILE_SYNC.md) describe the remaining separate acceptance and enablement gates. Historical validation JSON and test outputs were not rewritten to incorporate these later observations.
