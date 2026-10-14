# Catering staff notification activation

Cloudflare's verified-destination email pricing is free in principle, but the
Nazar account's Email Sending screen currently requires Workers Paid and this
Pages project's binding picker does not offer an email send binding. The fallback
is the Apps Script project **Nazar Catering Staff Notifications** owned by
`ctnazarbakery@gmail.com`.

The production sequence matters:

1. Apply `database/20261013_catering_staff_notification.sql` to Nazar-production.
   Verify the three RPCs exist and only `service_role` can execute claim/finish.
2. In Apps Script, add a strong random `WEBHOOK_SECRET` Script Property. Deploy
   `Code.gs` as a web app executing as `ctnazarbakery@gmail.com`, accessible to
   anyone. Authorize only the mail and script-properties scopes.
3. In Cloudflare Pages `nazar-restaurant-website`, set `CATERING_NOTIFY_URL`
   (the `/exec` deployment URL) and `CATERING_NOTIFY_SECRET` as **Secrets** for
   Production. The value of `CATERING_NOTIFY_SECRET` must match the Script
   Property. Do not put it in the repository or a `VITE_` variable.
4. Publish the matching site code. Submit a clearly named synthetic catering
   request with a non-deliverable test customer address. Confirm the form reports
   success, one catering request appears in CRM, a staff-only email reaches
   `ctnazarbakery@gmail.com`, and the CRM row shows `Staff notified` with time.
5. Repeat the same form request ID and verify that no second email appears.
   Test the Script with a wrong key; it must return `{ "ok": false,
   "error": "forbidden" }` and send nothing. On a simulated delivery failure,
   the form must still succeed and CRM must show `Notification pending`.

The email subject is generic. Its body contains only request date, event date,
guest count and the `/staff` link. Customer name, contact details, requested
dishes and message stay in the protected CRM. The daily CRM check must review
the pending notification count; failed or cancelled background tasks may remain
pending. This is a notification channel, not a delivery guarantee or a customer
reply channel.
