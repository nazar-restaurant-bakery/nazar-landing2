// Cloudflare Pages Function. Only this route may submit leads to Supabase.
type Env = {
  SUPABASE_SECRET_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  CLOUDFLARE_EMAIL_SEND_TOKEN?: string;
};

type Context = { request: Request; env: Env; waitUntil(promise: Promise<unknown>): void };

const SUPABASE_URL = "https://khgczybubufouraqyrcj.supabase.co";
const BUSINESS_ID = "a358eba4-b197-4309-805b-46f43a718454";
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
  if (!env.TURNSTILE_SECRET_KEY || !env.SUPABASE_SECRET_KEY?.startsWith("sb_secret_")) {
    return response(503, "unavailable");
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

  try {
    const challenge = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: request.headers.get("CF-Connecting-IP") || undefined,
      }),
    });
    if (!challenge.ok) return response(503, "unavailable");
    const verification = await challenge.json() as { success?: boolean; hostname?: string };
    if (!verification.success || verification.hostname !== url.hostname) {
      return response(403, "verification_failed");
    }

    const db = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_signup_once`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_request_id: requestId,
        p_business_id: BUSINESS_ID,
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
    if (!db.ok) return response(503, "unavailable");
    if (kind === "catering") {
      context.waitUntil(notifyCateringStaff(env, requestId).catch(() => undefined));
    }
    return response(200, "accepted");
  } catch {
    return response(503, "unavailable");
  }
}

export function onRequest(): Response {
  return response(405, "method_not_allowed");
}
