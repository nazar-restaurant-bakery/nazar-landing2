// Cloudflare Pages Function. Only this route may submit leads to Supabase.
import { PRODUCTION_SUPABASE_URL, resolveServerEnvironment } from "../../src/lib/deploymentEnvironment.ts";
type Env = {
  SUPABASE_SECRET_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  CLOUDFLARE_EMAIL_SEND_TOKEN?: string;
  FORM_ERROR_ALERTS_ENABLED?: string;
  APP_ENV?: string;
  TEST_SUPABASE_URL?: string;
  TEST_BUSINESS_ID?: string;
  TEST_SUPABASE_SECRET_KEY?: string;
  TEST_TURNSTILE_SECRET_KEY?: string;
  TEST_TURNSTILE_EXPECTED_HOSTNAME?: string;
};

type Context = { request: Request; env: Env; waitUntil(promise: Promise<unknown>): void };

const SUPABASE_URL = PRODUCTION_SUPABASE_URL;
const CLOUDFLARE_ACCOUNT_ID = "50a358ead900374fd545df744bd28bef";
const STAFF_EMAIL = "ctnazarbakery@gmail.com";
const STAFF_EMAIL_FROM = "notifications@alerts.nazarrestaurantandbakery.com";
const STAFF_CRM_URL = "https://www.nazarrestaurantandbakery.com/staff";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Keep these server-side allowlists aligned with src/data/cateringMenus.ts.
const PACKAGE_LABELS: Record<string, string> = {
  "grill-favorites": "Grill Favorites", "doner-gyro": "Doner & Gyro Table",
  "office-wraps": "Office Wrap Lunch", "lahmacun-pide": "Lahmacun & Pide",
  "vegetarian-table": "Vegetarian Table",
};
const CUSTOM_ITEM_LABELS: Record<string, string> = {
  "mixed-grill": "Mixed Grill", "chicken-shish-plate": "Chicken Shish",
  "chicken-gyro-plate": "Chicken Gyro", "meat-gyro-plate": "Meat Gyro",
  "falafel-6pcs": "Falafel", "lahmacun-3pcs": "Lahmacun",
  "cheese-pie-kasarli": "Cheese Pide", "mixed-vegetable-pie": "Vegetable Pide",
  "mixed-cold-appetizers": "Mixed Meze", "rice-pilav": "Rice Pilav",
  "side-salad": "Side Salad", "traditional-turkish-bread": "Turkish Bread",
  "borek-feta-cheese": "Feta Borek", "baklava-4pcs": "Baklava",
};
const TRAY_LABELS: Record<string, string> = {
  "lentil-soup": "Lentil Soup", "caesar-salad": "Caesar Salad",
  "season-salad": "Season Salad", "shepherd-salad": "Shepherd Salad",
  "cold-appetizers-platter": "Cold Appetizers Platter", jajik: "Jajik (Cacık)",
  "cheese-rolls": "Cheese Rolls",
  falafel: "Falafel", "grilled-meatballs": "Grilled Meatballs",
  "chicken-wings": "Grilled Chicken Wings", "chicken-chops": "Chicken Chops",
  "adana-shish": "Adana Shish", "chicken-shish": "Chicken Shish",
  "meat-gyro": "Meat Gyro", "chicken-gyro": "Chicken Gyro",
};
const TRAY_SIZES = new Set([10, 20, 30, 50]);
// Keep these prices aligned with src/data/cateringMenus.ts. Client prices are never trusted.
const TRAY_PRICES: Record<string, number[]> = {
  "lentil-soup": [50, 90, 130, 200], "caesar-salad": [75, 140, 200, 300],
  "season-salad": [75, 140, 200, 300], "shepherd-salad": [75, 140, 200, 300],
  "cold-appetizers-platter": [70, 120, 160, 250], jajik: [50, 90, 130, 200],
  "cheese-rolls": [15, 27, 35, 55], falafel: [22, 40, 57, 90],
  "grilled-meatballs": [25, 45, 66, 105], "chicken-wings": [170, 320, 450, 720],
  "chicken-chops": [150, 280, 400, 650], "adana-shish": [95, 165, 240, 390],
  "chicken-shish": [85, 160, 230, 375], "meat-gyro": [150, 285, 420, 680],
  "chicken-gyro": [140, 265, 365, 580],
};
const TRAY_UNITS: Record<string, string> = {
  "lentil-soup": "servings", "caesar-salad": "servings", "season-salad": "servings",
  "shepherd-salad": "servings", "cold-appetizers-platter": "servings", jajik: "servings",
  "cheese-rolls": "pieces", falafel: "pieces", "grilled-meatballs": "pieces",
  "chicken-wings": "wings", "chicken-chops": "pieces", "adana-shish": "skewers",
  "chicken-shish": "skewers", "meat-gyro": "lb", "chicken-gyro": "lb",
};
const SPECIAL_TRAY_QUANTITIES: Record<string, number[]> = {
  "chicken-wings": [70, 140, 210, 350], "chicken-chops": [30, 60, 90, 150],
  "meat-gyro": [3.5, 7, 11, 18], "chicken-gyro": [4, 8, 12, 20],
};
const RICE_TRAY_IDS = new Set([
  "falafel", "grilled-meatballs", "chicken-chops", "adana-shish",
  "chicken-shish", "meat-gyro", "chicken-gyro",
]);

