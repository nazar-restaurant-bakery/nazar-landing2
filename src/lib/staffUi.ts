import type { Customer, Overview } from "./crmData";
import { staffCopy as c } from "./staffCopy";

export const staffTimeZone = "America/New_York";
export function staffDateInput(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: staffTimeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(value));
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function staffInputIso(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d, h, n] = match.map(Number);
  const wall = Date.UTC(y, m - 1, d, h, n);
  let candidate = wall;
  for (let i = 0; i < 4; i++) {
    const shown = staffDateInput(new Date(candidate).toISOString());
    const observed = Date.parse(`${shown}:00Z`);
    candidate += wall - observed;
  }
  // Reject overflow dates and DST gaps; do not silently move the user's deadline.
  return Number.isFinite(candidate) && staffDateInput(new Date(candidate).toISOString()) === value ? new Date(candidate).toISOString() : null;
}
export function staffDisplayDate(value: string | null | undefined) {
  if (!value) return "—";
  const calendar = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(calendar ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(parsed.getTime()) || (calendar && parsed.toISOString().slice(0, 10) !== value)) return c.invalidDate;
  return new Intl.DateTimeFormat("tr-TR", { timeZone: calendar ? "UTC" : staffTimeZone, day: "numeric", month: "short", year: "numeric", ...(calendar ? {} : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const }) }).format(parsed).replaceAll(",", "");
}
export function staffRequestError(status: string, owner: string, due: string) {
  if (!["new", "contacted", "quoted", "won", "lost", "closed"].includes(status)) return c.statusError;
  if (!owner.trim() || owner.trim().length > 100) return c.ownerError;
  if (["new", "contacted", "quoted"].includes(status) && !due) return c.followupRequired;
  return due && !staffInputIso(due) ? c.dueError : null;
}
export function staffTaskError(title: string, owner: string, due: string) {
  if (!title.trim() || title.trim().length > 300) return c.titleError;
  if (!owner.trim() || owner.trim().length > 100) return c.ownerError;
  return staffInputIso(due) ? null : c.dueError;
}
export function customerName(customer: Pick<Customer, "name" | "email" | "phone">) { return customer.name?.trim() || customer.email || customer.phone || c.noName; }
export function activityTime(customer: Customer, overview: Overview) {
  const dates = [customer.created_at, customer.last_signup_at, ...customer.notes.map(n => n.created_at), ...overview.requests.filter(r => r.customer_id === customer.id).map(r => r.created_at)];
  return Math.max(0, ...dates.map(v => v ? Date.parse(v) : 0).filter(Number.isFinite));
}
export function mergeOverview(real: Overview, test: Overview): Overview {
  const customers = new Map(real.customers.map(customer => [customer.id, customer]));
  for (const customer of test.customers) {
    const existing = customers.get(customer.id);
    if (!existing) { customers.set(customer.id, customer); continue; }
    const recent = new Map([...existing.recent_signups, ...customer.recent_signups].map(s => [s.id, s]));
    const notes = new Map([...existing.notes, ...customer.notes].map(n => [n.id, n]));
    const latest = (Date.parse(customer.last_signup_at || "") || 0) > (Date.parse(existing.last_signup_at || "") || 0) ? customer : existing;
    customers.set(customer.id, { ...existing, last_signup_at: latest.last_signup_at, last_source: latest.last_source, signup_count: existing.signup_count + customer.signup_count, vip_signup_count: existing.vip_signup_count + customer.vip_signup_count, kevin_signup_count: existing.kevin_signup_count + customer.kevin_signup_count, recent_signups: [...recent.values()], notes: [...notes.values()] });
  }
  return { customers: [...customers.values()], requests: [...new Map([...real.requests, ...test.requests].map(r => [r.id, r])).values()] };
}
export function staffDateGroup(value: string | null, now = new Date()) {
  if (!value || !Number.isFinite(Date.parse(value))) return "undated";
  const today = staffDateInput(now.toISOString()).slice(0, 10);
  const day = staffDateInput(value).slice(0, 10);
  if (day < today || (day === today && Date.parse(value) < now.getTime())) return "overdue";
  if (day === today) return "today";
  const calendar = new Date(`${today}T12:00:00Z`);
  const daysToSunday = (7 - calendar.getUTCDay()) % 7;
  calendar.setUTCDate(calendar.getUTCDate() + daysToSunday);
  return day <= calendar.toISOString().slice(0, 10) ? "thisWeek" : "later";
}
