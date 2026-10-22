// A redirect is never proof of payment. This endpoint is the only path that may
// mark a standard catering checkout paid, after signature and payment lookup.
import { verifyCloverWebhookSignature } from "../../_lib/cloverWebhookSignature.ts";
import { sendVerifiedSiteOrderEmail } from "../../_lib/siteOrderConfirmationEmail.ts";

type Env = {
  CATERING_CHECKOUT_ENABLED?: string;
  CLOVER_ENVIRONMENT?: string;
  CLOVER_MERCHANT_ID?: string;
  CLOVER_WEBHOOK_SIGNING_SECRET?: string;
  CLOVER_PLATFORM_API_TOKEN?: string;
  CLOUDFLARE_EMAIL_SEND_TOKEN?: string;
  SUPABASE_SECRET_KEY?: string;
  CATERING_SANDBOX_SUPABASE_URL?: string;
  SITE_PRODUCTION_SUPABASE_URL?: string;
  SITE_BUSINESS_ID?: string;
  CLOVER_WEBHOOK_VERIFICATION_ENABLED?: string;
};
type Context = { request: Request; env: Env };
type Webhook = { type?: string; status?: string; id?: string; merchantId?: string;
  checkoutSessionId?: string; data?: string; created?: unknown; createdTime?: unknown };
