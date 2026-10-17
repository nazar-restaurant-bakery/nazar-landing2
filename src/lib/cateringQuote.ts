export type ApprovedQuote = {
  id: string;
  request_id: string;
  version: number;
  stage: "approved" | "sent" | "accepted" | "declined";
  menu: string;
  total_cents: number;
  pickup_terms: string;
  decision_name?: string;
  approved_at: string;
  sent_at: string | null;
};

// A staged quote screen must not call an RPC that has not been deployed yet.
export async function loadQuoteOverview(
  enabled: boolean,
  fetchOverview: () => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<{ data: unknown; error: unknown } | null> {
  return enabled ? await fetchOverview() : null;
}

export function dollarsToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return cents >= 1 && cents <= 100000000 ? cents : null;
}

export function formatDollars(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function customerQuoteMessage(name: string | null, quote: ApprovedQuote): string {
  return [
    `Hello${name?.trim() ? ` ${name.trim()}` : ""},`,
    "",
    "Nazar Restaurant & Bakery has prepared your catering quote:",
    "",
    `Menu: ${quote.menu.trim()}`,
    `Final total (including any applicable tax): ${formatDollars(quote.total_cents)}`,
    `Pickup details: ${quote.pickup_terms.trim()}`,
    "",
    "Please reply to this email to accept the quote or ask a question. Your order and payment are not completed by this email.",
    "",
    `Quote reference: ${quote.request_id.slice(0, 8)} · version ${quote.version}`,
    "Nazar Restaurant & Bakery",
  ].join("\n");
}

export function customerQuoteMailto(email: string, quote: ApprovedQuote, name: string | null): string {
  const subject = `Nazar catering quote ${quote.request_id.slice(0, 8)} v${quote.version}`;
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(customerQuoteMessage(name, quote))}`;
}
