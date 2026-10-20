import { staffDateInput, staffInputIso } from "./staffUi.ts";

/** Pick a completed New York calendar day within the manual 30-day pull window. */
export function closedCloverDay(day: string, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(now.getTime())) return null;
  const today = staffDateInput(now.toISOString()).slice(0, 10);
  if (day >= today) return null;
  const start = staffInputIso(`${day}T00:00`);
  if (!start) return null;
  const next = new Date(`${day}T12:00:00Z`);
  if (!Number.isFinite(next.getTime()) || next.toISOString().slice(0, 10) !== day) return null;
  next.setUTCDate(next.getUTCDate() + 1);
  const end = staffInputIso(`${next.toISOString().slice(0, 10)}T00:00`);
  if (!end) return null;
  const days = Math.ceil((now.getTime() - Date.parse(start)) / 86_400_000);
  return days >= 1 && days <= 30 ? { days, start, end } : null;
}
