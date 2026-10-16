import { PHONE_NUMBER_TEL } from "../data/menu.ts";

type EventTag = (command: "event", name: string, parameters: Record<string, string>) => void;

const sentEvents = new WeakMap<Window, Set<string>>();
const handoffDocuments = new WeakSet<Document>();

// Keep the opaque request ID on this device only. It is never an event parameter.
function trackSavedSignup(name: string, form: string, requestId: string): void {
  if (typeof window === "undefined" || !requestId) return;
  const key = `nazar-measured-v1:${name}:${requestId}`;
  const sent = sentEvents.get(window) ?? new Set<string>();
  sentEvents.set(window, sent);
  if (sent.has(key)) return;
  try {
    if (window.sessionStorage.getItem(key)) return;
  } catch { /* In-memory deduplication remains available if storage is blocked. */ }
  try {
    const tag = (window as Window & { gtag?: EventTag }).gtag;
    if (!tag) return;
    tag("event", name, { form_name: form });
    sent.add(key);
    try { window.sessionStorage.setItem(key, "1"); } catch { /* Optional storage. */ }
  } catch { /* Measurement must not turn a saved signup into an error. */ }
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

const publicPaths = new Set(["/", "/menu", "/specials", "/catering", "/gallery", "/reviews", "/about", "/contact", "/vip"]);

// One delegated listener for public-site link activations. These are clicks,
// never proof of a phone conversation, a physical visit or a completed sale.
// Keep the existing initializer name so initialization remains a single call.
export function trackCloverOrderHandoffs(): void {
  if (typeof document === "undefined") return;
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
      const tag = (window as Window & { gtag?: EventTag }).gtag;
      tag?.("event", name, {
        page_path: pagePath,
      });
    } catch {
      // A blocked analytics script must never interrupt navigation.
    }
  });
  handoffDocuments.add(document);
}
