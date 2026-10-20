# Nazar staff CRM layout

Presentation-only update, refreshed onto main `4f2d1f9` (#54/#55/#56 included).
No database, migration, RPC definition, policy, Pages Function, public-page content, dependency or theme-token changes.

## Routes and behavior

- `/staff` opens `/staff/tasks`.
- `/staff/crm` redirects to `/staff/customers`.
- `/staff/customers`, `/staff/catering`, `/staff/tasks`, `/staff/offers`, `/staff/profile-sync`, `/staff/orders`, `/staff/system` share one Auth/authorization gate.
- Assignees are Talip / Yücel / Other (free text). Existing stored assignees remain editable through Other.
- Customers: desktop three-column list/timeline/readonly profile; tablet list toggle and two-column record; mobile list/profile/timeline.
- Catering: keyboard-accessible status selector and native drag/drop, plus list view. Existing owner and open-request follow-up requirements remain.
- Uncertain writes retain drafts and block mutations until explicit refresh reads the relevant source. Tab changes preserve drafts; logout/account change clears private state. Writes are never automatically retried.
- Dates use Turkish display and America/New_York. Calendar-only offer/event dates do not shift; datetime-local conversion rejects DST gaps. Existing past deadlines remain permitted.
- The staff bundle loads separately. Public routes and content remain intact.

## Verified endpoint mapping (spec section 2)

| Catalog name | Actual existing call |
| --- | --- |
| `crm_overview_v` | `crm_overview_v2({p_search,p_segment})` |
| `crm_customer_tasks_v` | `crm_customer_tasks_v1({p_customer_id})` |
| `crm_follow_up_queue_v` | `crm_follow_up_queue_v1({p_queue,p_offset})` |
| `crm_catering_decisions_v` | `crm_catering_decisions_v1()` |
| `crm_catering_notification_status_v` | `crm_catering_notification_status_v1()` |
| `crm_klaviyo_status_v` | Existing browser `POST /api/staff/klaviyo-status {customerId}`; not a direct browser RPC |
| `crm_form_errors_v` | `crm_form_errors_v1()` |
| `crm_staff_authorized_v` | `crm_staff_authorized_v1()`; boolean only |
| `staff_notification_v` | Not present; request notification evidence only |
| `crm_add_note` | `crm_add_note({p_customer_id,p_body})` → boolean |
| `crm_create_task_v` | `crm_create_task_v1({p_customer_id,p_title,p_assigned_to,p_due_at})` → UUID |
| `crm_complete_task_v` | `crm_complete_task_v1({p_task_id})` → boolean |
| `crm_update_catering` | `crm_update_catering({p_request_id,p_status,p_assigned_to,p_follow_up_at})` → boolean |
| `crm_request_catering_decision_v` | `crm_request_catering_decision_v1({p_request_id,p_question})` → UUID |
| `crm_resolve_form_error_v` | `crm_resolve_form_error_v1({p_id})` → boolean |
| Offers | Existing `get_active_offers({p_business_id})` only |

No replacement endpoints were invented. `crmData.ts` wraps these existing calls; no direct table reads were added.

## Missing data and bounded coverage

Unavailable fields display `—`; the UI does not infer them:

- Customer `identity_key`, customer suppression timestamp and complete update history.
- Consent-event history, original signup email/SMS checkbox values and full UTM. Available campaign text remains visible.
- Staff display name/business role. The Auth email and boolean authorization are distinct from a business role. Note authors remain stored Auth account references, never inferred people.
- Full offer inventory and `active` flag. The only available source returns active public offers, not scheduled/ended/inactive inventory.
- Resolved form-error history, `resolved_at`, test classification/customer links on diagnostic errors.
- Global staff notification settings. Available notification evidence covers the latest 30 days/up to 100 requests and is joined to visible request IDs.
- Complete customer lists/history: overview caps 100 customers and 100 requests per segment, last 10 signups/notes; per-customer tasks cap 50. Sort and client-side filters describe known returned data.
- Bulk per-customer task state is unavailable. The open-task customer filter does not silently exclude profiles whose tasks have not loaded; this is explained in the UI.
- The existing general queue is paginated in groups of 25 and always excludes test work. Date groups/assignee filters apply to the displayed page; category counts overlap. Test-customer tasks are accessible from their customer profile when tests are included.
- Queue links to a customer/request outside the bounded overview cannot invent the missing record and report it unavailable.

Normal overview reads exclude test signups/requests. The global include-tests switch merges separate existing `all`/`test` reads and deduplicates shared customers/notes. Decisions and notifications are joined to the visible request IDs. Form-error diagnostics have no test flag and cannot be classified as customer test records from this endpoint.

## Provider and deployment boundaries

The existing Klaviyo status route reads provider state and records an existing local CRM observation; it does not subscribe, unsuppress or send. Local email status never grants marketing consent. No email/SMS sender, setup-test action, Clover write or offer publishing action is exposed by this redesign.

No live Auth sign-in, production customer query, database action or provider test was performed for verification. Browser evidence uses synthetic fixtures and a strict mock. Production writes and production deployment require a separate merge/release decision by Talip.

## Verification and evidence

- `node --test tests/crmUi.test.mjs tests/crmQueue.test.mjs tests/staffUi.test.mjs`: 20 tests, including all 8 existing CRM UI tests.
- `node tests/browser/run.mjs`: 41 browser checks, preserving the historical 22 scenarios and adding routing, test filtering, drag/drop, mobile, timezone, draft and late-response checks.
- `node node_modules/typescript/bin/tsc -b --pretty false`.
- Targeted ESLint with `--max-warnings 0` on changed production files.
- `node node_modules/vite/bin/vite.js build`.

See [browser runner instructions](../../tests/browser/README.md), [machine-readable evidence](../../tests/browser/evidence/results.json), [desktop](../../tests/browser/evidence/staff-customers-desktop.png), [mobile list](../../tests/browser/evidence/staff-customers-mobile-list.png), and [mobile record](../../tests/browser/evidence/staff-customers-mobile-record.png).

Clean `main` baseline: 147,790 bytes gzip across JS/CSS. Redesigned build: 160,440 bytes gzip across all JS/CSS chunks, an increase of 12,650 bytes (+12.65 kB), below the 60,000-byte limit. Both builds use the same Node gzip settings; exact measurements are in [checks.json](../../tests/browser/evidence/checks.json). The pre-existing Browserslist database-age advisory is not a build failure.

## October 20 restoration

Production navigation uses the existing authorized `list_offers` panel and existing profile-sync panel. Isolated Preview preserves the separate provider-safe entry pages and the legacy CRM provider block. Clover last-seven-days orders are available under `/staff/orders` through the existing read endpoint. Pending catering decisions can prepare the existing email draft and expose a mailto link; this does not send email. Both restored paths have strict synthetic browser scenarios, including bearer/identifier checks and logout clearing.

The historical evidence above belongs to the original head. Updated test and Production-public-config comparison evidence is recorded in the project K1a refresh delivery report. Live staff acceptance remains pending Talip’s merge and session.
