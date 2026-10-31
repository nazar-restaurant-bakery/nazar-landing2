// Signed trigger from market.places_run_v1. Same HMAC key as the daily scheduler
// (SCHEDULER_SIGNING_SECRET), but the message starts with the purpose label
// 'market_places', so a scheduler signature is never valid here (and vice versa).
export const PURPOSE = "market_places";
export type PlacesTrigger = { business_id: string; run_id: string; nonce: string; issued_at: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validTrigger(body: unknown, now = Date.now()): body is PlacesTrigger {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as PlacesTrigger;
  return Object.keys(b).every(k => ["business_id", "run_id", "nonce", "issued_at"].includes(k))
    && uuid.test(b.business_id) && uuid.test(b.run_id) && uuid.test(b.nonce)
    && Number.isSafeInteger(b.issued_at) && Math.abs(now / 1000 - b.issued_at) <= 300;
}
const message = (b: PlacesTrigger) => [PURPOSE, b.business_id, b.run_id, b.nonce, String(b.issued_at)].join("\n");
async function key(secret: string) {
  if (secret.length < 32) throw Error("machine_not_configured");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function placesSignature(b: PlacesTrigger, secret: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), new TextEncoder().encode(message(b))));
  return [...bytes].map(v => v.toString(16).padStart(2, "0")).join("");
}
export async function verifyTrigger(b: unknown, signature: string, secret: string, now = Date.now()): Promise<boolean> {
  if (!validTrigger(b, now) || !/^[a-f0-9]{64}$/.test(signature) || secret.length < 32) return false;
  const bytes = new Uint8Array(signature.match(/../g)!.map(v => parseInt(v, 16)));
  return crypto.subtle.verify("HMAC", await key(secret), bytes, new TextEncoder().encode(message(b)));
}
