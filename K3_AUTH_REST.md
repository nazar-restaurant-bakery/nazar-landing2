# K3 — existing-account sandbox Auth / REST verification

`tools/test-env/auth-rest-operator.py` tests an existing preserved sandbox staff
account after the reviewed application installation. It does not reset a
password, send an email, create an Auth user, grant a staff role, or write an
application/customer record. Only the explicit password sign-in creates a new
Auth session; cleanup targets that session with `logout?scope=local`.

This document is a procedure, not evidence that hosted Auth / REST or the later
Preview write has passed. Check the actual dated receipt for execution results.

The password route is usable only when the existing account supports password
sign-in. Do not keep retrying a rejected grant or substitute the database
password. A separately authorized ordinary email verification/sign-in route may
reuse the same existing account with `shouldCreateUser: false`, after the actual
test-project redirect allowlist is verified. It must not fabricate an admin JWT,
create a user, grant a role, or silently change Auth settings. Bound the send to
one email, clear callback tokens immediately, keep the session in memory, and
log out that local session after the real staff RPC/REST checks.

K3's dated hosted acceptance on 19 October 2026 used that normal existing-account
email route and passed 11/11 checks. One authentication email was requested by
Codex on the user's behalf; no marketing email or new Auth user was created.
The private helper, aggregate observations and token-free receipt are retained
outside Git. This result does not make a failed password-grant attempt pass.

## Exact private configuration

Keep one JSON object **outside Git**, with exactly these six string properties.
Do not add Email, password, database password, JWT or secret-key fields.

| Property | Required source / constraint |
| --- | --- |
| `expectedSandboxRef` | Ref of the independently verified isolated Supabase project; different from production. |
| `productionRef` | Must match the existing `PRODUCTION_SUPABASE_URL` guard in `src/lib/deploymentEnvironment.ts`. The operator does not trust a relabelled config value. |
| `sandboxUrl` | Exact `https://<expectedSandboxRef>.supabase.co` origin, optionally one trailing slash; no port, userinfo, path, query or fragment. |
| `publishableKey` | Existing `sb_publishable_…` key read from that verified sandbox project. A secret key or a production key is not permitted. The helper cannot establish key ownership from an opaque key string; the UI source must be independently verified. |
| `testBusinessId` | Configured test business compatible with the unchanged business constraint in the reviewed application baseline. No new hardcoded business/project ID is added. |
| `privateRoot` | Existing absolute local output directory outside Git and symlink/reparse paths. Receipts are placed in a new restricted subdirectory. |

This is a local operator config, not a Vite/Pages binding or a tracked `.env`
file. It does not require adding or changing a `VITE_` value, Production secret,
provider credential, or Auth redirect setting.

## Local validation versus explicit hosted execution

Using the selected local Python executable:

```powershell
python tools/test-env/auth-rest-operator.py --config <absolute-private-config.json> --validate-config
python tools/test-env/auth-rest-operator.py --config <absolute-private-config.json> --public-preflight
python tools/test-env/auth-rest-operator.py --config <absolute-private-config.json> --gui --preflight-receipt <absolute-private-public-receipt.json>
```

Import and `--validate-config` read local configuration/guards only; they do not
make an HTTP request or prove a hosted connection. `--public-preflight` makes
only publishable-key public requests and never accepts or requests staff login
credentials, creates a session, or sends a password grant. It returns a private
receipt path and a passed/failed flag, exiting nonzero on failure.

`--gui` displays the sandbox ref. Email/password fields and the sign-in button
stay disabled until a successful public-preflight receipt matches the current
target/configuration and is no more than ten minutes old. Pass it using
`--preflight-receipt`; otherwise the window offers a public-only preflight button
before asking for credentials. Opening the window alone does not make an HTTP
request. A stale receipt is rejected **before** reading or clearing entered
credentials, so basic setup failure does not consume a password attempt.

Only then does Talip enter the **existing staff Email and Auth password**. This
is not the database password or archive password. Credentials go only into that
window; no credential argument/file is supported.