function response(status: number, code: string): Response {
  return new Response(JSON.stringify({ code }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

type FormFailure = {
  id: string; occurred_at: string; request_id: string | null;
  form_kind: "vip" | "catering" | "unknown";
  stage: "configuration" | "challenge" | "database";
  error_code: string; http_status: number;
};

async function errorRpc(env: Env, name: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST", signal: AbortSignal.timeout(4000),
    headers: { apikey: env.SUPABASE_SECRET_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function recordFormFailure(env: Env, failure: FormFailure): Promise<"accepted" | "failed" | "not_sent"> {
  if (env.APP_ENV === "isolated-test") return "not_sent";
  if (!env.SUPABASE_SECRET_KEY?.startsWith("sb_secret_")) return "not_sent";
  try {
    const saved = await errorRpc(env, "record_form_error_v1", {
      p_id: failure.id, p_request_id: failure.request_id, p_kind: failure.form_kind,
      p_stage: failure.stage, p_code: failure.error_code, p_status: failure.http_status,
      p_claim_alert: env.FORM_ERROR_ALERTS_ENABLED === "true" && !!env.CLOUDFLARE_EMAIL_SEND_TOKEN,
    });
    if (!saved.ok) throw new Error("form error log unavailable");
    const claimed = await saved.json();
    if (claimed !== true && claimed !== false) throw new Error("invalid form error log result");
    if (!claimed) return "not_sent";
    let accepted = false;
    try {
      const delivery = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/email/sending/send`, {
        method: "POST", signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_EMAIL_SEND_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ to: STAFF_EMAIL, from: STAFF_EMAIL_FROM,
          subject: failure.error_code === "controlled_delivery_test" ? "[TEST] Nazar form needs attention" : "Nazar form needs attention",
          text: [failure.error_code === "controlled_delivery_test" ? "CONTROLLED SETUP TEST — no customer submission or real form failure." : "Nazar server-reported form failure.",
            `Time (UTC): ${failure.occurred_at}`, `Reference: ${failure.id}`,
            `Form: ${failure.form_kind}`, `Stage: ${failure.stage}`, `Code: ${failure.error_code}`,
            "Check Form errors in the staff CRM. This is not a new customer request.",
            "Alerts are limited to one attempt per 15 minutes; check the CRM for other errors.",
            "https://www.nazarrestaurantandbakery.com/staff/crm"].join("\n"),
        }),
      });
      if (delivery.ok) {
        const result = await delivery.json() as { success?: boolean; result?: { delivered?: string[]; queued?: string[] } };
        accepted = result.success === true && (result.result?.delivered?.includes(STAFF_EMAIL) === true || result.result?.queued?.includes(STAFF_EMAIL) === true);
      }
    } catch { /* Alert delivery must never change the form response. */ }
    const finished = await errorRpc(env, "finish_form_error_alert_v1", { p_id: failure.id, p_accepted: accepted });
    if (!finished.ok) throw new Error("form error alert result unavailable");
    return accepted ? "accepted" : "failed";
  } catch {
    console.error(JSON.stringify({ event: "nazar_form_error_log_unavailable", id: failure.id }));
    return "failed";
  }
}

function unavailable(context: Context, stage: FormFailure["stage"], code: string,
  requestId: string | null = null, kind: FormFailure["form_kind"] = "unknown"): Response {
  const failure: FormFailure = { id: crypto.randomUUID(), occurred_at: new Date().toISOString(),
    request_id: requestId, form_kind: kind, stage, error_code: code, http_status: 503 };
  // Only allowlisted metadata: never log the request, exception text, headers or form body.
  console.error(JSON.stringify({ event: "nazar_form_error", ...failure }));
  context.waitUntil?.(recordFormFailure(context.env, failure));
  return new Response(JSON.stringify({ code: "unavailable", error_id: failure.id, occurred_at: failure.occurred_at }), {
    status: 503, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Nazar-Error-ID": failure.id },
  });
}

async function resolveFormFailures(env: Env, requestId: string): Promise<void> {
  try {
    const resolved = await errorRpc(env, "resolve_form_errors_v1", { p_request_id: requestId });
    if (!resolved.ok) throw new Error("form error resolution unavailable");
  }
  catch { console.error(JSON.stringify({ event: "nazar_form_error_resolution_unavailable", request_id: requestId })); }
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : null;
}

function phone(value: string): string | null {
  if (!value) return "";
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function customQuantities(value: unknown, ids: string[]): Record<string, number> | null {
  if (value === undefined) return Object.fromEntries(ids.map((id) => [id, 1]));
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== ids.length || Object.keys(raw).some((id) => !ids.includes(id))) return null;
  const quantities: Record<string, number> = {};
  for (const id of ids) {
    const quantity = raw[id];
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) return null;
    quantities[id] = quantity;
  }
  return quantities;
}

type NotificationClaim = {
  requestId: string;
  requestDate: string;
  eventDate: string;
  guests: number;
};

async function notifyCateringStaff(env: Env, requestId: string): Promise<void> {
  if (!env.CLOUDFLARE_EMAIL_SEND_TOKEN || !env.SUPABASE_SECRET_KEY) return;

  const rpcHeaders = { apikey: env.SUPABASE_SECRET_KEY, "Content-Type": "application/json" };
  const claimResponse = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_catering_staff_notification_v1`, {
    method: "POST", headers: rpcHeaders, body: JSON.stringify({ p_request_id: requestId }),
  });
  if (!claimResponse.ok) return;
  const claim = await claimResponse.json() as NotificationClaim | null;
  if (!claim) return; // A retry or a deduplicated signup must not send twice.

  let sent = false;
  try {
    const requestDate = new Date(claim.requestDate).toLocaleString("en-US", { timeZone: "America/New_York" });
    const delivery = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/email/sending/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_EMAIL_SEND_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: STAFF_EMAIL,
        from: STAFF_EMAIL_FROM,
        subject: "New Nazar catering request",
        text: [
          `Request date: ${requestDate}`,
          `Event date: ${claim.eventDate}`,
          `Guest count: ${claim.guests}`,
          `CRM: ${STAFF_CRM_URL}`,
        ].join("\n"),
      }),
    });
    if (delivery.ok) {
      const result = await delivery.json() as {
        success?: boolean;
        result?: { delivered?: string[]; queued?: string[] };
      };
      sent = result.success === true &&
        (result.result?.delivered?.includes(STAFF_EMAIL) === true ||
         result.result?.queued?.includes(STAFF_EMAIL) === true);
    }
  } catch {
    // Delivery failures never change the customer's successful form response.
  }
  await fetch(`${SUPABASE_URL}/rest/v1/rpc/finish_catering_staff_notification_v1`, {
    method: "POST", headers: rpcHeaders,
    body: JSON.stringify({ p_request_id: requestId, p_sent: sent }),
  });
}

export async function onRequestPost(context: Context): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin) return response(403, "forbidden");
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return response(415, "invalid_content_type");
  }
  if (Number(request.headers.get("Content-Length") || 0) > 8192) return response(413, "too_large");
  const deployment = resolveServerEnvironment(env, url.hostname);
  if (!deployment.configured) return response(503, "isolated_environment_unavailable");
  if (!deployment.turnstileSecret || !deployment.secret.startsWith("sb_secret_")) {
    return unavailable(context, "configuration", "missing_server_configuration");
  }

  let data: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 8192) return response(413, "too_large");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return response(400, "invalid_input");
    data = parsed as Record<string, unknown>;
  } catch {
    return response(400, "invalid_input");
  }

  // A bot that fills the hidden field receives no indication that it was rejected.
  if (typeof data.extra === "string" && data.extra.trim()) return response(200, "accepted");

  const kind = data.kind;
  const name = text(data.name, 150);
  const email = text(data.email, 254)?.toLowerCase();
  const rawPhone = text(data.phone, 30);
  const normalizedPhone = rawPhone === null ? null : phone(rawPhone);
  const token = text(data.turnstileToken, 2048);
  const requestId = text(data.requestId, 36);
  if (
    (kind !== "vip" && kind !== "catering") || name === null || email === null ||
    normalizedPhone === null || !token || !requestId || !REQUEST_ID_RE.test(requestId) ||
    (!email && !normalizedPhone) ||
    (email && !EMAIL_RE.test(email))
  ) return response(400, "invalid_input");
  if (kind === "vip" && (!email || data.consentEmail !== true)) return response(400, "invalid_input");

  const meta: Record<string, unknown> = {};
  if (kind === "catering") {
    const date = text(data.eventDate, 10);
    const guests = data.guests;
    const message = text(data.message, 2000);
    if (!date || !validCalendarDate(date) || message === null ||
        typeof guests !== "string" || !/^[1-9]\d{0,4}$/.test(guests) || Number(guests) > 10000) {
      return response(400, "invalid_input");
    }
    meta.event_date = date;
    meta.guests = Number(guests);
    let menuSummary = "";
    if (data.menuChoice !== undefined && data.menuChoice !== null) {
      const choice = data.menuChoice;
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) return response(400, "invalid_input");
      const selected = choice as Record<string, unknown>;
      if (selected.type === "package") {
        if (typeof selected.id !== "string" || !Object.hasOwn(PACKAGE_LABELS, selected.id)) {
          return response(400, "invalid_input");
        }
        menuSummary = `Requested catering menu: ${PACKAGE_LABELS[selected.id]} (${selected.id})`;
      } else if (selected.type === "custom") {
        const ids = selected.itemIds;
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > Object.keys(CUSTOM_ITEM_LABELS).length ||
            new Set(ids).size !== ids.length ||
            !ids.every((id) => typeof id === "string" && Object.hasOwn(CUSTOM_ITEM_LABELS, id))) {
          return response(400, "invalid_input");
        }
        const quantities = customQuantities(selected.quantities, ids);
        if (!quantities) return response(400, "invalid_input");
        menuSummary = `Create your own: ${ids.map((id: string) => `${quantities[id]} × ${CUSTOM_ITEM_LABELS[id]}`).join(", ")}`;
      } else if (selected.type === "trays") {
        const selections = selected.selections;
        const itemIds = selected.itemIds;
        if (!Array.isArray(selections) || selections.length < 1 || selections.length > Object.keys(TRAY_LABELS).length) {
          return response(400, "invalid_input");
        }
        if (!Array.isArray(itemIds) || itemIds.length > Object.keys(CUSTOM_ITEM_LABELS).length ||
            new Set(itemIds).size !== itemIds.length ||
            !itemIds.every((id) => typeof id === "string" && Object.hasOwn(CUSTOM_ITEM_LABELS, id))) {
          return response(400, "invalid_input");
        }
        const quantities = customQuantities(selected.quantities, itemIds);
        if (!quantities) return response(400, "invalid_input");
        const seen = new Set<string>();
        const labels: string[] = [];
        let subtotal = 0;
        for (const entry of selections) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return response(400, "invalid_input");
          const tray = entry as Record<string, unknown>;
          if (typeof tray.id !== "string" || !Object.hasOwn(TRAY_LABELS, tray.id) ||
              typeof tray.size !== "number" || !TRAY_SIZES.has(tray.size) || seen.has(tray.id)) {
            return response(400, "invalid_input");
          }
          seen.add(tray.id);
          const index = [10, 20, 30, 50].indexOf(tray.size);
          const quantity = SPECIAL_TRAY_QUANTITIES[tray.id]?.[index] ?? tray.size;
          const price = TRAY_PRICES[tray.id][index];
          subtotal += price;
          labels.push(`${TRAY_LABELS[tray.id]} (${quantity} ${TRAY_UNITS[tray.id]}, ${tray.size}-guest option${RICE_TRAY_IDS.has(tray.id) ? ", with rice pilav" : ""}) $${price.toFixed(2)}`);
        }
        menuSummary = `Catering trays: ${labels.join(", ")}; shown tray subtotal: $${subtotal.toFixed(2)}`;
        if (itemIds.length) menuSummary += `; additional dishes: ${itemIds.map((id: string) => `${quantities[id]} × ${CUSTOM_ITEM_LABELS[id]}`).join(", ")}`;
      } else {
        return response(400, "invalid_input");
      }
    }
    if (menuSummary || message) meta.message = [menuSummary, message].filter(Boolean).join("\n\n");
  }

  let utm: Record<string, string> | null = null;
  if (data.utm !== null && data.utm !== undefined) {
    if (!data.utm || typeof data.utm !== "object" || Array.isArray(data.utm)) {
      return response(400, "invalid_input");
    }
    utm = {};
    for (const key of [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "gclid", "fbclid", "ttclid", "landing_page",
    ]) {
      const value = (data.utm as Record<string, unknown>)[key];
      if (value !== undefined) {
        const cleaned = text(value, 200);
        if (cleaned === null) return response(400, "invalid_input");
        if (cleaned) utm[key] = cleaned;
      }
    }
    if (!Object.keys(utm).length) utm = null;
  }

  let stage: FormFailure["stage"] = "challenge";
  try {
    const challenge = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: deployment.turnstileSecret,
        response: token,
        remoteip: request.headers.get("CF-Connecting-IP") || undefined,
      }),
    });
    if (!challenge.ok) return unavailable(context, stage, "challenge_unavailable", requestId, kind);
    // Provider/configuration failures belong to the existing safe 503 incident
    // flow. Ordinary invalid/expired visitor tokens remain a rejected 403.
    let verification: { success: boolean; hostname?: string; "error-codes"?: unknown };
    try {
      const value: unknown = await challenge.json();
      if (!value || typeof value !== "object" || Array.isArray(value)
        || typeof (value as { success?: unknown }).success !== "boolean") {
        return unavailable(context, stage, "challenge_unavailable", requestId, kind);
      }
      verification = value as typeof verification;
    } catch { return unavailable(context, stage, "challenge_unavailable", requestId, kind); }
    const errors = verification["error-codes"];
    if (Array.isArray(errors) && errors.some(code => ["missing-input-secret", "invalid-input-secret", "internal-error"].includes(code))) {
      return unavailable(context, stage, "challenge_unavailable", requestId, kind);
    }
    if (verification.success !== true || verification.hostname !== deployment.turnstileExpectedHostname) {
      return response(403, "verification_failed");
    }

    stage = "database";
    const db = await fetch(`${deployment.url}/rest/v1/rpc/submit_signup_once`, {
      method: "POST",
      signal: AbortSignal.timeout(7000),
      headers: {
        apikey: deployment.secret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_request_id: requestId,
        p_business_id: deployment.businessId,
        p_name: name || null,
        p_email: email || null,
        p_phone: normalizedPhone || null,
        p_source: kind === "vip" ? "website_vip_page" : "catering",
        p_consent_email: kind === "vip",
        p_consent_sms: false,
        p_utm: utm,
        p_meta: kind === "catering" && Object.keys(meta).length ? meta : null,
      }),
    });
    if (!db.ok) return unavailable(context, stage, "database_unavailable", requestId, kind);
    if (!deployment.isolated) context.waitUntil?.(Promise.allSettled([
      resolveFormFailures(env, requestId),
      ...(kind === "catering" ? [notifyCateringStaff(env, requestId)] : []),
    ]));
    return response(200, "accepted");
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return unavailable(context, stage, timeout ? "upstream_timeout" : "upstream_network_error", requestId, kind);
  }
}

export function onRequest(): Response {
  return response(405, "method_not_allowed");
}
