# Normal Welcome consumer — local implementation contract (default OFF)
Base main b232a6c. No hosted apply/flag/key/cron/Live/real event authorized. SQL candidate lives outside canonical migrations until Root assigns a sequence: tools/test-env/welcome-automation/forward-candidate.sql. Historical migration bytes and shared operator packages stay unchanged.

## Review/work split
Koordinasyon: implementation, local native PostgreSQL and worker fixtures, Draft PR. HTTP/machine/pacing/no-retry surface is isolated below for Kol 2 review; SQL/ACL/lease/concurrency surface for Finalize independent review. This file is the handoff contract; no private Flow ID/key requested. Root coordinates other chats; this implementation does not message them.

## New service-only RPC signatures
- coupon_automation_start_v1(p_business_id uuid,p_run_id uuid) -> {allowed,code,runToken?,dispatchLimit:1,receiptLimit?,expiresAt?}. Replay run IDs never reopen; one active unexpired business lease.
- coupon_automation_next_v1(p_business_id uuid,p_run_id uuid,p_run_token uuid,p_kind text) -> {allowed,code,attemptId?,couponId?}. kind dispatch|receipt. Queued ordinary non-bootstrap dispatch candidate is permanently marked BEFORE HTTP, max one per run. Missing-receipt ordinary binding candidate gets bounded poll metadata before GET reconciliation; never a send retry.
- coupon_automation_record_v1(p_business_id uuid,p_run_id uuid,p_run_token uuid,p_kind text,p_attempt_id uuid,p_outcome text) -> {acknowledged}. Exact safe enum only. Dispatch attempt cannot be deleted/reopened/retried; receipt metadata can back off without changing K6 history.
- coupon_automation_finish_v1(p_business_id uuid,p_run_id uuid,p_run_token uuid) -> {acknowledged}. No token/identity returned to caller.
- coupon_automation_status_v1(p_business_id uuid) -> safe counts/status only, authenticated campaign.staff_mark scope; no participant content.

Tables: core.coupon_automation_settings(enabled default false, no seed), runs (lease/token and bounded claims), dispatch_attempts (unique coupon, immutable target), receipt_polls (bounded due/check metadata). RLS, no direct anon/auth/service table grants. Functions fixed empty search_path, service auth guard; status read scoped staff only.

## Machine request and runtime environment
Dedicated Supabase Edge function coupon-welcome-run; POST body EXACT {version:1,businessId:uuid,runId:uuid,issuedAt:unixSeconds}; header X-Coupon-Automation-Signature hex HMAC-SHA256 over canonical [purpose,version,businessId,runId,issuedAt], purpose coupon.automation.v1. ±60s machine-auth freshness, constant-time verification, run UUID replay lock. This is machine auth freshness, not a target timestamp rewrite.

Server-only settings (names only): COUPON_AUTOMATION_ENABLED=false default; COUPON_AUTOMATION_BUSINESS_ID; COUPON_AUTOMATION_ORIGIN; COUPON_AUTOMATION_SIGNING_SECRET; COUPON_PROCESS_KEY; existing SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY. Disabled returns before DB/network. No secrets in response/log/args. No personal address setting or From mutation.

Edge calls only existing Cloudflare /api/internal/coupon-welcome with exact {action:welcome|reconcile,businessId,couponId}, redirects forbidden, bounded response and per-call deadline, exactly one attempt. Does not use bootstrap endpoint. Durable new dispatch-attempt prevents queued+lost-HTTP from re-entering automatically. Receipt GET attempts may recur under bounded backoff; unknown outbox is never requeued or marked not_sent.

Accounts reads in normal Cloudflare dispatcher and receipt path need a reusable local pacing wrapper; no retry, API revision unchanged. Bootstrap existing exports/behavior must remain unchanged. Tests must intercept every outbound; no actual provider/hosted DB.

Permanent Flow is separate from TC4uSu, metric-gated, same campaign, No re-entry, 0 delay/one Draft email. From info@nazarrestaurantandbakery.com user-approved for Welcome only; this code does not change sender or Flow. Existing SQL23 bootstrap/permanent-Flow gate remains authoritative. No applied SQL function is replaced by the new candidate.

