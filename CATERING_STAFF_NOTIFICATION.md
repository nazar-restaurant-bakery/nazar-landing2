# Catering staff notification activation

Nazar selected Cloudflare Workers Paid for staff email. The site's Pages
Function uses Cloudflare Email Sending's REST API, which works without an email
binding. Cloudflare must first make Email Sending available on the account and
onboard `nazarrestaurantandbakery.com` as a sender domain. The sender address is
`notifications@nazarrestaurantandbakery.com`; the only recipient is
`ctnazarbakery@gmail.com`.

Production sequence:

1. Apply `database/20261013_catering_staff_notification.sql` to Nazar-production.
   Verify the three RPCs exist and only `service_role` can execute claim/finish.
2. Activate Workers Paid on the Nazar Cloudflare account. Onboard the sending
   domain in Email Service. Review any DNS records before applying them; email
   routing and existing mail delivery must keep working.
3. Create a Cloudflare API token scoped to the Nazar account with only
   `Email Sending: Edit`. In Pages `nazar-restaurant-website` Production settings,
   add `CLOUDFLARE_EMAIL_SEND_TOKEN` as a Secret. The account ID is fixed in
   the server function. Never put the token in source or a `VITE_` variable.
4. Publish the site code. Submit a clearly marked synthetic catering request
   with a non-deliverable test customer address. Confirm form success, one CRM
   record, one staff email, and `Staff notified` in CRM.
5. Repeat the same form request ID and check for no second email. Simulate API
   failure and confirm the form still succeeds and CRM shows the notification
   pending for the daily staff check.

The email contains only request date, event date, guest count and the `/staff`
link. The subject is generic. Customer name, contact details, requested dishes
and message remain in protected CRM. `staff_notification_sent_at` means
Cloudflare accepted the message for immediate delivery or its queue; it does
not prove the recipient opened it. Review pending CRM notifications daily.

Cloudflare REST API: https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
