import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { onRequestPost } from "../functions/api/catering/clover-webhook.ts";

const url = "https://www.nazarrestaurantandbakery.com/api/catering/clover-webhook";
const env = {
  CATERING_CHECKOUT_ENABLED: "true", CLOVER_ENVIRONMENT: "sandbox",
  CLOVER_MERCHANT_ID: "22JDW74C8E0Y1", CLOVER_WEBHOOK_SIGNING_SECRET: "test-secret",
  CLOVER_PLATFORM_API_TOKEN: "test-token", SUPABASE_SECRET_KEY: "sb_secret_test",
  CATERING_SANDBOX_SUPABASE_URL: "https://catering-sandbox.supabase.co",
  SITE_PRODUCTION_SUPABASE_URL: "https://catering-production.supabase.co",
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function request(event, secret = env.CLOVER_WEBHOOK_SIGNING_SECRET) {
  const raw = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key,
    new TextEncoder().encode(`${timestamp}.${raw}`))),
  (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request(url, { method: "POST", headers: {
    "Clover-Signature": `t=${timestamp},v1=${signature}` }, body: raw });
}
const event = { merchantId: "22JDW74C8E0Y1", type: "PAYMENT", status: "APPROVED",
  id: "PAYMENT12345", checkoutSessionId: "session-123", created: Date.now() };

test("temporary verification accepts only an exact code while checkout stays closed", async () => {
  const logged = [];
  const originalInfo = console.info;
  console.info = (...parts) => logged.push(parts);
  globalThis.fetch = () => { throw new Error("verification must not call providers"); };
  try {
    const code = "5220ecf5-7dea-4396-b0ba-a1659c182887";
    const make = (body) => new Request(url, { method: "POST", body: JSON.stringify(body) });
    const setup = { CLOVER_WEBHOOK_VERIFICATION_ENABLED: "true", CLOVER_ENVIRONMENT: "production",
      CATERING_CHECKOUT_ENABLED: "false" };
    assert.equal((await onRequestPost({ request: make({ verificationCode: code }), env: setup })).status, 200);
    assert.deepEqual(logged, [["k16_clover_webhook_verification_code", code]]);
    assert.equal((await onRequestPost({ request: make({ verificationCode: code, id: "extra" }), env: setup })).status, 400);
    assert.equal((await onRequestPost({ request: make({ verificationCode: code }), env: {} })).status, 503);
    assert.equal((await onRequestPost({ request: make({ verificationCode: code }),
      env: { ...setup, CATERING_CHECKOUT_ENABLED: "true" } })).status, 503);
  } finally { console.info = originalInfo; }
});

test("signed approved payment confirms a canonical site order once", async () => {
  const calls = [];
  globalThis.fetch = async (address, options) => {
    calls.push({ address: String(address), options });
    if (calls.length === 1) return Response.json({ id: event.id, amount: 5368,
      result: "SUCCESS", createdTime: event.created });
    return Response.json("paid");
  };
  const siteEnv = { ...env, SITE_BUSINESS_ID: "a358eba4-b197-4309-805b-46f43a718454" };
  const result = await onRequestPost({ request: await request(event), env: siteEnv });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).code, "paid");
  assert.equal(calls.length, 2);
  assert.match(calls[1].address, /\/rpc\/site_order_payment_confirm_v1$/);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.p_session_id, event.checkoutSessionId);
  assert.equal(body.p_payment_id, event.id);
  assert.equal(body.p_amount_cents, 5368);
  assert.equal(body.p_business_id, siteEnv.SITE_BUSINESS_ID);
  assert.equal(calls[1].options.headers.apikey, env.SUPABASE_SECRET_KEY);
});

test("only an unknown core session may fall through to legacy catering", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return Response.json({ id: event.id, amount: 5368,
      result: "SUCCESS", createdTime: event.created });
    if (calls === 2) return Response.json({ code: "22023", message: "Unknown session" }, { status: 400 });
    if (calls === 3) return Response.json([{ id: "legacy", total_cents: 5368,
      status: "pending_payment", payment_provider: "clover", payment_transaction_id: null }]);
    return Response.json("paid_scheduled");
  };
  const siteEnv = { ...env, SITE_BUSINESS_ID: "a358eba4-b197-4309-805b-46f43a718454" };
  const result = await onRequestPost({ request: await request(event), env: siteEnv });
  assert.equal((await result.json()).code, "paid_scheduled");
  assert.equal(calls, 4);
});

