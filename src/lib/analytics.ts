import { PHONE_NUMBER_TEL } from "../data/menu.ts";
import { getUtmOrNull } from "./utm.ts";
import { qrCardEventParams } from "./qrCard.ts";
import { isolatedBrowser } from "./deploymentEnvironment.ts";

// Events go only to the dataLayer; Google Tag Manager (GTM-TJ67R6VZ) forwards them to GA4
// and, for purchase, to Google Ads. There is no page-level gtag, so nothing is sent twice.
type Parameters = Record<string, string | number>;
type DataLayerWindow = Window & { dataLayer?: unknown[] };

const sentEvents = new WeakMap<Window, Set<string>>();
const handoffDocuments = new WeakSet<Document>();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pushEvent(name: string, parameters: Parameters): boolean {
  const layer = (window as DataLayerWindow).dataLayer;
  if (!Array.isArray(layer)) return false;
  layer.push({ event: name, ...parameters });
  return true;
}

// One event per key on this device: in memory, and in sessionStorage when available.
function sendOnce(key: string, name: string, parameters: () => Parameters): void {
  if (typeof window === "undefined" || isolatedBrowser()) return;
  const storageKey = `nazar-measured-v1:${key}`;
  const sent = sentEvents.get(window) ?? new Set<string>();
  sentEvents.set(window, sent);
  if (sent.has(storageKey)) return;
  try {
    if (window.sessionStorage.getItem(storageKey)) return;
  } catch { /* In-memory deduplication remains available if storage is blocked. */ }
  try {
    if (!pushEvent(name, parameters())) return;
    sent.add(storageKey);
    try { window.sessionStorage.setItem(storageKey, "1"); } catch { /* Optional storage. */ }
  } catch { /* Measurement must not turn a saved signup or a payment into an error. */ }
}

// Keep the opaque request ID on this device only. It is never an event parameter.
function trackSavedSignup(name: string, form: string, requestId: string): void {
  if (!requestId) return;
  sendOnce(`${name}:${requestId}`, name, () => ({ form_name: form, ...(form === "vip" ? qrCardEventParams(getUtmOrNull()) : {}) }));
}

// Only a successfully stored catering request counts as a lead. Never send
// contact details, message text, guest count, or other form data to analytics.
export function trackCateringRequestSubmitted(requestId: string): void {
  trackSavedSignup("catering_request_submitted", "catering", requestId);
}

export function trackVipSignupSubmitted(requestId: string): void {
  trackSavedSignup("vip_signup_submitted", "vip", requestId);
}

// A subscription request accepted by Klaviyo is not final double-opt-in consent.
export function trackVipConfirmationStarted(requestId: string): void {
  trackSavedSignup("vip_confirmation_started", "vip", requestId);
}

// PAY accepted and Clover's payment page is about to open. Not a sale; no form data.
export function trackBeginCheckout(orderId: string): void {
  if (!uuid.test(orderId)) return;
  sendOnce(`begin_checkout:${orderId}`, "begin_checkout", () => ({}));
}

// Only the server's paid answer counts as a sale ("needs_reschedule" is paid too). The
// order ID is the transaction ID; no contact details. One event per order on this device.
export function trackPurchase(state: { status?: unknown; orderId?: unknown; totalCents?: unknown }): void {
  if (state.status !== "paid" && state.status !== "needs_reschedule") return;
  const orderId = state.orderId, cents = state.totalCents;
  if (typeof orderId !== "string" || !uuid.test(orderId) || typeof cents !== "number" || !Number.isSafeInteger(cents) || cents <= 0) return;
  sendOnce(`purchase:${orderId}`, "purchase", () => ({ transaction_id: orderId, value: cents / 100, currency: "USD" }));
}

const publicPaths = new Set(["/", "/menu", "/specials", "/catering", "/gallery", "/reviews", "/about", "/contact", "/vip"]);

// One delegated listener for public-site link activations. These are clicks,
// never proof of a phone conversation, a physical visit or a completed sale.
// Keep the existing initializer name so initialization remains a single call.
export function trackCloverOrderHandoffs(): void {
  if (typeof document === "undefined" || isolatedBrowser()) return;
  if (handoffDocuments.has(document)) return;

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest("a[href]");
    if (!(link instanceof HTMLAnchorElement)) return;

    try {
      const pagePath = window.location.pathname.replace(/\/+$/, "") || "/";
      if (!publicPaths.has(pagePath)) return;
      const url = new URL(link.href);
      let name: string;
      if (url.protocol === "https:" && url.hostname === "nazar-bakery-west-haven.cloveronline.com") {
        name = "clover_order_click";
      } else if (url.protocol === "tel:" && url.pathname.replace(/\D/g, "") === PHONE_NUMBER_TEL.replace(/\D/g, "")) {
        name = "phone_click";
      } else if (link.getAttribute("data-analytics") === "directions" && url.protocol === "https:"
        && ["www.google.com", "google.com"].includes(url.hostname) && /^\/maps(?:\/|$)/.test(url.pathname)) {
        name = "directions_click";
      } else return;
      pushEvent(name, { page_path: pagePath });
    } catch {
      // A blocked analytics script must never interrupt navigation.
    }
  });
  handoffDocuments.add(document);
}
