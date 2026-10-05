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
