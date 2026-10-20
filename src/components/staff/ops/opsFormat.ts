import { opsCopy as c } from "../../../lib/staffCopy";

export function opsNumber(value: number | null | undefined, digits = 0) {
  return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: digits }).format(value) : "—";
}
export function opsMetricNumber(value: number | null | undefined, source: string | undefined, key: string | undefined) {
  return opsNumber(value, key === "rating" ? 1 : source === "google_ads" && key === "conversions_7d" ? 2 : 0);
}
export function opsCurrency(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? `${value < 0 ? "−" : ""}$${opsNumber(Math.abs(value), 2)}` : "—";
}
export function opsPercent(value: number | null | undefined) { return typeof value === "number" && Number.isFinite(value) ? `%${opsNumber(value, 2)}` : "—"; }
export function opsAge(value: string | null | undefined, now = Date.now()) {
  const time = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) return value ? c.invalidDate : c.neverCollected;
  const minutes = Math.max(0, Math.floor((now - time) / 60000));
  return minutes < 1 ? c.justNow : minutes < 60 ? `${minutes} ${c.minutesAgo}` : minutes < 1440 ? `${Math.floor(minutes / 60)} ${c.hoursAgo}` : `${Math.floor(minutes / 1440)} ${c.daysAgo}`;
}
