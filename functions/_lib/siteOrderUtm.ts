// Campaign source for a site order (G21). Only these keys, string values of 1-200 characters
// without control characters, and a path-only landing page. Anything else means no source is
// stored: attribution never blocks a payment. The database applies the same rule
// (core.site_order_utm_valid_v1).
export const SITE_ORDER_UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "fbclid", "ttclid", "landing_page"] as const;

export function siteOrderUtm(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length || entries.length > SITE_ORDER_UTM_KEYS.length) return null;
  const out: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!(SITE_ORDER_UTM_KEYS as readonly string[]).includes(key) || typeof raw !== "string") return null;
    const text = raw.trim();
    // eslint-disable-next-line no-control-regex
    if (text.length < 1 || text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) return null;
    if (key === "landing_page" && !/^\/[A-Za-z0-9/_-]{0,100}$/.test(text)) return null;
    out[key] = text;
  }
  return out;
}
