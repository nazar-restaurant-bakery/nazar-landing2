import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { onRequest, onRequestPost } from "../functions/api/signup.ts";

const url = "https://www.nazarrestaurantandbakery.com/api/signup";
const env = {
  TURNSTILE_SECRET_KEY: "test-secret",
  SUPABASE_SECRET_KEY: "sb_secret_test",
};
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function request(data, headers = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      Origin: "https://www.nazarrestaurantandbakery.com",
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(data),
  });
}

function vip(overrides = {}) {
  return {
    kind: "vip", name: "Test", email: "test@example.invalid", phone: "",
    consentEmail: true, turnstileToken: "test-token", extra: "", utm: null,
    ...overrides,
  };
}

test("non-POST and cross-origin requests are rejected", async () => {
  assert.equal(onRequest().status, 405);
  const result = await onRequestPost({ request: request(vip(), { Origin: "https://other.invalid" }), env });
  assert.equal(result.status, 403);
});

test("missing server secrets or consent fail closed", async () => {
  assert.equal((await onRequestPost({ request: request(vip()), env: {} })).status, 503);
  assert.equal((await onRequestPost({ request: request(vip({ consentEmail: false })), env })).status, 400);
});

test("failed human verification never reaches Supabase", async () => {
  const calls = [];
  globalThis.fetch = async (address) => {
    calls.push(address);
    return Response.json({ success: false });
  };
  const result = await onRequestPost({ request: request(vip()), env });
  assert.equal(result.status, 403);
  assert.equal(calls.length, 1);
});

test("VIP request forwards only validated server-owned fields", async () => {
  const calls = [];
  globalThis.fetch = async (address, options) => {
    calls.push({ address, options });
    return calls.length === 1
      ? Response.json({ success: true, hostname: "www.nazarrestaurantandbakery.com" })
      : new Response(null, { status: 204 });
  };
  const result = await onRequestPost({ request: request(vip({ email: "TEST@example.invalid", p_business_id: "foreign" })), env });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 2);
  const sent = JSON.parse(calls[1].options.body);
  assert.equal(sent.p_email, "test@example.invalid");
  assert.equal(sent.p_business_id, "a358eba4-b197-4309-805b-46f43a718454");
  assert.equal(sent.p_source, "website_vip_page");
  assert.equal(calls[1].options.headers.apikey, env.SUPABASE_SECRET_KEY);
});

test("catering data stays separate from marketing consent", async () => {
  const calls = [];
  globalThis.fetch = async (address, options) => {
    calls.push({ address, options });
    return calls.length === 1
      ? Response.json({ success: true, hostname: "www.nazarrestaurantandbakery.com" })
      : new Response(null, { status: 204 });
  };
  const result = await onRequestPost({
    request: request({ ...vip(), kind: "catering", consentEmail: false, eventDate: "2027-01-20", guests: "25", message: "Test order" }),
    env,
  });
  assert.equal(result.status, 200);
  const sent = JSON.parse(calls[1].options.body);
  assert.equal(sent.p_source, "catering");
  assert.equal(sent.p_consent_email, false);
  assert.deepEqual(sent.p_meta, { event_date: "2027-01-20", guests: 25, message: "Test order" });
});

test("database failure is not shown as a successful signup", async () => {
  let count = 0;
  globalThis.fetch = async () => {
    count++;
    return count === 1
      ? Response.json({ success: true, hostname: "www.nazarrestaurantandbakery.com" })
      : new Response("error", { status: 400 });
  };
  assert.equal((await onRequestPost({ request: request(vip()), env })).status, 503);
});
