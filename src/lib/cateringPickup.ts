export const CATERING_LEAD_TIME_MS = 72 * 60 * 60 * 1000;
export const CHECKOUT_TIME_BUFFER_MS = 20 * 60 * 1000;
// Temporary business rule; move to business settings when those are introduced.
export const CATERING_CLOSED_WEEKDAY = 3; // Wednesday, New York civil date.
export const PICKUP_TIMES = Array.from({ length: 17 }, (_, i) =>
  `${String(11 + Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
const clock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  minute: "2-digit", hourCycle: "h23" });
export function newYorkDate(value: Date): string {
  const p = Object.fromEntries(clock.formatToParts(value).map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day}`;
}
export function isPickupClosed(date: string): boolean {
  return new Date(`${date}T12:00:00Z`).getUTCDay() === CATERING_CLOSED_WEEKDAY;
}
export function newYorkPickup(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  // Pickup hours never fall in the DST gap/overlap. Validate the actual civil time.
  for (const offset of ["-04:00", "-05:00"]) {
    const candidate = new Date(`${date}T${time}:00${offset}`);
    if (!Number.isFinite(candidate.getTime())) continue;
    const p = Object.fromEntries(clock.formatToParts(candidate).map(({ type, value }) => [type, value]));
    if (`${p.year}-${p.month}-${p.day}` === date && `${p.hour}:${p.minute}` === time)
      return candidate.toISOString();
  }
  return null;
}
export function pickupError(date: string, time: string, now: number): "date" | "closed" | "hours" | "lead" | null {
  const slot = newYorkPickup(date, time);
  if (!slot) return "date";
  if (isPickupClosed(date)) return "closed";
  if (!PICKUP_TIMES.includes(time)) return "hours";
  if (Date.parse(slot) < now + CATERING_LEAD_TIME_MS + CHECKOUT_TIME_BUFFER_MS) return "lead";
  return null;
}
export function firstPickup(now: number): { date: string; time: string } {
  let date = newYorkDate(new Date(now + CATERING_LEAD_TIME_MS));
  for (let i = 0; i < 8; i++) {
    const time = PICKUP_TIMES.find(time => !pickupError(date, time, now));
    if (time) return { date, time };
    const day = new Date(`${date}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 1);
    date = day.toISOString().slice(0, 10);
  }
  throw new Error("No pickup day available");
}
