export const CATERING_LEAD_TIME_MS = 72 * 60 * 60 * 1000;
// A Clover Hosted Checkout session lasts 15 minutes. Reserve 5 more minutes
// so a successful payment near expiration does not invalidate the chosen slot.
export const CHECKOUT_TIME_BUFFER_MS = 20 * 60 * 1000;

const newYorkClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  hour: "2-digit", minute: "2-digit",
});

export function validatePickupSlot(value: unknown, checkoutStartedAt: Date): Date {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new TypeError("Pickup time must include a timezone offset");
  }
  const slot = new Date(value);
  if (!Number.isFinite(slot.getTime()) || !Number.isFinite(checkoutStartedAt.getTime())) {
    throw new RangeError("Invalid pickup or checkout time");
  }
  if (slot.getTime() < checkoutStartedAt.getTime() + CATERING_LEAD_TIME_MS + CHECKOUT_TIME_BUFFER_MS) {
    throw new RangeError("Pickup must allow 72 hours after payment");
  }
  const parts = Object.fromEntries(newYorkClock.formatToParts(slot).map(({ type, value: part }) => [type, part]));
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (hour < 11 || hour > 19 || (hour === 19 && minute !== 0) || minute % 30 !== 0) {
    throw new RangeError("Pickup must be between 11:00 and 19:00 New York time, on the half-hour");
  }
  return slot;
}
