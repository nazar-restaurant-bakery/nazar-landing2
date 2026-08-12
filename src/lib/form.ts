// src/lib/form.ts
//
// Shared helpers for the public-facing forms (VIP signup, catering requests).
// Kept in one place so both forms validate identically — a phone number that
// the VIP form accepts must not be rejected by the catering form.

export function cn(...classes: Array<string | false | undefined | null>) {
  return classes.filter(Boolean).join(" ");
}

/** Deliberately loose — real addresses that regexes reject are worse than junk. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Store is US-only, so normalise to E.164 with a +1 country code. */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
