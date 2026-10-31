import { CATERING_TRAY_LABELS } from "./cateringOrder.ts";
import { sendResendEmail } from "./resendEmail.ts";

type Env = { SUPABASE_SECRET_KEY?: string; SITE_BUSINESS_ID?: string;
  RESEND_API_KEY?: string };
export type Claim = { orderId: string; email: string; requestedAt: string;
  totalCents: number; status: "paid" | "needs_reschedule" };
// Stored order values; nothing here is recomputed from a catalog.
export type Detail = { customerName: string; preparationNote: string; lines: unknown;
  subtotalCents: number; taxCents: number; totalCents: number };
type Line = { id: string; size: number; quantity: number; lineTotalCents: number };

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const cents = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function storedLines(value: unknown): Line[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const lines: Line[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") return null;
    const { id, size, quantity, lineTotalCents } = row as Record<string, unknown>;
    if (typeof id !== "string" || !Number.isSafeInteger(size) || !Number.isSafeInteger(quantity) ||
        (quantity as number) < 1 || !cents(lineTotalCents)) return null;
    lines.push({ id, size: size as number, quantity: quantity as number, lineTotalCents });
  }
  return lines;
}

// Totals-only when the stored detail is unavailable or malformed: the payment
// confirmation itself must still reach the customer.
export function buildSiteOrderConfirmationEmail(claim: Claim, detail: Detail | null):
  { subject: string; text: string; html: string } {
  const pickup = new Date(claim.requestedAt).toLocaleString("en-US", {
    timeZone: "America/New_York", dateStyle: "full", timeStyle: "short",
  });
  const paymentLine = claim.status === "needs_reschedule"
    ? "Your payment was received. Nazar will contact you to confirm a new pickup time."
    : "Your payment was received and your pickup order is confirmed.";
  const lines = detail ? storedLines(detail.lines) : null;
  const itemized = !!detail && !!lines && cents(detail.subtotalCents) && cents(detail.taxCents) &&
    detail.totalCents === claim.totalCents;
  const rows = itemized ? lines!.map((line) => ({
    name: CATERING_TRAY_LABELS[line.id] ?? line.id,
    size: `${line.size} guests`, quantity: line.quantity, total: money(line.lineTotalCents),
  })) : [];
  const name = itemized ? detail!.customerName.trim() : "";
  const note = itemized ? detail!.preparationNote.trim() : "";

  const text = ["Nazar Restaurant & Bakery", ...(name ? [`Hello ${name},`] : []),
    `Order: ${claim.orderId}`, paymentLine, `Requested pickup: ${pickup}`,
    ...(itemized ? ["", "Items:", ...rows.map((r) => `- ${r.name} (${r.size}) x ${r.quantity}: ${r.total}`), "",
      `Subtotal: ${money(detail!.subtotalCents)}`, `Tax: ${money(detail!.taxCents)}`] : []),
    `Paid total: ${money(claim.totalCents)}`,
    ...(note ? [`Preparation note: ${note}`] : []),
    "Questions? Call Nazar at +1 (203) 408-2697."].join("\n");

  const cell = 'style="padding:4px 8px;border-bottom:1px solid #e4e4e7"';
  const right = 'style="padding:4px 8px;border-bottom:1px solid #e4e4e7;text-align:right"';
  const html = ['<div style="font-family:Arial,sans-serif;color:#18181b">',
    "<h2>Nazar Restaurant &amp; Bakery</h2>",
    ...(name ? [`<p>Hello ${escapeHtml(name)},</p>`] : []),
    `<p>${escapeHtml(paymentLine)}</p>`,
    `<p>Order: ${escapeHtml(claim.orderId)}<br>Requested pickup: ${escapeHtml(pickup)}</p>`,
    ...(itemized ? [
      '<table style="border-collapse:collapse"><thead><tr>',
      `<th ${cell}>Item</th><th ${cell}>Size</th><th ${right}>Qty</th><th ${right}>Amount</th></tr></thead><tbody>`,
      ...rows.map((r) => `<tr><td ${cell}>${escapeHtml(r.name)}</td><td ${cell}>${escapeHtml(r.size)}</td>` +
        `<td ${right}>${r.quantity}</td><td ${right}>${r.total}</td></tr>`),
      "</tbody></table>",
      `<p>Subtotal: ${money(detail!.subtotalCents)}<br>Tax: ${money(detail!.taxCents)}<br>`,
    ] : ["<p>"]),
    `<strong>Paid total: ${money(claim.totalCents)}</strong></p>`,
    ...(note ? [`<p>Preparation note: ${escapeHtml(note)}</p>`] : []),
    "<p>Questions? Call Nazar at +1 (203) 408-2697.</p></div>"].join("\n");

  return { subject: `Nazar catering order ${claim.orderId.slice(0, 8).toUpperCase()}`, text, html };
}

// The claim is database-unique per paid order. An uncertain provider response is
// left for staff review, never retried blindly (no duplicate receipt email).
export async function sendVerifiedSiteOrderEmail(
  env: Env, databaseUrl: string, sessionId: string, fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.SUPABASE_SECRET_KEY ||
      !env.SITE_BUSINESS_ID) return;
  const headers = { apikey: env.SUPABASE_SECRET_KEY, "Content-Type": "application/json" };
  const claimed = await fetcher(`${databaseUrl}/rest/v1/rpc/site_order_customer_email_claim_v1`, {
    method: "POST", headers,
    body: JSON.stringify({ p_business_id: env.SITE_BUSINESS_ID, p_session_id: sessionId }),
  });
  if (!claimed.ok) return;
  const claim = await claimed.json() as Claim | null;
  if (!claim) return;
  let providerStatus = "not_accepted";
  try {
    let detail: Detail | null = null;
    try {
      const read = await fetcher(`${databaseUrl}/rest/v1/rpc/site_order_customer_email_detail_v1`, {
        method: "POST", headers,
        body: JSON.stringify({ p_business_id: env.SITE_BUSINESS_ID, p_site_order_id: claim.orderId }),
      });
      if (read.ok) detail = await read.json() as Detail | null;
    } catch { detail = null; }
    const message = buildSiteOrderConfirmationEmail(claim, detail);
    providerStatus = await sendResendEmail(env.RESEND_API_KEY, { to: claim.email, ...message },
      claim.orderId, { fetcher });
  } catch { providerStatus = "provider_error"; }
  const sent = providerStatus === "accepted";
  await fetcher(`${databaseUrl}/rest/v1/rpc/site_order_customer_email_finish_v1`, {
    method: "POST", headers,
    body: JSON.stringify({ p_business_id: env.SITE_BUSINESS_ID,
      p_site_order_id: claim.orderId, p_sent: sent, p_provider_status: providerStatus }),
  }).catch(() => undefined);
}