type Payment = { id?: string; amount?: number; result?: string; createdTime?: number };
type StoredOrder = { id?: string; total_cents?: number; status?: string;
  payment_provider?: string; payment_transaction_id?: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function timestampMillis(value: unknown): number | null {
  if (typeof value === "string" && /^(?:\d{10}|\d{13})$/.test(value)) {
    value = Number(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    if (value >= 1_000_000_000_000 && value < 10_000_000_000_000) return value;
    if (value >= 1_000_000_000 && value < 10_000_000_000) return value * 1000;
  }
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function reply(status: number, code: string): Response {
  return Response.json({ code }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function onRequestPost({ request, env }: Context): Promise<Response> {
  // Clover can send a one-time callback verification code before it issues a
  // signing secret. This narrowly gated setup request cannot confirm payments.
  if (env.CLOVER_WEBHOOK_VERIFICATION_ENABLED === "true" &&
      env.CLOVER_ENVIRONMENT === "production" &&
      env.CATERING_CHECKOUT_ENABLED !== "true" &&
      new URL(request.url).hostname === "www.nazarrestaurantandbakery.com" &&
      !request.headers.get("Clover-Signature")) {
    if (Number(request.headers.get("Content-Length") || 0) > 512) return reply(413, "too_large");
    const candidate = await request.text();
    if (candidate.length > 512) return reply(413, "too_large");
    let payload: unknown;
    try { payload = JSON.parse(candidate); } catch { return reply(400, "invalid_verification"); }
    if (payload && typeof payload === "object" && !Array.isArray(payload) &&
        Object.keys(payload).length === 1 &&
        typeof (payload as { verificationCode?: unknown }).verificationCode === "string" &&
        /^[A-Za-z0-9-]{8,128}$/.test((payload as { verificationCode: string }).verificationCode)) {
      // Temporary setup log: Talip reads the code in wrangler tail, enters it
      // in Clover, then disables the setup flag. No customer or payment data.
      console.info("k16_clover_webhook_verification_code",
        (payload as { verificationCode: string }).verificationCode);
      return reply(200, "verification_received");
    }
    return reply(400, "invalid_verification");
  }
  const sandbox = env.CLOVER_ENVIRONMENT === "sandbox";
  const merchantId = env.CLOVER_MERCHANT_ID;
  const databaseUrl = sandbox ? env.CATERING_SANDBOX_SUPABASE_URL : env.SITE_PRODUCTION_SUPABASE_URL;
  if (env.CATERING_CHECKOUT_ENABLED !== "true" || !env.CLOVER_WEBHOOK_SIGNING_SECRET ||
      !env.CLOVER_PLATFORM_API_TOKEN || !env.SUPABASE_SECRET_KEY?.startsWith("sb_secret_") ||
      !merchantId || !/^[A-Za-z0-9]{8,20}$/.test(merchantId) ||
      !["sandbox", "production"].includes(env.CLOVER_ENVIRONMENT ?? "") ||
      !databaseUrl || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(databaseUrl) ||
      (sandbox && !!env.SITE_PRODUCTION_SUPABASE_URL &&
        databaseUrl === env.SITE_PRODUCTION_SUPABASE_URL)) {
    return reply(503, "webhook_unavailable");
  }
  if (Number(request.headers.get("Content-Length") || 0) > 8192) return reply(413, "too_large");
  const raw = await request.text();
  if (raw.length > 8192) return reply(413, "too_large");
  if (!await verifyCloverWebhookSignature(raw, request.headers.get("Clover-Signature"),
    env.CLOVER_WEBHOOK_SIGNING_SECRET)) return reply(401, "invalid_signature");

  let event: Webhook;
  try { event = JSON.parse(raw) as Webhook; } catch { return reply(400, "invalid_event"); }
  if (!event || typeof event !== "object" || Array.isArray(event)) return reply(400, "invalid_event");
  const sessionId = event.checkoutSessionId ?? event.data;
  if (event.checkoutSessionId && event.data && event.checkoutSessionId !== event.data) {
    return reply(400, "invalid_event");
  }
  if (event.merchantId !== merchantId || event.type !== "PAYMENT" ||
      typeof event.id !== "string" || !/^[A-Za-z0-9-]{5,80}$/.test(event.id) ||
      typeof sessionId !== "string" || !/^[A-Za-z0-9-]{5,80}$/.test(sessionId)) {
    return reply(400, "invalid_event");
  }
  if (event.status !== "APPROVED") return reply(200, "ignored_nonapproved_event");

  const apiBase = env.CLOVER_ENVIRONMENT === "sandbox"
    ? "https://apisandbox.dev.clover.com" : "https://api.clover.com";
  // New sb_secret_ keys belong only in apikey; they are not JWT bearer tokens.
  const dbHeaders = { apikey: env.SUPABASE_SECRET_KEY! };
  try {
    const paymentResult = await fetch(`${apiBase}/v3/merchants/${merchantId}/payments/${event.id}`, {
      headers: { Authorization: `Bearer ${env.CLOVER_PLATFORM_API_TOKEN}`,
        Accept: "application/json", "User-Agent": "NazarCatering/1.0 (website)" },
    });
    if (!paymentResult.ok) return reply(503, "payment_lookup_unavailable");
    const payment = await paymentResult.json() as Payment;
    if (payment.id !== event.id || payment.result !== "SUCCESS" ||
        !Number.isSafeInteger(payment.amount) || payment.amount! <= 0) {
      return reply(422, "payment_not_confirmed");
    }

    const paidMillis = timestampMillis(payment.createdTime) ??
      timestampMillis(event.created ?? event.createdTime);
    if (paidMillis === null || paidMillis < 1000000000000 ||
        paidMillis > Date.now() + 5 * 60 * 1000) return reply(422, "invalid_payment_time");

    // PR 1's private site-order tables are accessible only through this
    // service-role RPC. A session unknown there belongs to the legacy catering
    // flow; every other RPC error fails closed.
    if (UUID_RE.test(env.SITE_BUSINESS_ID ?? "")) {
      const coreResult = await fetch(`${databaseUrl}/rest/v1/rpc/site_order_payment_confirm_v1`, {
        method: "POST", headers: { ...dbHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ p_business_id: env.SITE_BUSINESS_ID,
          p_session_id: sessionId, p_merchant_id: merchantId,
          p_payment_id: event.id, p_amount_cents: payment.amount,
          p_paid_at: new Date(paidMillis).toISOString(),
          p_raw_response: { id: payment.id, amount: payment.amount,
            result: payment.result, createdTime: payment.createdTime ?? null } }),
      });
      if (coreResult.ok) {
        const state = await coreResult.json() as string;
        if (!["paid", "needs_reschedule", "already_verified"].includes(state)) {
          return reply(503, "confirmation_unavailable");
        }
        // Transactional email is secondary to payment confirmation. It is
        // claimed once by the database and never changes the webhook result.
        try { await sendVerifiedSiteOrderEmail(env, databaseUrl, sessionId); } catch { /* no PII in logs */ }
        return reply(200, state);
      }
      const fault = await coreResult.json().catch(() => null) as
        { code?: string; message?: string } | null;
      if (fault?.code !== "22023" || fault.message !== "Unknown session") {
        return reply(503, "confirmation_unavailable");
      }
    }

    const orderResult = await fetch(`${databaseUrl}/rest/v1/catering_orders?payment_provider=eq.clover&payment_session_id=eq.${encodeURIComponent(sessionId)}&select=id,total_cents,status,payment_provider,payment_transaction_id`, {
      headers: dbHeaders,
    });
    if (!orderResult.ok) return reply(503, "order_lookup_unavailable");
    const orders = await orderResult.json() as StoredOrder[];
    if (orders.length !== 1 || orders[0].payment_provider !== "clover" ||
        orders[0].total_cents !== payment.amount) {
      return reply(422, "payment_order_mismatch");
    }
    if (orders[0].payment_transaction_id === event.id &&
        ["paid_scheduled", "paid_needs_reschedule"].includes(orders[0].status ?? "")) {
      return reply(200, "already_confirmed");
    }
    if (orders[0].status !== "pending_payment") return reply(503, "order_not_ready");
    const confirmed = await fetch(`${databaseUrl}/rest/v1/rpc/confirm_catering_payment_v2`, {
      method: "POST", headers: { ...dbHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ p_provider: "clover", p_session_id: sessionId, p_payment_id: event.id,
        p_paid_at: new Date(paidMillis).toISOString(), p_amount_cents: payment.amount }),
    });
    if (!confirmed.ok) return reply(503, "confirmation_unavailable");
    const state = await confirmed.json() as string;
    if (!["paid_scheduled", "paid_needs_reschedule"].includes(state)) {
      return reply(503, "confirmation_unavailable");
    }
    return reply(200, state);
  } catch { return reply(503, "webhook_unavailable"); }
}

export function onRequest(): Response { return reply(405, "method_not_allowed"); }
