# Catering staff notification activation

The site's Pages Functions send transactional email (staff catering
notification, form error alert, customer order confirmation) through the
Resend API (`functions/_lib/resendEmail.ts`). The sender is
`Nazar Restaurant & Bakery <notifications@mail.nazarrestaurantandbakery.com>`;
the `mail.nazarrestaurantandbakery.com` domain must be verified in Resend.
The only staff recipient is `ctnazarbakery@gmail.com`.

Production sequence:

1. Apply `database/20261013_catering_staff_notification.sql` to Nazar-production.
   Verify the three RPCs exist and only `service_role` can execute claim/finish.
2. In Resend, verify the sending domain `mail.nazarrestaurantandbakery.com`.
   Existing apex mail routing was not changed.
3. Create a Resend API key with only `Sending access`, limited to that domain.
   In Pages `nazar-restaurant-website` Production settings, add `RESEND_API_KEY`
   as a Secret. Never put the key in source or a `VITE_` variable.
   `CLOUDFLARE_EMAIL_SEND_TOKEN` is no longer used and can be removed.
4. Publish the site code. Submit a clearly marked synthetic catering request
   with a non-deliverable test customer address. Confirm form success, one CRM
   record, one staff email, and `Staff notified` in CRM.
5. Repeat the same form request ID and check for no second email. Simulate API
   failure and confirm the form still succeeds and CRM shows the notification
   pending for the daily staff check.

The email contains only request date, event date, guest count and the `/staff`
link. The subject is generic. Customer name, contact details, requested dishes
and message remain in protected CRM. `staff_notification_sent_at` means
Resend accepted the message (HTTP success with a message `id`); it does not
prove the recipient opened it. Each send carries an `Idempotency-Key` (the
request id), so a repeated call for the same request is not delivered twice.
An uncertain answer is never retried. Review pending CRM notifications daily.

Resend API: https://resend.com/docs/api-reference/emails/send-email
