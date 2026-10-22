import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { onRequestPost } from "../functions/api/catering/checkout.ts";

const url = "https://www.nazarrestaurantandbakery.com/api/catering/checkout";
const env = {
  CATERING_CHECKOUT_ENABLED: "true", SUPABASE_SECRET_KEY: "sb_secret_test",
  TURNSTILE_SECRET_KEY: "test", CLOVER_HOSTED_CHECKOUT_PRIVATE_KEY: "test",
  CLOVER_MERCHANT_ID: "22JDW74C8E0Y1", CLOVER_ENVIRONMENT: "sandbox",
  CLOVER_TAX_RATE_ID: "SANDBOX_TAX_ID",
  CATERING_SANDBOX_SUPABASE_URL: "https://catering-sandbox.supabase.co",
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function request(data, origin = "https://www.nazarrestaurantandbakery.com") {
  return new Request(url, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });
}
function order() {
  const pickup = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
  pickup.setUTCHours(17, 0, 0, 0);
  return { name: "Test Customer", email: "customer@example.invalid", phone: "",
    preparationNote: "No onions", fulfillmentMethod: "pickup", requestKind: "standard",
    turnstileToken: "test-token", pickupAt: pickup.toISOString(),
    selections: [{ id: "jajik", size: 10, quantity: 1, price: 1 }] };
}

test("checkout stays unavailable until explicitly configured", async () => {
  const production = await onRequestPost({ request: request(order()), env: {} });
  assert.equal(production.status, 503);
  assert.deepEqual(await production.json(), { code: "checkout_unavailable" });
  assert.equal((await onRequestPost({ request: request(order(), "https://other.invalid"), env })).status, 403);
  const isolated = await onRequestPost({ request: request(order()), env: {
    ...env, CATERING_SANDBOX_SUPABASE_URL: "https://khgczybubufouraqyrcj.supabase.co",
  } });
  assert.equal(isolated.status, 503);
  assert.equal((await isolated.json()).checks.sandboxDatabaseIsolated, false);
});

test("sandbox preflight reports only booleans and never secret material", async () => {
  const response = await onRequestPost({ request: request(order()), env: {
    ...env, SUPABASE_SECRET_KEY: "legacy-key-private-value", CLOVER_HOSTED_CHECKOUT_PRIVATE_KEY: undefined,
  } });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, "checkout_unavailable");
  assert.equal(body.checks.supabaseKeyPrefix, false);
  assert.equal(body.checks.cloverPrivateKeyPresent, false);
  assert.equal(body.checks.providerConfigured, false);
  assert.ok(Object.values(body.checks).every((value) => typeof value === "boolean"));
  assert.ok(!JSON.stringify(body).includes("private-value"));
});

test("missing merchant tax reference prevents both sandbox and production checkout", async () => {
  globalThis.fetch = () => { throw new Error("should not fetch"); };
  const sandboxResponse = await onRequestPost({ request: request(order()), env: {
    ...env, CLOVER_TAX_RATE_ID: "  ",
  } });
  assert.equal(sandboxResponse.status, 503);
  const sandboxBody = await sandboxResponse.json();
  assert.equal(sandboxBody.checks.taxRateIdPresent, false);
  assert.equal(sandboxBody.checks.providerConfigured, false);

  const productionResponse = await onRequestPost({ request: request(order()), env: {
    ...env, CLOVER_ENVIRONMENT: "production", CLOVER_MERCHANT_ID: "F8Q154GMDKFD1",
    CLOVER_TAX_RATE_ID: undefined,
  } });
  assert.equal(productionResponse.status, 503);
  assert.deepEqual(await productionResponse.json(), { code: "checkout_unavailable" });
});

test("sandbox catch identifies the failed stage without disclosing exception text", async () => {
  const privateText = "sb_secret_sensitive-value";
  globalThis.fetch = async () => { throw new TypeError(privateText); };
  const sandboxResponse = await onRequestPost({ request: request(order()), env });
  assert.deepEqual(await sandboxResponse.json(),
    { code: "checkout_unavailable", stage: "turnstile", error: "TypeError" });
  const productionResponse = await onRequestPost({ request: request(order()), env: {
    ...env, CLOVER_ENVIRONMENT: "production", CLOVER_MERCHANT_ID: "F8Q154GMDKFD1",
  } });
  assert.deepEqual(await productionResponse.json(), { code: "checkout_unavailable" });
});

