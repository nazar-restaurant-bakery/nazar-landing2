// G21: the catering checkout adds the saved campaign source to the order RPC (p_utm) and
// changes nothing else. Providers are local fakes.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { onRequestPost } from "../functions/api/catering/checkout.ts";
import { siteOrderUtm } from "../functions/_lib/siteOrderUtm.ts";
import { orderUtm } from "../src/lib/utm.ts";

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
const ORDER_KEYS = ["p_business_id", "p_request_id", "p_request_hash", "p_kind", "p_fulfillment", "p_customer_name", "p_customer_email",
  "p_customer_phone", "p_requested_at", "p_lines", "p_note", "p_subtotal_cents", "p_tax_cents", "p_department"];
const UTM = { utm_source: "google", utm_medium: "cpc", utm_campaign: "123456789", gclid: "Cj0KCQ-synthetic", landing_page: "/catering" };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; delete globalThis.window; });

function request(extra = {}) {
  const pickup = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  pickup.setUTCHours(17, 0, 0, 0);
  if (pickup.getUTCDay() === 3) pickup.setUTCDate(pickup.getUTCDate() + 1);
  const data = { requestId: "87654321-1234-4123-8123-123456789012", name: "Checkout Customer", email: "customer@nazar-customer.com",
    phone: "(203) 555-0100", preparationNote: "", fulfillmentMethod: "pickup", requestKind: "standard", turnstileToken: "token",
    pickupAt: pickup.toISOString(), selections: [{ id: "jajik", size: 10, quantity: 1 }], ...extra };
  return new Request(url, { method: "POST", body: JSON.stringify(data),
    headers: { Origin: "https://www.nazarrestaurantandbakery.com", "Content-Type": "application/json" } });
}
function provider({ missingUtmParameter = false, utmStatus = 0 } = {}) {
  const creates = [];
  globalThis.fetch = async (address, options) => {
    const path = String(address);
    if (path.includes("turnstile")) return Response.json({ success: true, hostname: "www.nazarrestaurantandbakery.com" });
    if (path.endsWith("/rpc/site_order_create_v1")) {
      const body = JSON.parse(options.body); creates.push(body);
      if (missingUtmParameter && "p_utm" in body) return Response.json({ code: "PGRST202" }, { status: 404 });
      if (utmStatus && "p_utm" in body) return Response.json({ code: "22023", message: "Invalid site order" }, { status: utmStatus });
      return Response.json("12345678-1234-4123-8123-123456789012");
    }
    if (path.endsWith("/rpc/site_order_session_set_v1")) return Response.json(true);
    return Response.json({ href: "https://checkout.clover.com/pay/test", checkoutSessionId: "session-test" });
  };
  return creates;
}

test("a valid saved source goes to the order RPC as p_utm; the request hash and other fields are unchanged", async () => {
  const plain = provider();
  assert.equal((await onRequestPost({ request: request(), env })).status, 200);
  const tagged = provider();
  const response = await onRequestPost({ request: request({ utm: UTM }), env });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).code, "checkout_ready");
  assert.deepEqual(tagged[0].p_utm, UTM);
  const { p_utm: _ignored, ...rest } = tagged[0];
  assert.deepEqual(rest, plain[0]);
});

test("without a source the order RPC body is exactly the previous one (no p_utm key)", async () => {
  for (const extra of [{}, { utm: null }]) {
    const creates = provider();
    assert.equal((await onRequestPost({ request: request(extra), env })).status, 200);
    assert.deepEqual(Object.keys(creates[0]), ORDER_KEYS);
  }
});

test("unknown keys, long or non-text values are refused: no source is stored and checkout still works", async () => {
  for (const utm of [{ ...UTM, referrer: "https://x.test/?email=a@b.c" }, { utm_source: "x".repeat(201) }, { utm_source: 5 },
    { landing_page: "https://evil.test/" }, ["utm_source"], "google", {}]) {
    const creates = provider();
    const response = await onRequestPost({ request: request({ utm }), env });
    assert.equal(response.status, 200, JSON.stringify(utm));
    assert.equal(creates.length, 1);
    assert.equal("p_utm" in creates[0], false);
  }
  assert.equal(siteOrderUtm({ utm_source: " google " }).utm_source, "google");
  assert.equal(siteOrderUtm({ utm_source: "a\u0001b" }), null);
});

test("if the database does not have p_utm yet (404), the order is created once more without it", async () => {
  const creates = provider({ missingUtmParameter: true });
  const response = await onRequestPost({ request: request({ utm: UTM }), env });
  assert.equal(response.status, 200);
  assert.equal(creates.length, 2);
  assert.ok("p_utm" in creates[0]); assert.deepEqual(Object.keys(creates[1]), ORDER_KEYS);
  assert.equal(creates[0].p_request_id, creates[1].p_request_id);
});

test("any 4xx on the request with p_utm (e.g. 400 Invalid site order) retries once without it and the order is created", async () => {
  for (const status of [400, 409, 422]) {
    const creates = provider({ utmStatus: status });
    const response = await onRequestPost({ request: request({ utm: UTM }), env });
    assert.equal(response.status, 200, String(status));
    assert.equal((await response.json()).orderId, "12345678-1234-4123-8123-123456789012");
    assert.equal(creates.length, 2);
    assert.deepEqual(creates[0].p_utm, UTM); assert.deepEqual(Object.keys(creates[1]), ORDER_KEYS);
    assert.equal(creates[0].p_request_id, creates[1].p_request_id); assert.equal(creates[0].p_request_hash, creates[1].p_request_hash);
  }
});

test("a 5xx keeps the previous behavior: no retry, order_storage_unavailable", async () => {
  const creates = provider({ utmStatus: 503 });
  const response = await onRequestPost({ request: request({ utm: UTM }), env });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "order_storage_unavailable");
  assert.equal(creates.length, 1);
});

test("browser sends only the accepted keys (never the referrer)", () => {
  const stored = { ...UTM, referrer: "https://www.google.com/" };
  globalThis.window = { sessionStorage: { getItem: () => JSON.stringify(stored) } };
  assert.deepEqual(orderUtm(), UTM);
  globalThis.window = { sessionStorage: { getItem: () => null } };
  assert.equal(orderUtm(), null);
  globalThis.window = { sessionStorage: { getItem: () => JSON.stringify({ referrer: "https://www.google.com/" }) } };
  assert.equal(orderUtm(), null);
});
