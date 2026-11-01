// G21: shape of public.crm_customer_attribution_v1 for the staff customer card.
export type Touch = { source_class: "google_ads" | "other_campaign"; utm_source: string | null; utm_campaign: string | null; at: string; site_order_id: string };
export type Attribution = { first: Touch; last: Touch; attributed_orders: number; attributed_revenue_cents: number };

function validTouch(value: unknown): value is Touch {
  const t = value as Touch | null;
  return !!t && typeof t === "object" && ["google_ads", "other_campaign"].includes(t.source_class) && typeof t.at === "string"
    && typeof t.site_order_id === "string" && (t.utm_source === null || typeof t.utm_source === "string")
    && (t.utm_campaign === null || typeof t.utm_campaign === "string");
}
export function validAttribution(value: unknown): value is Attribution | null {
  if (value === null) return true;
  const a = value as Attribution;
  return !!a && typeof a === "object" && validTouch(a.first) && validTouch(a.last)
    && Number.isSafeInteger(a.attributed_orders) && Number.isSafeInteger(a.attributed_revenue_cents);
}