test("sandbox trims secrets before verification and insert headers", async () => {
  let calls = 0;
  globalThis.fetch = async (_address, options) => {
    calls++;
    if (calls === 1) {
      assert.equal(JSON.parse(options.body).secret, "turnstile-secret");
      return Response.json({ success: true, hostname: "www.nazarrestaurantandbakery.com" });
    }
    assert.equal(options.headers.apikey, "sb_secret_test");
    throw new TypeError("private insert failure");
  };
  const response = await onRequestPost({ request: request(order()), env: {
    ...env, SUPABASE_SECRET_KEY: " sb_secret_test\r\n",
    TURNSTILE_SECRET_KEY: " turnstile-secret\n",
  } });
  assert.equal(calls, 2);
  assert.deepEqual(await response.json(),
    { code: "checkout_unavailable", stage: "insert", error: "TypeError" });
});

test("sandbox identifies Clover session and order update exceptions", async () => {
  for (const failingStage of ["clover_session", "update"]) {
    let calls = 0;
    globalThis.fetch = async (_address, options) => {
      calls++;
      if (calls === 1) return Response.json({ success: true, hostname: "www.nazarrestaurantandbakery.com" });
      if (calls === 2) return Response.json([{ id: "12345678-1234-1234-1234-123456789012" }]);
      if (calls === 3) {
        assert.equal(options.headers.Authorization, "Bearer private-key");
        if (failingStage === "clover_session") throw new SyntaxError("private clover failure");
        return Response.json({ href: "https://checkout.clover.com/pay/test", checkoutSessionId: "session-test" });
      }
      throw new TypeError("private update failure");
    };
    const response = await onRequestPost({ request: request(order()), env: {
      ...env, CLOVER_HOSTED_CHECKOUT_PRIVATE_KEY: " private-key\n",
    } });
    assert.equal(calls, failingStage === "clover_session" ? 3 : 4);
    assert.deepEqual(await response.json(), { code: "checkout_unavailable", stage: failingStage,
      error: failingStage === "clover_session" ? "SyntaxError" : "TypeError" });
  }
});

test("failed validation makes no external calls", async () => {
  globalThis.fetch = () => { throw new Error("should not fetch"); };
  const response = await onRequestPost({ request: request({ ...order(), pickupAt: new Date().toISOString() }), env });
  assert.equal(response.status, 400);
});

test("official Turnstile test hostname works only with the sandbox test secret", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return Response.json({ success: true, hostname: "example.com",
      metadata: { result_with_testing_key: true } });
    return Response.json([], { status: 503 });
  };
  const testSecret = { ...env, TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" };
  const accepted = await onRequestPost({ request: request(order()), env: testSecret });
  assert.equal(accepted.status, 503);
  assert.equal((await accepted.json()).code, "order_storage_unavailable");
  assert.equal(calls, 2);

  calls = 0;
  const rejected = await onRequestPost({ request: request(order()), env });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).code, "verification_failed");
  assert.equal(calls, 1);
});

test("server owns stored amount and checkout item price", async () => {
  const calls = [];
  globalThis.fetch = async (address, options) => {
    calls.push({ address: String(address), options });
    if (calls.length === 1) return Response.json({ success: true, hostname: "www.nazarrestaurantandbakery.com" });
    if (calls.length === 2) return Response.json([{ id: "12345678-1234-1234-1234-123456789012" }]);
    if (calls.length === 3) return Response.json({ href: "https://checkout.clover.com/pay/test", checkoutSessionId: "session-test" });
    return Response.json([{ id: "12345678-1234-1234-1234-123456789012", status: "pending_payment",
      payment_provider: "clover", payment_session_id: "session-test" }]);
  };
  const response = await onRequestPost({ request: request({
    ...order(), selections: [{ id: "jajik", size: 10, quantity: 2, price: 1 }],
  }), env });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).code, "checkout_ready");
  const stored = JSON.parse(calls[1].options.body);
  assert.equal(stored.subtotal_cents, 10000);
  assert.equal(stored.tax_cents, 735);
  assert.equal(stored.total_cents, 10735);
  const clover = JSON.parse(calls[2].options.body);
  assert.equal(clover.shoppingCart.lineItems[0].price, 5000);
  assert.equal(clover.shoppingCart.lineItems[0].unitQty, 2);
  assert.equal(clover.shoppingCart.lineItems[0].taxRates[0].rate, 735000);
  assert.equal(clover.shoppingCart.lineItems[0].taxRates[0].id, "SANDBOX_TAX_ID");
  assert.equal(calls[3].options.method, "PATCH");
  assert.equal(JSON.parse(calls[3].options.body).payment_provider, "clover");
  assert.equal(JSON.parse(calls[3].options.body).payment_session_id, "session-test");
});

test("checkout fails closed when the order status was not saved", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return Response.json({ success: true, hostname: "www.nazarrestaurantandbakery.com" });
    if (calls === 2) return Response.json([{ id: "12345678-1234-1234-1234-123456789012" }]);
    if (calls === 3) return Response.json({ href: "https://checkout.clover.com/pay/test", checkoutSessionId: "session-test" });
    return Response.json([]);
  };
  assert.equal((await onRequestPost({ request: request(order()), env })).status, 503);
});
