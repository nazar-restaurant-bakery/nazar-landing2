import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { onRequestPost } from "../functions/api/catering/checkout.ts";

const url = "https://www.nazarrestaurantandbakery.com/api/catering/checkout";
const env = {
  CATERING_CHECKOUT_ENABLED: "true", SUPABASE_SECRET_KEY: "sb_secret_test",
  TURNSTILE_SECRET_KEY: "test", CLOVER_HOSTED_CHECKOUT_PRIVATE_KEY: "test",
  CLOVER_MERCHANT_ID: "22JDW74C8E0Y1", CLOVER_ENVIRONMENT: "sandbox",
  CLOVER_TAX_RATE_ID: "SANDBOX_TAX_ID", CLOVER_TAX_RATE_MICROS: "735000",
  SITE_BUSINESS_ID: "a358eba4-b197-4309-805b-46f43a718454",
  SITE_PRODUCTION_SUPABASE_URL: "https://khgczybubufouraqyrcj.supabase.co",
  CATERING_SANDBOX_SUPABASE_URL: "https://catering-sandbox.supabase.co",
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function request(data) {
  return new Request(url, { method: "POST", body: JSON.stringify(data),
    headers: { Origin: "https://www.nazarrestaurantandbakery.com", "Content-Type": "application/json" } });
}
function order(extra = {}) {
  const pickup = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  pickup.setUTCHours(17, 0, 0, 0);
  if (pickup.getUTCDay() === 3) pickup.setUTCDate(pickup.getUTCDate() + 1);
  return { requestId: "87654321-1234-4123-8123-123456789012", name: "Test Customer",
    email: "Customer@Example.invalid", phone: "(203) 555-0100", preparationNote: "", fulfillmentMethod: "pickup",
    requestKind: "standard", turnstileToken: "test-token", pickupAt: pickup.toISOString(),
    selections: [{ id: "jajik", size: 10, quantity: 1 }], ...extra };
}
function provider({ consentOk = true } = {}) {
  const calls = [];
  globalThis.fetch = async (address, options) => {
    const path = String(address);
    calls.push({ path, body: options?.body ? JSON.parse(options.body) : null });
    if (path.includes("turnstile")) return Response.json({ success: true, hostname: "www.nazarrestaurantandbakery.com" });
    if (path.endsWith("/rpc/submit_signup_once")) return consentOk ? new Response(null, { status: 204 }) : Response.json({ code: "22023" }, { status: 400 });
    if (path.endsWith("/rpc/site_order_create_v1")) return Response.json("12345678-1234-4123-8123-123456789012");
    if (path.endsWith("/rpc/site_order_session_set_v1")) return Response.json(true);
    return Response.json({ href: "https://checkout.clover.com/pay/test", checkoutSessionId: "session-test" });
  };
  return calls;
}

test("consenting checkout records email consent through the VIP intake RPC before the order", async () => {
  const calls = provider();
  const response = await onRequestPost({ request: request(order({ consentEmail: true })), env });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.code, "checkout_ready");
  assert.equal(body.consent, "recorded");
  const names = calls.map((c) => c.path.split("/").at(-1));
  assert.ok(names.indexOf("submit_signup_once") < names.indexOf("site_order_create_v1"));
  const consent = calls.find((c) => c.path.endsWith("/rpc/submit_signup_once"));
  assert.ok(consent.path.startsWith(env.CATERING_SANDBOX_SUPABASE_URL));
  assert.deepEqual(consent.body, { p_request_id: order().requestId, p_business_id: env.SITE_BUSINESS_ID,
    p_name: "Test Customer", p_email: "customer@example.invalid", p_phone: "+12035550100",
    p_source: "catering_checkout", p_consent_email: true, p_consent_sms: false, p_utm: null, p_meta: null });
});

test("checkout without consent never touches the intake RPC", async () => {
  for (const extra of [{}, { consentEmail: false }]) {
    const calls = provider();
    const response = await onRequestPost({ request: request(order(extra)), env });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).consent, "not_requested");
    assert.equal(calls.some((c) => c.path.endsWith("/rpc/submit_signup_once")), false);
  }
});

test("a consent storage failure does not block payment and is reported", async () => {
  const calls = provider({ consentOk: false });
  const original = console.error; const logged = [];
  console.error = (line) => logged.push(line);
  try {
    const response = await onRequestPost({ request: request(order({ consentEmail: true })), env });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.code, "checkout_ready");
    assert.equal(body.consent, "unrecorded");
  } finally { console.error = original; }
  assert.ok(calls.some((c) => c.path.endsWith("/rpc/site_order_create_v1")));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /catering_checkout_consent_unrecorded/);
  assert.ok(!logged[0].includes("example.invalid"));
});

test("consent must be a boolean and a non-US phone is not sent to intake", async () => {
  provider();
  assert.equal((await onRequestPost({ request: request(order({ consentEmail: "yes" })), env })).status, 400);
  const calls = provider();
  await onRequestPost({ request: request(order({ consentEmail: true, phone: "12" })), env });
  assert.equal(calls.find((c) => c.path.endsWith("/rpc/submit_signup_once")).body.p_phone, null);
});
