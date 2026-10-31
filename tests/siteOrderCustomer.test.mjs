import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { onRequestPost as statusPost } from "../functions/api/catering/order-status.ts";
import { sendVerifiedSiteOrderEmail } from "../functions/_lib/siteOrderConfirmationEmail.ts";

const endpoint = "https://www.nazarrestaurantandbakery.com/api/catering/order-status";
const orderId = "12345678-1234-4123-8123-123456789012";
const requestId = "87654321-1234-4123-8123-123456789012";
const env = { CATERING_CHECKOUT_ENABLED: "true", CLOVER_ENVIRONMENT: "production",
  SITE_PRODUCTION_SUPABASE_URL: "https://khgczybubufouraqyrcj.supabase.co",
  SITE_BUSINESS_ID: "a358eba4-b197-4309-805b-46f43a718454",
  SUPABASE_SECRET_KEY: "sb_secret_test", RESEND_API_KEY: "token-test" };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function request(input, origin = "https://www.nazarrestaurantandbakery.com") {
  return new Request(endpoint, { method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(input) });
}

test("status cannot be read without checkout enablement and both order references", async () => {
  globalThis.fetch = () => { throw new Error("unexpected fetch"); };
  assert.equal((await statusPost({ request: request({ orderId, requestId }), env: {} })).status, 503);
  assert.equal((await statusPost({ request: request({ orderId }), env })).status, 400);
  assert.equal((await statusPost({ request: request({ orderId, requestId }, "https://elsewhere.invalid"), env })).status, 403);
});

test("status exposes only non-personal order confirmation fields", async () => {
  globalThis.fetch = async (_address, options) => {
    assert.equal(JSON.parse(options.body).p_request_id, requestId);
    return Response.json({ orderId, status: "paid", requestedAt: "2026-11-02T17:00:00Z",
      totalCents: 1610, emailStatus: "sent", customerEmail: "secret@example.com" });
  };
  const response = await statusPost({ request: request({ orderId, requestId }), env });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, "paid");
  assert.equal(body.emailStatus, "sent");
  assert.ok(!JSON.stringify(body).includes("secret@example.com"));
  assert.ok(!JSON.stringify(body).includes(requestId));
});

test("customer email is sent only after database claim and never retried on a null claim", async () => {
  const calls = [];
  let claims = 0;
  globalThis.fetch = async (address, options) => {
    calls.push({ address: String(address), body: options.body });
    if (String(address).endsWith("/rpc/site_order_customer_email_claim_v1")) {
      return Response.json(claims++ === 0 ? { orderId, email: "customer@example.com",
        requestedAt: "2026-11-02T17:00:00Z", totalCents: 1610, status: "paid" } : null);
    }
    if (String(address).endsWith("/rpc/site_order_customer_email_detail_v1")) return Response.json(null);
    if (String(address) === "https://api.resend.com/emails") return Response.json({ id: "re_test_1" });
    if (String(address).endsWith("/rpc/site_order_customer_email_finish_v1")) return Response.json(true);
    throw new Error("unexpected fetch");
  };
  await sendVerifiedSiteOrderEmail(env, env.SITE_PRODUCTION_SUPABASE_URL, "session-1");
  await sendVerifiedSiteOrderEmail(env, env.SITE_PRODUCTION_SUPABASE_URL, "session-1");
  assert.equal(calls.length, 5);
  assert.ok(calls[0].address.endsWith("/rpc/site_order_customer_email_claim_v1"));
  assert.ok(calls[1].address.endsWith("/rpc/site_order_customer_email_detail_v1"));
  assert.equal(JSON.parse(calls[1].body).p_site_order_id, orderId);
  assert.ok(calls[2].address.includes("api.resend.com/emails"));
  assert.ok(calls[3].address.endsWith("/rpc/site_order_customer_email_finish_v1"));
  assert.equal(JSON.parse(calls[3].body).p_sent, true);
  assert.ok(calls[4].address.endsWith("/rpc/site_order_customer_email_claim_v1"));
});
