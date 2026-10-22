import type { PricedTray } from "./cateringOrder.ts";
import { CATERING_PRICES_CENTS } from "./cateringOrder.ts";

// The checkout route and customer cart deal only in Nazar order IDs, amounts,
// and this small payment contract. Provider APIs remain behind this boundary.
export type PaymentSession = { provider: "clover"; id: string; url: string };
export type PaymentEnvironment = {
  PAYMENT_PROVIDER?: string;
  CLOVER_ENVIRONMENT?: string;
  CLOVER_MERCHANT_ID?: string;
  CLOVER_HOSTED_CHECKOUT_PRIVATE_KEY?: string;
  CLOVER_TAX_RATE_ID?: string;
  CLOVER_TAX_RATE_MICROS?: string;
};
type PaymentRequest = {
  orderId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  pickupAt: Date;
  note: string;
  lines: PricedTray[];
  siteOrigin: string;
};
export function paymentProviderConfigured(env: PaymentEnvironment): boolean {
  const taxRate = Number(env.CLOVER_TAX_RATE_MICROS);
  return (env.PAYMENT_PROVIDER ?? "clover") === "clover" &&
    !!env.CLOVER_HOSTED_CHECKOUT_PRIVATE_KEY &&
    !!env.CLOVER_TAX_RATE_ID &&
    ["sandbox", "production"].includes(env.CLOVER_ENVIRONMENT ?? "") &&
    /^[A-Za-z0-9]{8,32}$/.test(env.CLOVER_MERCHANT_ID ?? "") &&
    Number.isSafeInteger(taxRate) && taxRate > 0 && taxRate < 10000000;
}

export async function createPaymentSession(env: PaymentEnvironment,
  order: PaymentRequest): Promise<PaymentSession> {
  if (!paymentProviderConfigured(env)) throw new Error("payment_provider_unavailable");
  const baseUrl = env.CLOVER_ENVIRONMENT === "sandbox"
    ? "https://apisandbox.dev.clover.com" : "https://api.clover.com";
  const checkout = await fetch(`${baseUrl}/invoicingcheckoutservice/v1/checkouts`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json",
      "User-Agent": "NazarCatering/1.0 (website)",
      "X-Clover-Merchant-Id": env.CLOVER_MERCHANT_ID!,
      Authorization: `Bearer ${env.CLOVER_HOSTED_CHECKOUT_PRIVATE_KEY}` },
    body: JSON.stringify({
      customer: { firstName: order.customerName.split(" ")[0],
        lastName: order.customerName.split(" ").slice(1).join(" ") || order.customerName,
        email: order.customerEmail, phoneNumber: order.customerPhone || undefined },
      shoppingCart: { lineItems: order.lines.map((line) => ({
        name: `${line.id} (${line.size} guests)`,
        price: CATERING_PRICES_CENTS[line.id][[10, 20, 30, 50].indexOf(line.size)],
        unitQty: line.quantity,
        note: `Pickup ${order.pickupAt.toISOString()}; order ${order.orderId}${order.note ? `; ${order.note}` : ""}`,
        taxRates: [{ id: env.CLOVER_TAX_RATE_ID, name: "Sales Tax",
          rate: Number(env.CLOVER_TAX_RATE_MICROS) }],
      })) },
      redirectUrls: { success: `${order.siteOrigin}/catering?payment=pending`,
        failure: `${order.siteOrigin}/catering?payment=failed`,
        cancel: `${order.siteOrigin}/catering?payment=cancelled` },
    }),
  });
  if (!checkout.ok) throw new Error("payment_provider_unavailable");
  const session = await checkout.json() as { href?: string; checkoutSessionId?: string };
  if (!session.checkoutSessionId || !session.href ||
      !/^https:\/\/([a-z0-9-]+\.)*clover\.com\//i.test(session.href)) {
    throw new Error("invalid_payment_session");
  }
  return { provider: "clover", id: session.checkoutSessionId, url: session.href };
}
