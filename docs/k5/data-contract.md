# K5 database contract: profile-only sync

Local preparation only. No migration has been applied to a hosted database by this work. This file does not authorize a provider write, credential/configuration change, Auth operation, automatic schedule or production deployment.

## Migration and privacy

Apply `supabase/migrations/20261019000300_klaviyo_profile_sync.sql` as exact LF bytes using the same reviewed migration tool in test and production, after the reviewed baseline and accepted K4. The legacy SQL and MD5 guards are unchanged. No new business or project ID is embedded. Business and provider account come from trusted server runtime configuration; provider account is the non-secret account identifier, not an API key.

The migration adds private `core.klaviyo_profile_sync_jobs`, two private payload/eligibility helpers and five public RPC wrappers. Core remains closed to anon/authenticated/service_role. The queue has RLS enabled and no direct table grants to those roles. Public wrappers have an empty search path; only the service role may mutate/read worker context. The staff wrapper requires authenticated role plus active existing `crm_staff` membership. Existing tenant restrictions and staff model are unchanged; no second-tenant work is included.

One durable row exists per `(business_id, customer_id, provider_account)`. The queue stores IDs, SHA256 fingerprints and safe operational metadata rather than a copied email/name/message payload. Worker context obtains current fields only for a valid lease and eligible customer. Staff queue metadata has no email, name, form message, provider response body, JWT or secret.

## Exact RPC signatures

All functions return JSONB. Parameter names below match PostgREST named JSON arguments.

| RPC | Parameters | Permission |
|---|---|---|
| `crm_profile_sync_queue_v1` | `p_business_id uuid` | active authenticated staff, read only |
| `klaviyo_profile_sync_enqueue_v1` | `p_business_id uuid, p_account text, p_limit integer DEFAULT 100, p_customer_id uuid DEFAULT NULL` | service only |
| `klaviyo_profile_sync_claim_v1` | `p_business_id uuid, p_account text, p_customer_id uuid DEFAULT NULL` | service only |
| `klaviyo_profile_sync_context_v1` | `p_job_id uuid, p_lease_id uuid` | service only |
| `klaviyo_profile_sync_finish_v1` | `p_job_id uuid, p_lease_id uuid, p_outcome jsonb` | service only |

`p_limit` is 1–500. `p_account` matches `[A-Za-z0-9_-]{1,100}`. Optional customer selection must identify a customer belonging to the provided business. It narrows collection/claim to that one customer; it never bypasses consent, suppression or test exclusion. A marked synthetic test customer is still ineligible. Any future provider test policy needs a separate explicit design/authorization; there is no hidden fixture bypass.

`enqueue` returns `{enqueued, unchanged}`. It inserts a new row or requeues a changed profile revision; unchanged terminal successes and exhausted failures are not reset by repeated collection. New/changed customers have priority so a small collection limit does not repeatedly select only unchanged successes. A legitimate changed payload starts a new bounded revision using the same job row. Account scoping is explicit, so a different configured provider account has a separate job.

`claim` returns null or `{jobId, leaseId, attempt, leaseExpiresAt}`. It uses row locks/SKIP LOCKED, a new random token, 120-second lease and at most six attempts per payload revision. It rechecks current local eligibility before granting work. An expired worker cannot finish a replacement lease. Unknown provider-write results are retried as idempotent profile upserts using the same stable key for that revision; no marketing operation is retried.

`context` must be called immediately before the provider write. A valid response is:

```json
{
  "eligible": true,
  "jobId": "uuid",
  "customerId": "uuid",
  "businessId": "uuid",
  "account": "configured-account-id",
  "fingerprint": "64 lowercase hex characters",
  "idempotencyKey": "k5:<jobId>:<fingerprint>",
  "eligibility": {"emailStatus": "subscribed", "isTest": false, "suppressedAt": null},
  "profile": {"email": "current normalized email", "name": "stored full name or null", "source": "latest stored signup source or null", "createdAt": "stored customer timestamp", "utm": {}, "tags": null}
}
```

