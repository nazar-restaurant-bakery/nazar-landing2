# K5 profile sync — provider and store contract

Local preparation only. No account, key, environment or provider write has been performed. The existing public VIP subscription flow is outside this module.

## Official API basis

The official [Create or Update Profile reference](https://developers.klaviyo.com/en/reference/create_or_update_profile) documents server-side `POST https://a.klaviyo.com/api/profile-import`, 200 for an existing profile and 201 for creation; its displayed request/header revision is `2026-07-15`. The engine pins that revision instead of inheriting the site's latest revision. This is a synchronous email-identified upsert, not the bulk-import job API.

[Get Profiles](https://developers.klaviyo.com/en/reference/get_profiles) supports email filtering and `additional-fields[profile]=subscriptions`. [Profiles API overview](https://developers.klaviyo.com/en/v2024-07-15/reference/profiles_api_overview) explains that subscription data must be explicitly requested and that changing profile properties is separate from subscribing a profile. The explicit v2026-07-15 reference URLs were unavailable to the browser reader; the current official create/update reference explicitly showed revision 2026-07-15. No other revision is sent by the implementation.

## Dependency injection

`runProfileSync({lease, store, provider, now?, timeoutMs?})` has no global fetch, API key, log, scheduler, fixed business/project ID or account operation.

- `SyncLease`: `jobId`, `leaseId`, `attempt` (1–6), optional `leaseExpiresAt`. Store validates the lease and its expiry.
- `SyncContext`: `businessId`, `customerId`, `accountId`, `email`, `name`, `source`, `registeredAt`, `utm`, `tags`, `emailStatus`, `isTest`, `suppressedAt`; optional known provider block/receipt fields. SQL context can be mapped to these names by the server adapter.
- `store.readContext(lease)` returns the current scoped context or null. It is called initially and immediately before **every** provider request. Only literal `emailStatus='subscribed'`, `isTest=false`, `suppressedAt=null`, with no known provider block, is eligible. Every other state makes zero new provider calls.
- `store.finish(lease,outcome)` is the only store write. For `provider_blocked`, it must atomically preserve/record the negative local consent evidence and finish the lease. A newly observed unsubscribe must never be treated as a positive profile sync. Store failures return a fixed `local_store_unavailable` result; lease recovery belongs to SQL/operator code.
- `provider.request({accountId,method,url,headers,body?,signal})` is injected. It returns `{status,headers?,body}`. The root transport selects the configured account key, adds Authorization and performs fetch with `redirect:'error'`; the engine never receives or logs a key. It must respect AbortSignal. Mock mode injects a mock transport, never a live client.

## HTTP allowlist and payload

Exactly two outbound operations are possible:

1. `GET /api/profiles` at exact origin `https://a.klaviyo.com`, with precisely `filter=equals(email,<JSON-quoted normalized email>)`, `additional-fields[profile]=subscriptions`, and `page[size]=2`.
2. `POST /api/profile-import` at that same origin, no query, only `data.type='profile'` and `data.attributes.email` plus managed custom `properties`.

Managed properties are only `crm_name`, `crm_source`, `crm_registered_at`, `crm_utm`, `crm_tags`. These map respectively to the local full name, source, ISO signup date, five standard UTM fields, and sorted/deduplicated local labels. `crm_tags` is a custom property array; it does not use Klaviyo's native Tags API. Email is the upsert identity, not a consent field. Missing local name/source/UTM/tags is omitted; unknown data is never invented as an empty object or array. The existing schema has no tags field, so SQL currently returns tags null and no tag value is exported. Explicit known-empty UTM/tags can still be represented as `{}`/`[]`. Click IDs, landing path, referrer and other nonstandard attribution keys are not exported. The module does not clear unrelated native profile fields.

No list relationships, subscription, suppression, event, bulk job, native-tag, identifier replacement or arbitrary-property operation exists. Provider pagination, error links, conflict profile IDs and redirects are never followed. Unknown profiles can be created with properties only; no subscription is implied or requested.

## Negative evidence and idempotence

GET must yield zero or one unambiguous exact-email profile, with no further page. Existing profiles require valid subscription metadata. `UNSUBSCRIBED` always wins even if optional suppression fields are absent. Global/list suppression, or a subscribed profile unable to receive email, produces a local `provider_blocked` outcome; no POST follows. Missing/malformed metadata fails closed. An unblocked `NEVER_SUBSCRIBED` profile permits only attribute updates under verified local consent; provider consent remains untouched. This also permits reconciliation of a profile previously created without subscribing it. A known local/provider block prevents even the GET. A valid provider timestamp is used when available; otherwise an explicit unsubscribe is recorded at its observation time, never with a future date.

Before POST the current local state is read again. Identity/account or managed-payload change cancels this snapshot; a queued job cannot retarget another email/account or write stale fields. The SHA-256 fingerprint binds the normalized managed payload, revision, business/customer/account and email. SQL may use its own canonical queue fingerprint; the adapter must not overwrite it with this engine hash without an explicit matching contract.

Every eligible attempt begins with the email GET. If the provider already holds the exact managed fields, the job succeeds without POST. This reconciles a lost POST acknowledgement or a lost local success receipt. A 409 is queued for a later attempt, which begins with a new eligibility read and GET; it causes no immediate second write. The upsert endpoint preserves email identity and does not trust a profile ID from an error.

## Outcomes and retries

Statuses: `succeeded`, `retry`, `failed`, `provider_blocked`. The adapter maps fixed lower-snake `errorCode`, `retryAfterSeconds`, `providerStatus`, `providerUpdatedAt` to the SQL finish RPC's exact allowlist; `providerProfileId`, engine `fingerprint`, `unchanged`, `uncertainWrite` are internal receipt details and can be dropped by that adapter.

429 respects numeric or HTTP-date Retry-After; delays are at least exponential 30 seconds × 2^(attempt−1), capped at one hour for the base delay and 24 hours including provider Retry-After. Network, timeout, 408, 5xx and unresolved conflicts schedule another lease, never an inline write retry. Six attempts maximum; the sixth retryable failure becomes `failed/retry_exhausted` for the error queue. Provider 401/403 becomes `failed/provider_auth` and requires configuration review rather than repeated authentication attempts. Timeout defaults to 8 seconds, AbortSignal is always supplied. Unknown provider bodies, raw errors, names, email addresses and keys are never retained in outcomes or logs.

Local eligibility cannot be locked atomically across an external HTTP request. The last local read is the final asynchronous step before dispatch. K4 remains authoritative locally; no global cross-provider transaction or delivery-consent guarantee is claimed.