Talip presses the single test button. Inputs are cleared, pending controls are
disabled, and the window permits one attempt with no automatic retry. No password
reset/recovery email is sent if sign-in fails. Network execution requires the
approved local network context; a failed connection is not proof of a bad password.

## Bounded checks

All requests use the exact sandbox HTTPS origin, verified TLS and a no-redirect
client with bounded response sizes/timeouts. Ambient proxy/redirect handling is
not used to forward credentials elsewhere.

1. Require `/auth/v1/health` to return 200. Read `/rest/v1/` only to check the
   **restricted root OpenAPI catalogue**: 401 with `Secret API key required` is
   the documented publishable-key boundary, **not** a REST outage. Do not use a
   secret/admin or legacy key to bypass it.
2. Require public `get_active_offers` for the configured business to return
   200 with an array; this existing public RPC establishes REST readiness.
3. Check that anonymous `crm_follow_up_queue_v1` is denied with 401/403.
4. Check `Accept-Profile: core` / `customers?select=id&limit=0` is denied with
   406 and `PGRST106`; zero-row selection prevents customer row retrieval even
   if the schema boundary is unexpectedly open.
5. If those prerequisites pass, attempt one existing-account password grant.
6. Check the access token's issuer matches that sandbox Auth origin and its role
   is `authenticated`. Local claims decoding is not a local cryptographic
   signature-verification claim; the following server-authorized RPCs test the
   actual hosted session.
7. Require `crm_staff_authorized_v1` to return true; read
   `crm_follow_up_queue_v1` with `p_queue='open_catering'`, `p_offset=0`, checking
   its aggregate/list contract. Do not record returned customer items.
8. Recheck the private-core 406/`PGRST106` denial using that staff session.
9. Attempt logout of **only the current session**, including after a later test
   failure. Global logout and changes to other existing sessions are not used.

The OpenAPI distinction follows the [Supabase database OpenAPI API reference](https://supabase.com/docs/reference/api/v1-get-database-openapi)
and [Auth key/route documentation](https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys).
An unrelated 401 such as an invalid-key error does not pass the restricted-root
check, and a successful root restriction does not excuse a failed public RPC.

The helper's route allowlist contains no application write, Auth admin/new-user,
signup, recovery email, staff update, or global-logout endpoint. All checks,
including local logout, must pass before `real_auth_rest_verified=true` is saved.

## Private receipt and proof limits

Output is a new restricted
`<privateRoot>/auth_rest_<UTC timestamp>_<random>/auth-rest-receipt.json`.
It records the configured sandbox ref, timestamps, fixed check names, passed/
failed/not-run states, HTTP status codes, one-login attempt count and a fixed error
category. It does **not** record Email, passwords, public/secret keys, JWTs,
refresh tokens, Auth UUIDs, customer identities, response bodies or native errors.
Values remain in process memory only as needed; forensic memory zeroing is not
claimed.

Public-only preflight has a separate
`<privateRoot>/public_preflight_<UTC timestamp>_<random>/public-preflight-receipt.json`:
six fixed checks, timestamps, a configuration-binding hash, zero password-login
attempts and `public_preflight_passed`. The opaque key itself is never included.
That receipt unlocks the GUI for at most ten minutes; it is **not** a completed
staff Auth / REST acceptance receipt. The final Auth receipt includes the verified
public checks plus the real single-login/staff checks and local logout.

`tools/test-env/inspect-installed-readonly.sql` is the separate post-install SQL
observation for aggregate/test-marker counts, catalogue hashes and security
state. Direct SQL role simulation cannot replace the real Auth / REST receipt.
Neither that receipt nor the masked helper proves a Preview form write. The
single eventual Preview submission must reuse a preseeded reserved `.invalid`
customer: the existing customer remains `is_test=true`, its same-email signup
count becomes **two**, an exact request retry adds no third signup, and production
has zero matching records. See [K3_SEED_AND_RESET.md](K3_SEED_AND_RESET.md).

The helper's unit tests mock HTTP and account data. They prove local guards,
denials, cleanup and report privacy; they do not prove real hosted access.

```powershell
python -B -m unittest discover -s tests -p test_auth_rest_operator.py -q
```
