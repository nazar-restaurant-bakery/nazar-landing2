// Disabled by default. Do not activate until webhook reconciliation, tax,
// pickup-slot and sandbox payment tests all pass.
import { priceStandardTrays } from "../../_lib/cateringOrder.ts";
import { validatePickupSlot } from "../../_lib/cateringPickup.ts";
import { createPaymentSession, paymentProviderConfigured } from "../../_lib/paymentProvider.ts";
import { siteOrderUtm } from "../../_lib/siteOrderUtm.ts";

type Env = {
  CATERING_CHECKOUT_ENABLED?: string;
  SUPABASE_SECRET_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  CLOVER_HOSTED_CHECKOUT_PRIVATE_KEY?: string;
  CLOVER_TAX_RATE_ID?: string;
  CLOVER_MERCHANT_ID?: string;
  CLOVER_ENVIRONMENT?: string;
  CATERING_SANDBOX_SUPABASE_URL?: string;
  SITE_PRODUCTION_SUPABASE_URL?: string;
  SITE_BUSINESS_ID?: string;
  CLOVER_TAX_RATE_MICROS?: string;
  PAYMENT_PROVIDER?: string;
};
type Context = { request: Request; env: Env };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function reply(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ code, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

function clean(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length <= maximum ? trimmed : null;
}

function usPhone(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

// Optional email marketing consent uses the same intake RPC as the VIP form.
// Suppression and test-name classification stay with the database triggers.
// Consent never blocks payment; the response says whether it was recorded.
async function recordEmailConsent(databaseUrl: string, headers: Record<string, string>,
  values: { requestId: string; businessId: string; name: string; email: string; phone: string }):
  Promise<"recorded" | "unrecorded"> {
  try {
    const saved = await fetch(`${databaseUrl}/rest/v1/rpc/submit_signup_once`, {
      method: "POST", headers, signal: AbortSignal.timeout(7000),
      body: JSON.stringify({ p_request_id: values.requestId, p_business_id: values.businessId,
        p_name: values.name, p_email: values.email, p_phone: usPhone(values.phone),
        p_source: "catering_checkout", p_consent_email: true, p_consent_sms: false,
        p_utm: null, p_meta: null }),
    });
    if (saved.ok) return "recorded";
  } catch { /* reported below without customer data */ }
  console.error(JSON.stringify({ event: "catering_checkout_consent_unrecorded", request_id: values.requestId }));
  return "unrecorded";
}

async function requestHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function onRequestPost({ request, env }: Context): Promise<Response> {
  const pageUrl = new URL(request.url);
  if (request.headers.get("Origin") !== pageUrl.origin) return reply(403, "forbidden");
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return reply(415, "invalid_content_type");
  if (Number(request.headers.get("Content-Length") || 0) > 8192) return reply(413, "too_large");
  const supabaseKey = env.SUPABASE_SECRET_KEY?.trim();
  const turnstileSecret = env.TURNSTILE_SECRET_KEY?.trim();
  const providerEnv = { ...env,
    CLOVER_HOSTED_CHECKOUT_PRIVATE_KEY: env.CLOVER_HOSTED_CHECKOUT_PRIVATE_KEY?.trim(),
    CLOVER_TAX_RATE_ID: env.CLOVER_TAX_RATE_ID?.trim() };
  const sandbox = env.CLOVER_ENVIRONMENT === "sandbox";
  const databaseUrl = sandbox ? env.CATERING_SANDBOX_SUPABASE_URL : env.SITE_PRODUCTION_SUPABASE_URL;
  const taxRateMicros = Number(env.CLOVER_TAX_RATE_MICROS);
  // The isolated sandbox may reveal which predicate failed, never its value.
  const checks = {
    enabled: env.CATERING_CHECKOUT_ENABLED === "true",
    supabaseKeyPrefix: supabaseKey?.startsWith("sb_secret_") === true,
    turnstileSecretPresent: !!turnstileSecret,
    cloverPrivateKeyPresent: !!providerEnv.CLOVER_HOSTED_CHECKOUT_PRIVATE_KEY,
    taxRateIdPresent: !!providerEnv.CLOVER_TAX_RATE_ID,
    providerConfigured: paymentProviderConfigured(providerEnv),
    databaseUrlPresent: !!databaseUrl,
    databaseUrlValid: !!databaseUrl && /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(databaseUrl),
    sandboxDatabaseIsolated: !sandbox || (!!env.SITE_PRODUCTION_SUPABASE_URL &&
      databaseUrl !== env.SITE_PRODUCTION_SUPABASE_URL),
    businessIdValid: UUID_RE.test(env.SITE_BUSINESS_ID ?? ""),
    taxRateValid: Number.isSafeInteger(taxRateMicros) && taxRateMicros > 0 && taxRateMicros < 10000000,
  };
  if (!checks.enabled || !checks.supabaseKeyPrefix || !checks.turnstileSecretPresent ||
      !checks.providerConfigured || !checks.taxRateIdPresent || !checks.databaseUrlPresent || !checks.databaseUrlValid ||
      !checks.sandboxDatabaseIsolated || !checks.businessIdValid || !checks.taxRateValid) {
    return reply(503, "checkout_unavailable", sandbox ? { checks } : {});
  }

  let input: Record<string, unknown>;
  try {
    const body = await request.text();
    if (body.length > 8192) return reply(413, "too_large");
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reply(400, "invalid_input");
    input = parsed as Record<string, unknown>;
  } catch { return reply(400, "invalid_input"); }

  const name = clean(input.name, 150);
  const email = clean(input.email, 254)?.toLowerCase();
  const phone = clean(input.phone, 30);
  const note = clean(input.preparationNote, 300);
  const token = clean(input.turnstileToken, 2048);
  const requestId = clean(input.requestId, 36);
  if (input.consentEmail !== undefined && typeof input.consentEmail !== "boolean") {
    return reply(400, "invalid_input");
  }
  const consentEmail = input.consentEmail === true;
  const utm = siteOrderUtm(input.utm);
  if (!name || !email || !EMAIL_RE.test(email) || phone === null || note === null || !token ||
      !requestId || !UUID_RE.test(requestId) ||
      input.fulfillmentMethod !== "pickup" || input.requestKind !== "standard") {
    return reply(400, "invalid_input");
  }

  let priced: ReturnType<typeof priceStandardTrays>;
  let pickupAt: Date;
  try {
    priced = priceStandardTrays(input.selections);
    pickupAt = validatePickupSlot(input.pickupAt, new Date());
  } catch { return reply(400, "invalid_selection_or_pickup_time"); }

  let stage: "turnstile" | "order_create" | "clover_session" | "session_set" = "turnstile";
  try {
    const challenge = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: turnstileSecret, response: token,
        remoteip: request.headers.get("CF-Connecting-IP") || undefined }),
    });
    if (!challenge.ok) return reply(503, "verification_unavailable");
    const verified = await challenge.json() as { success?: boolean; hostname?: string;
      metadata?: { result_with_testing_key?: boolean } };
    const officialSandboxTest = sandbox &&
      turnstileSecret === "1x0000000000000000000000000000000AA" &&
      verified.hostname === "example.com" && verified.metadata?.result_with_testing_key === true;
    if (!verified.success || (verified.hostname !== pageUrl.hostname && !officialSandboxTest)) {
      return reply(403, "verification_failed");
    }

    // The server owns prices and tax; the browser's displayed subtotal is never
    // accepted as a payment amount.
    const taxCents = priced.lines.reduce((sum, line) =>
      sum + Math.round(line.lineTotalCents * taxRateMicros / 10000000), 0);
    const totalCents = priced.subtotalCents + taxCents;
    stage = "order_create";
    const dbHeaders = { apikey: supabaseKey!,
      "Content-Type": "application/json" };
    const consent = consentEmail ? await recordEmailConsent(databaseUrl!, dbHeaders, {
      requestId, businessId: env.SITE_BUSINESS_ID!, name, email, phone }) : "not_requested";
    const orderHash = await requestHash({ name, email, phone, note, pickupAt: pickupAt.toISOString(),
      lines: priced.lines, subtotalCents: priced.subtotalCents, taxCents });
    const orderBody = {
      p_business_id: env.SITE_BUSINESS_ID, p_request_id: requestId, p_request_hash: orderHash,
      p_kind: "catering", p_fulfillment: "pickup", p_customer_name: name,
      p_customer_email: email, p_customer_phone: phone || null,
      p_requested_at: pickupAt.toISOString(), p_lines: priced.lines,
      p_note: note, p_subtotal_cents: priced.subtotalCents,
      p_tax_cents: taxCents, p_department: "catering",
    };
    const createOrder = (body: Record<string, unknown>) => fetch(`${databaseUrl}/rest/v1/rpc/site_order_create_v1`, {
      method: "POST", headers: dbHeaders, body: JSON.stringify(body) });
    // Campaign source (G21) is sent only when present and valid; it is not part of the
    // request hash. If the database does not have p_utm yet (404), the order is created
    // exactly as before without it; the request ID keeps the retry idempotent.
    let created = await createOrder(utm ? { ...orderBody, p_utm: utm } : orderBody);
    if (utm && created.status === 404) created = await createOrder(orderBody);
    if (!created.ok) return reply(503, "order_storage_unavailable");
    const orderId = await created.json() as string;
    if (!UUID_RE.test(orderId)) return reply(503, "order_storage_unavailable");

    stage = "clover_session";
    const session = await createPaymentSession(providerEnv, { orderId, customerName: name,
      customerEmail: email, customerPhone: phone || "", pickupAt, note: note || "",
      lines: priced.lines, siteOrigin: pageUrl.origin });
    stage = "session_set";
    const updated = await fetch(`${databaseUrl}/rest/v1/rpc/site_order_session_set_v1`, {
      method: "POST", headers: dbHeaders,
      body: JSON.stringify({ p_business_id: env.SITE_BUSINESS_ID,
        p_site_order_id: orderId, p_environment: env.CLOVER_ENVIRONMENT,
        p_merchant_id: env.CLOVER_MERCHANT_ID, p_session_id: session.id }),
    });
    if (!updated.ok) return reply(503, "order_storage_unavailable");
    if (await updated.json() !== true) {
      return reply(503, "order_storage_unavailable");
    }
    return reply(200, "checkout_ready", { orderId, requestId, checkoutUrl: session.url,
      totalCents, consent });
  } catch (error) {
    const errorType = error instanceof TypeError ? "TypeError" :
      error instanceof SyntaxError ? "SyntaxError" :
      error instanceof Error ? "Error" : "UnknownError";
    return reply(503, "checkout_unavailable", sandbox ? { stage, error: errorType } : {});
  }
}

export function onRequest(): Response { return reply(405, "method_not_allowed"); }
