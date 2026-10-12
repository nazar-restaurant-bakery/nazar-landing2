type EventTag = (command: "event", name: string, parameters: Record<string, string>) => void;

// Only a successfully stored catering request counts as a lead. Never send
// contact details, message text, guest count, or other form data to analytics.
export function trackCateringRequestSubmitted(): void {
  if (typeof window === "undefined") return;

  try {
    const tag = (window as Window & { gtag?: EventTag }).gtag;
    tag?.("event", "catering_request_submitted", { form_name: "catering" });
  } catch {
    // A blocked analytics script must never turn a saved request into an error.
  }
}

// Clover hosts checkout on another domain. This is a handoff, not a sale.
export function trackCloverOrderHandoffs(): void {
  if (typeof document === "undefined") return;

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
}
