// src/lib/utm.ts
//
// Campaign attribution for signups. A visitor usually lands on an ad URL and
// then clicks around before signing up, so the params are stashed in
// sessionStorage on first sight and read back at submit time.

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
 * Capture campaign params from the current URL, merging them over anything
 * already stored. Safe to call on every mount.
 */
export function captureUtm(): void {
  if (typeof window === "undefined") return;

  const fresh = readFromUrl(window.location.search);
  if (Object.keys(fresh).length === 0) return;

  try {
    const merged: Utm = { ...getUtm(), ...fresh };

    // Record where the first campaign hit came from, once.
    if (!merged.landing_page) merged.landing_page = window.location.pathname;
    if (!merged.referrer && document.referrer) {
      merged.referrer = document.referrer.slice(0, 200);
    }

    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Private-browsing modes can refuse sessionStorage; attribution is a
    // nice-to-have, so never let it break the form.
  }
}

/** Everything captured so far this session. */
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
