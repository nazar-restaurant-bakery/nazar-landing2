// src/lib/utm.ts
//
// Campaign attribution for signups. A visitor usually lands on an ad URL and
// then clicks around before signing up, so the params are stashed in
// sessionStorage and read back at submit time. Each tagged visit is a complete
// attribution context; missing tags must not be borrowed from an older visit.

const STORAGE_KEY = "nazar_utm";

const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  // Ad-platform click ids — handy for matching a signup back to a click.
  "gclid",
  "fbclid",
  "ttclid",
] as const;

export type Utm = Record<string, string>;

function readFromUrl(search: string): Utm {
  const params = new URLSearchParams(search);
  const found: Utm = {};

  for (const key of UTM_KEYS) {
    const value = params.get(key)?.trim();
    // Cap length so a junk query string can't bloat the row.
    if (value) found[key] = value.slice(0, 200);
  }

  return found;
}

/**
 * Replace the saved context when this URL contains campaign params. Untagged
 * navigation keeps the last tagged visit available to the signup form.
 */
export function captureUtm(): void {
  if (typeof window === "undefined") return;

  const fresh = readFromUrl(window.location.search);
  if (Object.keys(fresh).length === 0) return;

  try {
    const captured: Utm = { ...fresh, landing_page: window.location.pathname };

    if (document.referrer) {
      captured.referrer = document.referrer.slice(0, 200);
    }

    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(captured));
  } catch {
    // Private-browsing modes can refuse sessionStorage; attribution is a
    // nice-to-have, so never let it break the form.
  }
}

/** The most recent tagged visit captured in this tab. */
export function getUtm(): Utm {
  if (typeof window === "undefined") return {};

  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    const out: Utm = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** `getUtm()` result, or null when there is nothing worth storing. */
export function getUtmOrNull(): Utm | null {
  const utm = getUtm();
  return Object.keys(utm).length > 0 ? utm : null;
}

// Keys the catering order accepts (functions/_lib/siteOrderUtm.ts). The referrer is never
// sent with an order; the server refuses unknown keys.
const ORDER_KEYS = [...UTM_KEYS, "landing_page"] as const;

/** Saved campaign context for a catering order, limited to the accepted keys; null if none. */
export function orderUtm(): Utm | null {
  const utm = getUtm();
  const out: Utm = {};
  for (const key of ORDER_KEYS) if (utm[key]) out[key] = utm[key];
  return Object.keys(out).length > 0 ? out : null;
}
