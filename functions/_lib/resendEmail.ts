// The only transactional email sender. The caller's claim/finish RPCs decide
// whether to send; an uncertain answer is recorded, never retried here.
export const TRANSACTIONAL_FROM = "Nazar Restaurant & Bakery <notifications@mail.nazarrestaurantandbakery.com>";

export type ResendStatus = "accepted" | "not_accepted" | "provider_error";
export type ResendMessage = { to: string; subject: string; text: string; html?: string };

// The Idempotency-Key is the claimed record id, so Resend drops a repeat of the same email.
export async function sendResendEmail(
  apiKey: string, message: ResendMessage, idempotencyKey: string,
  options: { fetcher?: typeof fetch; timeoutMs?: number } = {},
): Promise<ResendStatus> {
  if (!idempotencyKey) throw new Error("idempotency key required");
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ from: TRANSACTIONAL_FROM, to: [message.to], subject: message.subject,
        text: message.text, ...(message.html === undefined ? {} : { html: message.html }) }),
    });
    if (!response.ok) return "not_accepted";
    const result = await response.json() as { id?: unknown } | null;
    return typeof result?.id === "string" && result.id ? "accepted" : "not_accepted";
  } catch {
    return "provider_error";
  }
}
