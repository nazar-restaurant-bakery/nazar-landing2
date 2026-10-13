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

// Clover hosts checkout on another domain. This is a handoff, not a sale.
export function trackCloverOrderHandoffs(): void {
  if (typeof document === "undefined") return;
  if (handoffDocuments.has(document)) return;

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest("a[href]");
    if (!(link instanceof HTMLAnchorElement)) return;

    try {
      const url = new URL(link.href);
      if (url.hostname !== "nazar-bakery-west-haven.cloveronline.com") return;
      const tag = (window as Window & { gtag?: EventTag }).gtag;
      tag?.("event", "clover_order_click", {
        page_path: window.location.pathname,
      });
    } catch {
      // A blocked analytics script must never interrupt navigation.
    }
  });
  handoffDocuments.add(document);
}