`profile.createdAt` is the existing registration timestamp, not a claimed order/last-purchase date. Latest signup supplies source and only string-valued `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`. No signup or non-object/null UTM means null (unknown), so the adapter omits that provider property. An explicitly stored empty object remains `{}` (known empty). Arbitrary meta, contact phone, messages and consent evidence are not exported. No existing canonical tags field exists: tags is null, not an invented segment. A typed adapter may represent this as an empty array while preserving the documented missing-data limitation. Names are not guessed/split. Payload time serialization uses UTC for stable fingerprints.

False context responses mean **do not perform the provider write and do not call finish for that token**:

| Reason | Returned durable status | State change |
|---|---|---|
| `customer_ineligible` | `blocked` | lease cleared |
| `payload_changed` | `queued` | new fingerprint/revision, attempts reset, lease cleared |
| `lease_expired` | current status or `missing` | no mutation; token is invalid |

`crm_profile_sync_queue_v1` returns `{items, counts}`. Items contain `jobId, customerId, account, status, attempts, maxAttempts, nextAttemptAt, leaseExpiresAt, updatedAt, lastSuccessAt, lastErrorCode` (100 most recently updated). Counts cover the whole business queue by state, not merely the displayed page. `maxAttempts` is six. States are `queued`, `running`, `retry`, `succeeded`, `failed`, `blocked`.

## Eligibility and consent boundaries

Eligibility requires existing local `subscribed`, no suppression timestamp, usable email, no customer test marker, no test signup, no known internal-test pattern, and no stored provider block/status. Optional K3 customer markers are detected without making this migration depend on those columns. Local `not_subscribed`, `pending_review` and `unsubscribed` never become eligible by enqueue, profile upsert or provider success. Stored negative provider block remains fail-closed even if a later snapshot is positive. A K4 reconsent does not silently unblock the provider.

The final context check and provider HTTP request cannot be one atomic database transaction. The worker must recheck immediately before writing; the operation is restricted to profile properties, with no message, subscription/list-add, unblock or consent update. Finish also rechecks local state and payload, so a later suppression is never overwritten or reported as an eligible synchronized revision. This does not claim to eliminate every timing gap across external systems.

## Finish outcomes and safe errors

Allowed `p_outcome` keys only: `status`, `errorCode`, `retryAfterSeconds`, `providerStatus`, `providerUpdatedAt`. Unknown keys/raw messages are rejected with SQLSTATE `22023`. Example outcomes:

```json
{"status":"succeeded"}
{"status":"retry","errorCode":"unknown_write","retryAfterSeconds":120}
{"status":"failed","errorCode":"provider_auth"}
{"status":"provider_blocked","providerStatus":"unsubscribed","providerUpdatedAt":"2026-10-19T12:00:00Z"}
```

Only `unsubscribed`/`suppressed` are accepted provider-status outcomes. Under a valid lease and unchanged email identity, this invokes the existing sanctioned `record_klaviyo_status_v1` atomically, preserving its negative observation, K4 wall-clock suppression and evidence behavior. It never records confirmed/subscribed, changes permission positively or unblocks the provider. An old address's negative evidence is not applied to a different current email identity; a changed payload is queued for a new revision instead.

Safe error enum: `provider_timeout`, `provider_network`, `provider_rate_limited`, `provider_auth`, `provider_rejected`, `provider_unavailable`, `unknown_write`, `configuration_missing`, `payload_changed`, `customer_ineligible`, `lease_expired`, `attempts_exhausted`, `provider_unsubscribed`, `provider_suppressed`.

Retry/failed outcomes require an enum error. Retry delay is at least exponential 5/10/20/40/80/160 seconds, with optional provider Retry-After 0–86400 seconds as a minimum. The sixth unsuccessful attempt becomes terminal failed; it cannot claim again unchanged. Expired sixth leases also become failed. No automatic immediate duplicate write is issued. Stale finish returns `22023` and cannot overwrite a replacement worker's state. Finish returns `{status, attempts, nextAttemptAt, lastErrorCode}`.

Positive completion writes only queue metadata. If a new payload appeared during the provider request, it queues that new revision instead of claiming the new data was already synchronized. If local permission became ineligible, completion is blocked and local consent remains untouched. No Klaviyo response body, credential or personal error text is stored.