test("core payment mismatch cannot fall through to the legacy order", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return Response.json({ id: event.id, amount: 5368,
      result: "SUCCESS", createdTime: event.created });
    return Response.json({ code: "22023", message: "Payment mismatch" }, { status: 400 });
  };
  const siteEnv = { ...env, SITE_BUSINESS_ID: "a358eba4-b197-4309-805b-46f43a718454" };
  const result = await onRequestPost({ request: await request(event), env: siteEnv });
  assert.equal(result.status, 503);
  assert.equal(calls, 2);
});

test("webhook fails closed without integration credentials", async () => {
  assert.equal((await onRequestPost({ request: await request(event), env: {} })).status, 503);
});

test("sandbox uses its configured database and rejects a known production URL", async () => {
  const withoutProductionUrl = { ...env, SITE_PRODUCTION_SUPABASE_URL: undefined };
  const nonApproved = { ...event, status: "DECLINED" };
  assert.equal((await onRequestPost({ request: await request(nonApproved),
    env: withoutProductionUrl })).status, 200);
  const sameDatabase = { ...env, SITE_PRODUCTION_SUPABASE_URL: env.CATERING_SANDBOX_SUPABASE_URL };
  assert.equal((await onRequestPost({ request: await request(nonApproved),
    env: sameDatabase })).status, 503);
});

test("webhook rejects a bad signature before making external calls", async () => {
  globalThis.fetch = () => { throw new Error("unexpected fetch"); };
  assert.equal((await onRequestPost({ request: await request(event, "wrong-secret"), env })).status, 401);
});

test("webhook rejects conflicting checkout session IDs", async () => {
  const conflicting = { ...event, data: "different-session" };
  globalThis.fetch = () => { throw new Error("unexpected fetch"); };
  assert.equal((await onRequestPost({ request: await request(conflicting), env })).status, 400);
});

test("only a confirmed payment for the recorded session and amount marks an order paid", async () => {
  const calls = [];
  globalThis.fetch = async (address, options) => {
    calls.push({ address: String(address), options });
    if (calls.length === 1) return Response.json({ id: event.id, amount: 5368,
      result: "SUCCESS" });
    if (calls.length === 2) return Response.json([{ id: "order-123", total_cents: 5368,
      status: "pending_payment", payment_provider: "clover", payment_transaction_id: null }]);
    return Response.json("paid_scheduled");
  };
  const result = await onRequestPost({ request: await request(event), env });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).code, "paid_scheduled");
  assert.equal(calls.length, 3);
  for (const call of calls.slice(1)) {
    assert.equal(call.options.headers.apikey, env.SUPABASE_SECRET_KEY);
    assert.equal(call.options.headers.Authorization, undefined);
  }
  assert.equal(JSON.parse(calls[2].options.body).p_amount_cents, 5368);
  assert.equal(JSON.parse(calls[2].options.body).p_provider, "clover");
  assert.equal(JSON.parse(calls[2].options.body).p_session_id, event.checkoutSessionId);
  assert.equal(JSON.parse(calls[2].options.body).p_paid_at, new Date(event.created).toISOString());
});

test("webhook accepts Clover event time in Unix seconds or timezone-qualified ISO", async () => {
  const calls = [];
  globalThis.fetch = async (_address, options) => {
    calls.push(options);
    if (calls.length % 3 === 1) return Response.json({ id: event.id, amount: 5368, result: "SUCCESS" });
    if (calls.length % 3 === 2) return Response.json([{ id: "order-123", total_cents: 5368,
      status: "pending_payment", payment_provider: "clover", payment_transaction_id: null }]);
    return Response.json("paid_scheduled");
  };
  for (const created of [Math.floor(event.created / 1000), String(event.created),
    new Date(event.created).toISOString()]) {
    const result = await onRequestPost({ request: await request({ ...event, created }), env });
    assert.equal((await result.json()).code, "paid_scheduled");
  }
  assert.equal(calls.length, 9);
});

test("webhook rejects an invalid Clover event time before confirmation", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return Response.json({ id: event.id, amount: 5368, result: "SUCCESS" });
    return Response.json([{ id: "order-123", total_cents: 5368,
      status: "pending_payment", payment_provider: "clover", payment_transaction_id: null }]);
  };
  const result = await onRequestPost({ request: await request({ ...event, created: "yesterday" }), env });
  assert.equal(result.status, 422);
  assert.equal(calls, 1);
});

test("mismatched payment amount cannot confirm an order", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return Response.json({ id: event.id, amount: 5000,
      result: "SUCCESS", createdTime: event.created });
    return Response.json([{ id: "order-123", total_cents: 5368, status: "pending_payment",
      payment_provider: "clover" }]);
  };
  assert.equal((await onRequestPost({ request: await request(event), env })).status, 422);
  assert.equal(calls, 2);
});
