// Cloudflare Pages Function. Only this route may submit leads to Supabase.
type Env = {
  SUPABASE_SECRET_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
};

type Context = { request: Request; env: Env };

const SUPABASE_URL = "https://khgczybubufouraqyrcj.supabase.co";
const BUSINESS_ID = "a358eba4-b197-4309-805b-46f43a718454";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

export async function onRequestPost({ request, env }: Context): Promise<Response> {
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
  if (
    (kind !== "vip" && kind !== "catering") || name === null || email === null ||
    normalizedPhone === null || !token || (!email && !normalizedPhone) ||
    (email && !EMAIL_RE.test(email))
  ) return response(400, "invalid_input");
  if (kind === "vip" && (!email || data.consentEmail !== true)) return response(400, "invalid_input");

  const meta: Record<string, unknown> = {};
  if (kind === "catering") {
    const date = text(data.eventDate, 10);
    const guests = data.guests;
    const message = text(data.message, 2000);
    if (date === null || message === null) return response(400, "invalid_input");
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return response(400, "invalid_input");
    if (guests !== "" && guests !== null && guests !== undefined &&
        (!Number.isInteger(Number(guests)) || Number(guests) < 1 || Number(guests) > 10000)) {
      return response(400, "invalid_input");
    }
    if (date) meta.event_date = date;
    if (guests !== "" && guests !== null && guests !== undefined) meta.guests = Number(guests);
    if (message) meta.message = message;
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

    const db = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_signup`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
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
    return response(200, "accepted");
  } catch {
    return response(503, "unavailable");
  }
}

export function onRequest(): Response {
  return response(405, "method_not_allowed");
}
