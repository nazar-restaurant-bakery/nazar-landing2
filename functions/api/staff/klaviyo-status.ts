type Env = { VITE_SUPABASE_ANON_KEY?: string; KLAVIYO_CRM_READ_KEY?: string; SUPABASE_SECRET_KEY?: string };
type Context = { request: Request; env: Env };
type Status = "confirmed" | "pending" | "unsubscribed" | "suppressed" | "not_on_list";
type Saved = { status: Status; checkedAt: string; blocked: boolean; blockedAt: string | null; blockedStatus: string | null };
type Profile = { id?: string; attributes?: { email?: string; subscriptions?: { email?: { marketing?: {
  consent?: string; can_receive_email_marketing?: boolean; consent_timestamp?: string;
  last_updated?: string; suppression?: unknown; list_suppressions?: unknown;
} } } } };
const SUPABASE_URL = "https://khgczybubufouraqyrcj.supabase.co";
const VIP_LIST_ID = "UeJynm";
const statuses = ["confirmed", "pending", "unsubscribed", "suppressed", "not_on_list"];
const headers = { "Cache-Control": "private, no-store", "Content-Type": "application/json" };
function reply(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ code, ...extra }), { status, headers });
}
function validSaved(value: unknown): value is Saved {
  if (!value || typeof value !== "object") return false;
  const s = value as Saved;
  return statuses.includes(s.status) && typeof s.checkedAt === "string" && Number.isFinite(Date.parse(s.checkedAt))
    && typeof s.blocked === "boolean" && (s.blockedAt === null || typeof s.blockedAt === "string")
    && (s.blockedStatus === null || ["unsubscribed", "suppressed"].includes(s.blockedStatus));
}
function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.now() + 60_000
    ? new Date(value).toISOString() : null;
}
export async function onRequestPost({ request, env }: Context): Promise<Response> {
  if (request.headers.get("Origin") !== new URL(request.url).origin) return reply(403, "forbidden");
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return reply(415, "invalid_content_type");
  const bearer = request.headers.get("Authorization") || "";
  if (!/^Bearer [A-Za-z0-9_.-]{20,4096}$/.test(bearer)) return reply(401, "unauthorized");
  if (!env.VITE_SUPABASE_ANON_KEY || !env.KLAVIYO_CRM_READ_KEY || !env.SUPABASE_SECRET_KEY?.startsWith("sb_secret_")) return reply(503, "connection_unavailable");
  let customerId: string;
  try {
    if (Number(request.headers.get("Content-Length") || 0) > 1024) return reply(413, "too_large");
    const raw = await request.text();
    if (raw.length > 1024) return reply(413, "too_large");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reply(400, "invalid_customer");
    const id = (parsed as Record<string, unknown>).customerId;
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return reply(400, "invalid_customer");
    customerId = id;
  } catch { return reply(400, "invalid_customer"); }
  let saved: Saved | null = null;
  let localBlocked = false;
  try {
    // Resolve an existing Nazar customer's email under the existing staff session.
    const auth = await fetch(`${SUPABASE_URL}/rest/v1/rpc/crm_klaviyo_status_v1`, {
      method: "POST", signal: AbortSignal.timeout(4000),
      headers: { apikey: env.VITE_SUPABASE_ANON_KEY, Authorization: bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ p_customer_id: customerId }),
    });
    if (!auth.ok) return reply(auth.status === 401 || auth.status === 403 ? 403 : 503,
      auth.status === 401 || auth.status === 403 ? "forbidden" : "authorization_unavailable");
    const context = await auth.json() as { email?: unknown; saved?: unknown; localStatus?: unknown } | null;
    if (!context) return reply(404, "customer_not_found");
    if (context.saved !== null && !validSaved(context.saved)) return reply(503, "invalid_saved_status");
    saved = context.saved as Saved | null;
    localBlocked = context.localStatus === "unsubscribed";
    if (typeof context.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(context.email)) return reply(400, "missing_email");
    const email = context.email.trim().toLowerCase();
    const checkedAt = new Date().toISOString();
    const providerHeaders = { Authorization: `Klaviyo-API-Key ${env.KLAVIYO_CRM_READ_KEY}`,
      Accept: "application/vnd.api+json", revision: "2026-07-15" };
    async function profiles(path: string): Promise<Profile[]> {
      const endpoint = new URL(`https://a.klaviyo.com/api/${path}`);
      endpoint.searchParams.set("filter", `equals(email,${JSON.stringify(email)})`);
      endpoint.searchParams.set("additional-fields[profile]", "subscriptions");
      endpoint.searchParams.set("page[size]", "2");
      const result = await fetch(endpoint, { headers: providerHeaders, signal: AbortSignal.timeout(4000) });
      if (!result.ok) throw new Error("Provider unavailable");
      const body: unknown = await result.json();
      if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) throw new Error("Invalid provider response");
      const data = (body as { data: Profile[] }).data;
      if (data.length > 1 || data.some(p => !p || typeof p.id !== "string" || !p.id
        || p.attributes?.email?.trim().toLowerCase() !== email)) throw new Error("Ambiguous profile");
      return data;
    }
    // Global profiles include unsubscribed people who have already left the VIP list.
    const profile = (await profiles("profiles"))[0];
    let status: Status = "not_on_list";
    let providerUpdatedAt: string | null = null;
    if (profile) {
      const marketing = profile.attributes?.subscriptions?.email?.marketing;
      if (!marketing || !["SUBSCRIBED", "UNSUBSCRIBED", "NEVER_SUBSCRIBED"].includes(marketing.consent || "")) throw new Error("Missing consent");
      providerUpdatedAt = timestamp(marketing.last_updated) || timestamp(marketing.consent_timestamp);
      if (marketing.consent === "UNSUBSCRIBED") status = "unsubscribed";
      else {
        if (!Array.isArray(marketing.suppression) || !Array.isArray(marketing.list_suppressions)
          || marketing.suppression.some(s => !s || typeof s !== "object")
          || marketing.list_suppressions.some(s => !s || typeof s !== "object" || typeof s.list_id !== "string")) throw new Error("Missing suppression data");
        const negative = marketing.suppression.length > 0 || marketing.list_suppressions.some(s => s.list_id === VIP_LIST_ID)
          || (marketing.consent === "SUBSCRIBED" && marketing.can_receive_email_marketing === false);
        if (negative) status = "suppressed";
        else {
          const member = (await profiles(`lists/${VIP_LIST_ID}/profiles`))[0];
          if (member && member.id !== profile.id) throw new Error("Profile identity changed");
          status = !member ? "not_on_list"
            : marketing.consent === "SUBSCRIBED" && marketing.can_receive_email_marketing === true ? "confirmed" : "pending";
        }
      }
    }
    const recorded = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_klaviyo_status_v1`, {
      method: "POST", signal: AbortSignal.timeout(4000),
      headers: { apikey: env.SUPABASE_SECRET_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({ p_customer_id: customerId, p_email: email, p_status: status,
        p_checked_at: checkedAt, p_provider_updated_at: providerUpdatedAt }),
    });
    if (!recorded.ok) return reply(200, "save_failed", { status, checkedAt, saved, localBlocked, synced: false });
    const updated: unknown = await recorded.json();
    if (!validSaved(updated)) return reply(200, "save_failed", { status, checkedAt, saved, localBlocked, synced: false });
    return reply(200, "ok", { status, checkedAt, saved: updated, localBlocked: updated.blocked, synced: true });
  } catch {
    // Preserve earlier evidence; failed lookup never grants consent or clears a block.
    return reply(200, "lookup_unavailable", { status: "unavailable", checkedAt: null, saved, localBlocked, synced: false });
  }
}
export function onRequest(): Response { return reply(405, "method_not_allowed"); }
