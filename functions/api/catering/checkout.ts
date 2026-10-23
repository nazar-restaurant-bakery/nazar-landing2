// Disabled by default. Do not activate until webhook reconciliation, tax,
// pickup-slot and sandbox payment tests all pass.
import { priceStandardTrays } from "../../_lib/cateringOrder.ts";
import { validatePickupSlot } from "../../_lib/cateringPickup.ts";
import { createPaymentSession, paymentProviderConfigured } from "../../_lib/paymentProvider.ts";

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
  if (!name || !email || !EMAIL_RE.test(email) || phone === null || note === null || !token ||
      input.fulfillmentMethod !== "pickup" || input.requestKind !== "standard") {
    return reply(400, "invalid_input");
  }

  let priced: ReturnType<typeof priceStandardTrays>;
  let pickupAt: Date;
  try {
    priced = priceStandardTrays(input.selections);
    pickupAt = validatePickupSlot(input.pickupAt, new Date());
  } catch { return reply(400, "invalid_selection_or_pickup_time"); }

  let stage: "turnstile" | "insert" | "clover_session" | "update" = "turnstile";
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

    // This is an estimate until Clover's actual checkout amount is validated in
    // sandbox. Payment creation remains gated off in production until then.
    const taxCents = priced.lines.reduce((sum, line) =>
      sum + Math.round(line.lineTotalCents * taxRateMicros / 10000000), 0);
    const totalCents = priced.subtotalCents + taxCents;
    stage = "insert";
    const dbHeaders = { apikey: supabaseKey!,
      "Content-Type": "application/json", Prefer: "return=representation" };
    const created = await fetch(`${databaseUrl}/rest/v1/catering_orders`, {
      method: "POST", headers: dbHeaders,
      body: JSON.stringify({
        business_id: env.SITE_BUSINESS_ID, customer_name: name, customer_email: email,
        customer_phone: phone || null, fulfillment_method: "pickup",
        requested_pickup_at: pickupAt.toISOString(), preparation_note: note,
        tray_lines: priced.lines, subtotal_cents: priced.subtotalCents,
        tax_cents: taxCents, total_cents: totalCents, status: "pending_checkout",
      }),
    });
    if (!created.ok) return reply(503, "order_storage_unavailable");
    const rows = await created.json() as { id?: string }[];
    const orderId = rows?.[0]?.id;
    if (!orderId || !/^[0-9a-f-]{36}$/i.test(orderId)) return reply(503, "order_storage_unavailable");

    stage = "clover_session";
    const session = await createPaymentSession(providerEnv, { orderId, customerName: name,
      customerEmail: email, customerPhone: phone || "", pickupAt, note: note || "",
      lines: priced.lines, siteOrigin: pageUrl.origin });
    stage = "update";
    const updated = await fetch(`${databaseUrl}/rest/v1/catering_orders?id=eq.${orderId}&status=eq.pending_checkout`, {
      method: "PATCH", headers: dbHeaders,
      body: JSON.stringify({ status: "pending_payment", payment_provider: session.provider,
        payment_session_id: session.id }),
    });
    if (!updated.ok) return reply(503, "order_storage_unavailable");
    const updatedRows = await updated.json() as { id?: string; status?: string;
      payment_provider?: string; payment_session_id?: string }[];
    if (updatedRows.length !== 1 || updatedRows[0].id !== orderId ||
        updatedRows[0].status !== "pending_payment" ||
        updatedRows[0].payment_provider !== session.provider ||
        updatedRows[0].payment_session_id !== session.id) {
      return reply(503, "order_storage_unavailable");
    }
    return reply(200, "checkout_ready", { orderId, checkoutUrl: session.url });
  } catch (error) {
    const errorType = error instanceof TypeError ? "TypeError" :
      error instanceof SyntaxError ? "SyntaxError" :
      error instanceof Error ? "Error" : "UnknownError";
    return reply(503, "checkout_unavailable", sandbox ? { stage, error: errorType } : {});
  }
}

export function onRequest(): Response { return reply(405, "method_not_allowed"); }
