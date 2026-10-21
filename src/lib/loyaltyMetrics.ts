export type LoyaltyScope = { businessId: string; month: string; includeTests: boolean; identity: string };
type KnownCount = { known: boolean; reason: string | null };
export type LoyaltyMetrics = {
  version: 1; business_id: string; month: string; timezone: string; include_tests: boolean; generated_at: string;
  customer_counts: KnownCount & { new: number | null; repeat: number | null };
  campaigns: KnownCount & { items: { campaign_id: string; name: string; applied: number;
    repeat_30d: KnownCount & { numerator: number | null; denominator: number | null; rate: number | null } }[] };
  messages: KnownCount & { sent: number | null };
  attribution: KnownCount & { orders: number | null };
};
export type LoyaltyReadState = "loading" | "ready" | "missing" | "error";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const reason = (value: unknown) => value === null || (typeof value === "string" && /^[a-z][a-z0-9_]{0,99}$/.test(value));
const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value);
const known = (value: unknown): value is Record<string, unknown> => object(value) && typeof value.known === "boolean"
  && reason(value.reason) && (value.known || value.reason !== null);
function timeZone(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); return true; } catch { return false; }
}
export function loyaltyMonth(now = new Date(), zone = "America/New_York") {
  const parts = new Intl.DateTimeFormat("en", { timeZone: zone, year: "numeric", month: "2-digit" }).formatToParts(now);
  return `${parts.find(part => part.type === "year")?.value}-${parts.find(part => part.type === "month")?.value}-01`;
}
export function loyaltyScopeMatches(left: LoyaltyScope, right: LoyaltyScope) {
  return left.identity === right.identity && left.businessId === right.businessId && left.month === right.month && left.includeTests === right.includeTests;
}
export function loyaltyRequestParams(scope: LoyaltyScope) {
  return { p_business_id: scope.businessId, p_month: scope.month, p_include_tests: scope.includeTests };
}
/** An unread source never becomes a sourced zero; reject cross-context or malformed aggregates. */
export function validLoyaltyMetrics(value: unknown, scope: LoyaltyScope): value is LoyaltyMetrics {
  if (!object(value) || value.version !== 1 || !uuid(value.business_id) || value.business_id !== scope.businessId
    || value.month !== scope.month || value.include_tests !== scope.includeTests || !timeZone(value.timezone) || !date(value.generated_at)) return false;
  const customers = value.customer_counts, campaigns = value.campaigns, messages = value.messages, attribution = value.attribution;
  if (!known(customers) || !(customers.known ? count(customers.new) && count(customers.repeat) : customers.new === null && customers.repeat === null)) return false;
  if (!known(messages) || !(messages.known ? count(messages.sent) : messages.sent === null)) return false;
  if (!known(attribution) || !(attribution.known ? count(attribution.orders) : attribution.orders === null)) return false;
  if (!known(campaigns) || !Array.isArray(campaigns.items) || (!campaigns.known && campaigns.items.length !== 0)) return false;
  const ids = new Set();
  return campaigns.items.every(item => {
    if (!object(item) || !uuid(item.campaign_id) || ids.has(item.campaign_id) || typeof item.name !== "string" || !item.name.trim() || !count(item.applied)) return false;
    ids.add(item.campaign_id);
    const repeat = item.repeat_30d;
    return known(repeat) && (repeat.known ? count(repeat.numerator) && count(repeat.denominator) && repeat.denominator > 0
      && repeat.numerator <= repeat.denominator && typeof repeat.rate === "number" && Number.isFinite(repeat.rate)
      && repeat.rate >= 0 && repeat.rate <= 1 && Math.abs(repeat.rate - repeat.numerator / repeat.denominator) <= 0.000001
      : repeat.numerator === null && repeat.denominator === null && repeat.rate === null);
  });
}
