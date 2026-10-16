# Public contact click measurement — 11.02

The existing single delegated click listener now records `phone_click` when someone activates a link to Nazar's public business number, and `directions_click` when someone activates an explicitly marked Nazar address/map link. Home has three marked map links and Contact has one. Google review links and map iframe loads do not produce directions events. Clover still has its separate `clover_order_click` event.

Each activation produces one event; two genuine activations produce two events. Duplicate initialization does not add another listener. The only event parameter is a canonical, known public `page_path`. Telephone numbers, addresses, link URLs/text, email, form content, query strings and fragments are not sent as custom parameters. Private/unknown routes are excluded. Existing GA4 automatic page/referrer collection is not changed by this custom payload rule.

Phone means a link activation, not an answered call. Directions means a map-link activation, not arrival at the restaurant. Clover means checkout handoff, not purchase. These events are diagnostic; no Ads primary conversion, campaign, budget or bidding change is made. VIP form success, Klaviyo confirmation request and final subscription remain distinct.

The listener never blocks, delays, rewrites or opens the link itself. If gtag is missing or throws, navigation remains the browser's responsibility. This only records click events; a middle-button auxiliary event is not included. Local checks use mocked gtag and prevent external navigation. Loading the production page proves the release and markup, not receipt of these events in GA4. Actual GA4 receipt is a separate 11.03 check and must not be claimed from local tests.
