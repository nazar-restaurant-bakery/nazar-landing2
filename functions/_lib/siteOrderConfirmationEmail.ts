const CLOUDFLARE_ACCOUNT_ID = "50a358ead900374fd545df744bd28bef";
const FROM = "notifications@alerts.nazarrestaurantandbakery.com";

type Env = { SUPABASE_SECRET_KEY?: string; SITE_BUSINESS_ID?: string;
  CLOUDFLARE_EMAIL_SEND_TOKEN?: string };
type Claim = { orderId: string; email: string; requestedAt: string;
  totalCents: number; status: "paid" | "needs_reschedule" };

// The claim is database-unique per paid order. An uncertain provider response is
// left for staff review, never retried blindly (no duplicate receipt email).
export async function sendVerifiedSiteOrderEmail(
  env: Env, databaseUrl: string, sessionId: string,
): Promise<void> {
  if (!env.CLOUDFLARE_EMAIL_SEND_TOKEN || !env.SUPABASE_SECRET_KEY ||
      !env.SITE_BUSINESS_ID) return;
  const headers = { apikey: env.SUPABASE_SECRET_KEY, "Content-Type": "application/json" };
  const claimed = await fetch(`${databaseUrl}/rest/v1/rpc/site_order_customer_email_claim_v1`, {
    method: "POST", headers,
    body: JSON.stringify({ p_business_id: env.SITE_BUSINESS_ID, p_session_id: sessionId }),
  });
  if (!claimed.ok) return;
  const claim = await claimed.json() as Claim | null;
  if (!claim) return;
  let sent = false;
  let providerStatus = "not_accepted";
  try {
    const pickup = new Date(claim.requestedAt).toLocaleString("en-US", {
      timeZone: "America/New_York", dateStyle: "full", timeStyle: "short",
    });
    const paymentLine = claim.status === "needs_reschedule"
      ? "Your payment was received. Nazar will contact you to confirm a new pickup time."
      : "Your payment was received and your pickup order is confirmed.";
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/email/sending/send`, {
        method: "POST", headers: { Authorization: `Bearer ${env.CLOUDFLARE_EMAIL_SEND_TOKEN}`,
          "Content-Type": "application/json" },
        body: JSON.stringify({ to: claim.email, from: FROM,
          subject: `Nazar catering order ${claim.orderId.slice(0, 8).toUpperCase()}`,
          text: [`Nazar Restaurant & Bakery`, `Order: ${claim.orderId}`,
            paymentLine, `Requested pickup: ${pickup}`,
            `Paid total: $${(claim.totalCents / 100).toFixed(2)}`,
            "Questions? Call Nazar at +1 (203) 408-2697."].join("\n") }),
      });
    if (response.ok) {
      const result = await response.json() as { success?: boolean;
        result?: { delivered?: string[]; queued?: string[] } };
      sent = result.success === true &&
        (result.result?.delivered?.includes(claim.email) === true ||
         result.result?.queued?.includes(claim.email) === true);
      providerStatus = sent ? "accepted" : "not_accepted";
    }
  } catch { providerStatus = "provider_error"; }
  await fetch(`${databaseUrl}/rest/v1/rpc/site_order_customer_email_finish_v1`, {
    method: "POST", headers,
    body: JSON.stringify({ p_business_id: env.SITE_BUSINESS_ID,
      p_site_order_id: claim.orderId, p_sent: sent, p_provider_status: providerStatus }),
  }).catch(() => undefined);
}
