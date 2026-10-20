# K5: read-only Production key check

The existing queue GET proves staff authorization and database/configuration access; it does **not** authenticate the provider key. Running a sync is not a harmless key test: a `run` command can enqueue and write an eligible profile even when the displayed queue is empty.

## Contract and safeguards

The staff panel adds a manual **Bağlantıyı doğrula** button. It sends only `{ "action": "check" }` to the existing same-origin `POST /api/staff/profile-sync` endpoint. The existing bearer, same-origin and active-staff RPC checks apply first. No client-supplied account, customer, URL or key is accepted.

The separate check path returns before any enqueue, claim, context, finish or profile-write operation. It uses the existing server-side `KLAVIYO_PROFILE_SYNC_KEY`; no new secret, database object, dependency or permission scope is required. It is available only in non-isolated Production configuration with live mode and approval configured. Mock and isolated Preview configurations refuse it.

Exactly one provider request is allowed per explicit click:

```
GET https://a.klaviyo.com/api/profiles
filter=equals(email,"k5-auth-<fresh random UUID>@example.invalid")
fields[profile]=id
page[size]=1
revision: 2026-07-15
```

The random `.invalid` address is only a search filter, never a created profile or a recipient. No customer contact details are sent. Redirects and retries are disabled. One five-second deadline covers both headers and response body; the body is capped at 16 KiB. Only an HTTP 200 response with an empty `data` array and no errors, included records or next page is accepted. Provider bodies, URLs, credentials and headers are never returned to the browser.

The browser receives only a safe result code, read-only flag, server timestamp and HTTP status. Provider 401/403 becomes a safe 502 authentication failure, not a staff logout. Rate limits, network failures and malformed responses remain unconfirmed. The UI prevents double clicks and concurrent refresh/run/check commands and ignores results from a changed or unmounted staff session. It never checks automatically.

## What success proves

HTTP 200 proves that the exact key bound to that deployed server can perform this Profiles-read request at that time. It does **not** independently prove Profiles-write permission, remote account identity, profile transfer, consent, email delivery or a current eligible-customer count. The earlier approved synthetic write/idempotence test remains separate evidence. The configured account label alone is not remote identity evidence.

This request has no profile, subscription, suppression, event, list or message write. It cannot add a billable profile, trigger a profile-write flow, send email or change a plan. No real sync command is needed for this verification.

## Release and operator steps

1. Review and merge this PR only with Talip's release decision. Cloudflare must deploy the merged commit with the existing Production bindings; no key re-entry or migration is needed.
2. Talip completes any required staff login himself. Open Production `/staff/profile-sync` and use **Bağlantıyı doğrula** once. Do not use **Şimdi senkronla** for this diagnostic.
3. Record the displayed result and timestamp. A failure is not success: stop and diagnose the safe code without retrying or broadening scopes automatically. Record queue state separately; queue zero does not establish eligible-customer zero.
4. Keep acceptance pending until this deployed-key result is captured. No successful real check is claimed by the local synthetic tests.

Rollback: revert this PR's commit and deploy the reviewed previous application version. There is no migration or provider data to undo. Reverting the check does not alter the independently configured sync mode or revoke a key.

## Validation

Targeted Node suites: 81 passed, zero failed/skipped (engine/runtime 37, check 10, UI client 14, existing API/middleware 20). Actual React/Chromium tests: 8 scenarios plus parent, 9 passed, covering gating, pending locks, error sanitization, stale sessions/unmount and the original run path. TypeScript, targeted ESLint and Vite build passed. Existing Browserslist/chunk-size warnings remain. The in-app browser blocked localhost visual QA; no new screenshot or hosted success is claimed.

References: [official Get Profiles endpoint](https://developers.klaviyo.com/en/reference/get_profiles), [official endpoint schema including the sparse `id` field](https://github.com/klaviyo/openapi/blob/main/openapi/stable/apis/get_profiles.json). The published schema is current vendor documentation; the application keeps its existing pinned revision rather than silently upgrading it.
