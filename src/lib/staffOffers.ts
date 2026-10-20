/** Staff-only offer catalogue. Public get_active_offers stays unchanged. */
export type StaffOfferStatus = "live" | "scheduled" | "ended" | "inactive";

export type StaffOffer = {
  id: string;
  name: string;
  description: string | null;
  code: string | null;
  channel_target: string | null;
  starts_at: string | null;
  ends_at: string | null;
  active: boolean;
  /** Computed by the RPC using the business date, not the browser clock. */
  offer_status: StaffOfferStatus;
};

export type StaffOffersRpc = (name: string, params?: Record<string, unknown>) => PromiseLike<{
  data: unknown;
  error: { code?: string; status?: number } | null;
}>;

export type StaffOffersResult =
  | { status: "ready"; offers: StaffOffer[] }
  | { status: "denied" | "unavailable" };

export const staffOfferStatusLabels: Record<StaffOfferStatus, string> = {
  live: "Yayında",
  scheduled: "Planlandı",
  ended: "Sona erdi",
  inactive: "Pasif",
};

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const nullableText = (value: unknown) => value === null || typeof value === "string";

function validOfferDate(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validStaffOffers(value: unknown): value is StaffOffer[] {
  return Array.isArray(value) && value.every((offer) => record(offer)
    && typeof offer.id === "string" && typeof offer.name === "string"
    && [offer.description, offer.code, offer.channel_target].every(nullableText)
    && validOfferDate(offer.starts_at) && validOfferDate(offer.ends_at)
    && typeof offer.active === "boolean"
    && typeof offer.offer_status === "string"
    && Object.hasOwn(staffOfferStatusLabels, offer.offer_status));
}

function denied(error: { code?: string; status?: number } | null) {
  return error?.code === "42501" || error?.code === "PGRST301"
    || error?.status === 401 || error?.status === 403;
}

/** No public-catalogue fallback: unavailable data must not look like zero offers. */
export async function loadStaffOffers(rpc: StaffOffersRpc, businessId: string): Promise<StaffOffersResult> {
  if (!businessId) return { status: "unavailable" };
  try {
    const authorization = await rpc("crm_staff_authorized_v1");
    if (denied(authorization.error) || (!authorization.error && authorization.data === false)) {
      return { status: "denied" };
    }
    if (authorization.error || authorization.data !== true) return { status: "unavailable" };
    const result = await rpc("list_offers", { p_business_id: businessId });
    if (denied(result.error)) return { status: "denied" };
    return result.error || !validStaffOffers(result.data)
      ? { status: "unavailable" }
      : { status: "ready", offers: result.data };
  } catch {
    return { status: "unavailable" };
  }
}

/** Date-only values must not shift a day in the viewer's local timezone. */
export function staffOfferDate(value: string | null) {
  if (!value) return "—";
  if (!validOfferDate(value)) return "Geçersiz tarih";
  return new Intl.DateTimeFormat("tr-TR", {
    day: "numeric", month: "short", year: "numeric", timeZone: "America/New_York",
  }).format(new Date(`${value}T12:00:00Z`));
}