## Edge gateway / closed scheduling handoff
Source config `[functions.coupon-welcome-run] verify_jwt=false` is intentional: the caller supplies purpose-bound HMAC, not a user JWT. Handler default OFF is checked first; a valid HMAC, exact business, fresh timestamp and durable run lease are ALL required before processing. This source change does not alter hosted gateway configuration.

Exact future machine target: `POST https://<target-project-ref>.supabase.co/functions/v1/coupon-welcome-run`. Headers: `Content-Type: application/json`, `X-Coupon-Automation-Signature: <hex>`. No browser Origin, JWT, apikey, participant identity, coupon, Flow ID or From header in this request. The downstream Cloudflare target is separately fixed to `COUPON_AUTOMATION_ORIGIN + /api/internal/coupon-welcome` with its existing process key.

Canonical input example (synthetic): `["coupon.automation.v1",1,"10000000-0000-4000-8000-000000000001","20000000-0000-4000-8000-000000000001",1793052000]`. UTF-8, no whitespace; UUIDs are strings and issuedAt is an integer. JSON object key order on the wire is irrelevant: the verifier reconstructs this array. A new tick gets a new UUID; a repeated UUID never reopens, even after lease expiry. The 60-second freshness window means delayed queued calls fail closed and are not re-signed with a new timestamp to retry the same run.

Closed pg_cron/pg_net/Vault preparation is the separate `cron-candidate.sql` handoff. Both SQL sources remain OUTSIDE `supabase/migrations`: Root has not assigned a sequence or approved application. Installation must leave cron inactive in the same transaction; no scheduling statement is invoked by the consumer candidate or this delivery. Vault signing material is server-only and must match the Edge HMAC secret; never put it in cron command text, a receipt, response, shell argument or report. Final setup/apply/deploy/enable belongs to a later explicit acceptance step.

## Bounds and remaining acceptance
One active 180-second business lease; at most one dispatch and three receipt candidates per run, no new claim with under 45 seconds left. Each machine HTTP attempt has a 30-second header deadline plus bounded body, no redirect or retry; the durable coupon attempt survives timeout, crash, response/ack loss and lease turnover. Temporary K6/window and campaign date blocks are filtered BEFORE consuming that attempt with the existing shared K6 helper; the existing dispatch-time K6 grant still rechecks races.

Receipt sidecar: five-minute backoff, default 24 / maximum 48 checks per binding. Exhausted polls and unconfirmed dispatches require explicit review; no implicit reset/resend. Normal-route Accounts pacing is initial + inter-read 4.2 seconds in ONE route instance, shared across its read/event/receipt readers. This is not a global cross-isolate/account quota. Existing bootstrap pacing and all historical K6/bootstrap SQL stay unchanged.

Not proven here: hosted pg_net queue latency, real Supabase gateway deployment, cross-isolate provider quota, actual email delivery or global automation activation. Local tests intercept all network transports and use an owned loopback PostgreSQL 18.6 cluster. Provider revision stays 2026-07-15.

## pg_net transport boundary
The separate closed cron candidate uses the exact allowlisted Edge URL and sends ONLY a 60-second, purpose-bound HMAC signature plus version/business/run/time. It sends no static credential, provider key, process key, recipient or coupon content. Upstream pg_net follows HTTP redirects; this delivery does not claim a no-redirect guarantee for pg_net. Static-credential-bearing Edge-to-DB, Edge-to-Pages and Pages-to-provider calls retain `redirect:manual` and fail closed. The cron/native facade tests prove request construction and inactive installation, not the hosted extension's transport behavior. Root accepted this bounded scheduler distinction; actual queue timing, gateway and extension setup still need later hosted acceptance.

## Current hosted prerequisite (Root reported; no change authorized)
Root reported a read-only Production preflight with pgcrypto 1.3 and Vault 0.3.1 present, but `cron.job` and `net.http_post` absent. Therefore the closed cron candidate is NOT directly applicable to that environment. pg_cron/pg_net availability and installation need a separate explicit scope/approval before this candidate. No extension, historical scheduler record or setting was changed here. Source/test delivery is complete separately from installation readiness.
