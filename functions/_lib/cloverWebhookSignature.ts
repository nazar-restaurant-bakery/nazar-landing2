// Clover Hosted Checkout signs `${timestamp}.${rawBody}` with HMAC-SHA256.
// This check must run before inspecting webhook fields or touching an order.
const MAX_AGE_SECONDS = 5 * 60;
const encoder = new TextEncoder();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyCloverWebhookSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((part) => part.trim().split("=", 2)));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!/^\d{10,}$/.test(timestamp ?? "") || !/^[a-f0-9]{64}$/i.test(signature ?? "")) return false;
  const signedSeconds = Number(timestamp);
  if (!Number.isSafeInteger(signedSeconds) || Math.abs(nowSeconds - signedSeconds) > MAX_AGE_SECONDS) return false;
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`)));
  // Compare every byte without returning on the first mismatch.
  const expected = hex(digest);
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ signature!.toLowerCase().charCodeAt(i);
  return mismatch === 0;
}
