// Consent Mode v2 with a right to opt out (no opt-in banner). index.html sets the default
// before Google Tag Manager loads: analytics and ad signals granted, unless the browser sends
// Global Privacy Control or the visitor chose "Do not sell or share" on this device, in which
// case ad_storage, ad_user_data and ad_personalization are denied. This module records the
// footer choice and sends the consent update. It never throws.
export const AD_OPT_OUT_KEY = "nazar-ad-opt-out-v1";
export type AdConsent = "granted" | "denied";
type ConsentWindow = Window & { dataLayer?: unknown[] };

export function gpcEnabled(): boolean {
  try {
    return typeof navigator !== "undefined"
      && (navigator as Navigator & { globalPrivacyControl?: unknown }).globalPrivacyControl === true;
  } catch { return false; }
}

export function storedAdOptOut(): boolean {
  try { return window.localStorage.getItem(AD_OPT_OUT_KEY) === "1"; } catch { return false; }
}

export function adConsent(): AdConsent {
  return gpcEnabled() || storedAdOptOut() ? "denied" : "granted";
}

// Consent commands must reach the dataLayer as an Arguments object (the gtag() shape).
// No page-level gtag function exists, so events cannot be sent twice through it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function consentCommand(..._args: unknown[]): void {
  const layer = (window as ConsentWindow).dataLayer;
  // eslint-disable-next-line prefer-rest-params
  if (Array.isArray(layer)) layer.push(arguments);
}

// Saves the choice on this device and updates consent. GPC always keeps ad signals denied.
export function setAdOptOut(optOut: boolean): AdConsent {
  try {
    if (optOut) window.localStorage.setItem(AD_OPT_OUT_KEY, "1");
    else window.localStorage.removeItem(AD_OPT_OUT_KEY);
  } catch { /* The update below still applies to this page view. */ }
  const state: AdConsent = optOut || gpcEnabled() ? "denied" : "granted";
  try {
    consentCommand("consent", "update", { ad_storage: state, ad_user_data: state, ad_personalization: state });
  } catch { /* Measurement must not break the page. */ }
  return state;
}
