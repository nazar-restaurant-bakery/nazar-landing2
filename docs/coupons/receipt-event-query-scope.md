# Receipt event GET: remove unnecessary profile expansion

The July 15, 2026 contract supports `fields[profile]=id` and `fields[metric]=id`. The problem is `include=metric,profile`: Klaviyo requires read access to included resources, while the reviewed receipt credential has Accounts/Events/Metrics Read without proven Profiles Read.

The receipt matcher reads only primary `relationships.profile.data.id` and `relationships.metric.data.id`. Remove the include and both unused related-resource fieldsets. Keep the current event filter, page size, event fieldset, native metric/account/profile/flow/message/time checks, and complete/unique-page requirements unchanged. Missing primary relationships remain pending; there is no fallback based on filter values or the included collection.

Official sources: [July Get Events](https://developers.klaviyo.com/en/v2026-07-15/reference/get_events), [relationship permissions](https://developers.klaviyo.com/en/v2026-04-15/docs/relationships_#scopes). The existing pinned official fixture identifies source revision `2026-07-15` and source SHA256 `d81ec2b3fc30d79825f29e2b682261156579716f67056f7e01d6a3c024bff464`.

Validation uses the real receipt adapter and actual bootstrap route in native workerd. All provider and DB outbound terminate in synthetic interceptors. The route test leaves normal COUPON_PROCESS_ENABLED/MODE absent and accepts only the existing `action=reconcile`. It permits native GET evidence and delivery receipt/bootstrap acknowledgements, with no event dispatch, new permit, profile/subscription write, or email. Unbound, absent relationship, provider 403/429/500, and missing acknowledgement cases fail closed.

No migration, live readback, deployment, secret change, key scope expansion, or user command in this patch. After independent review and approved deployment, Root must update the receipt-only package source pin and verify live DB evidence separately. Local tests are not live delivery acceptance.
