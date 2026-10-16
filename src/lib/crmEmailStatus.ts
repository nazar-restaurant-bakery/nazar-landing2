export const emailStatuses = ["confirmed", "pending", "unsubscribed", "suppressed", "not_on_list"] as const;
export type EmailStatus = typeof emailStatuses[number];
export type SavedEmailStatus = { status: EmailStatus; checkedAt: string; blocked: boolean; blockedAt: string | null; blockedStatus: string | null };
export type EmailStatusResult = { status: EmailStatus | "unavailable"; checkedAt: string | null;
  saved: SavedEmailStatus | null; localBlocked: boolean; synced: boolean };
export const emailStatusLabel: Record<EmailStatus | "unavailable", string> = {
  confirmed: "Confirmed in Klaviyo", pending: "Confirmation not completed", unsubscribed: "Unsubscribed",
  suppressed: "Suppressed — do not email", not_on_list: "Not on the Nazar VIP list", unavailable: "Could not verify now",
};
function date(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
export function validEmailStatusResult(value: unknown): value is EmailStatusResult {
  if (!value || typeof value !== "object") return false;
  const r = value as EmailStatusResult;
  if (![...emailStatuses, "unavailable"].includes(r.status) || typeof r.localBlocked !== "boolean" || typeof r.synced !== "boolean"
    || (r.status === "unavailable" ? r.checkedAt !== null || r.synced : !date(r.checkedAt))) return false;
  const s = r.saved;
  if (s !== null && (!s || !emailStatuses.includes(s.status) || !date(s.checkedAt) || typeof s.blocked !== "boolean"
    || (s.blockedAt !== null && !date(s.blockedAt))
    || (s.blockedStatus !== null && !["unsubscribed", "suppressed"].includes(s.blockedStatus)))) return false;
  return !r.synced || s !== null;
}
