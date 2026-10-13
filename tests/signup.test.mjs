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
    requestId: "f6d45fb6-0b8c-4e67-8a22-62ae287a8b13",
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
  assert.equal((await onRequestPost({ request: request(vip({ requestId: "bad" })), env })).status, 400);
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
  assert.equal(sent.p_request_id, vip().requestId);
  assert.match(calls[1].address, /\/rpc\/submit_signup_once$/);
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
  assert.deepEqual(sent.p_meta, { event_date: "2027-01-20", guests: 25, customer_message: "Test order", message: "Test order" });
});

test("catering menu choices reach the existing request message field", async () => {
  const sent = [];
  globalThis.fetch = async (_address, options) => {
    sent.push(options);
    return sent.length % 2 === 1
      ? Response.json({ success: true, hostname: "www.nazarrestaurantandbakery.com" })
      : new Response(null, { status: 204 });
  };
  const base = { ...vip(), kind: "catering", consentEmail: false, eventDate: "", guests: "", message: "" };
  assert.equal((await onRequestPost({ request: request({ ...base, menuChoice: { type: "package", id: "doner-gyro" } }), env })).status, 200);
  assert.equal(JSON.parse(sent[1].body).p_meta.message, "Requested catering menu: Doner & Gyro Table (doner-gyro)");
  assert.deepEqual(JSON.parse(sent[1].body).p_meta.menu_selection,
    { type: "package", id: "doner-gyro", label: "Doner & Gyro Table" });
  assert.equal((await onRequestPost({ request: request({ ...base, message: "No onions", menuChoice: { type: "custom", itemIds: ["falafel-6pcs", "baklava-4pcs"] } }), env })).status, 200);
  assert.equal(JSON.parse(sent[3].body).p_meta.message, "Create your own: Falafel, Baklava\n\nNo onions");
  assert.equal(JSON.parse(sent[3].body).p_meta.customer_message, "No onions");
  assert.deepEqual(JSON.parse(sent[3].body).p_meta.menu_selection,
    { type: "custom", dishes: [
      { id: "falafel-6pcs", label: "Falafel", quantity: null },
      { id: "baklava-4pcs", label: "Baklava", quantity: null },
    ] });
  assert.equal(JSON.parse(sent[3].body).p_consent_email, false);
});

test("selected catering trays and quantities reach the quote request", async () => {
  const sent = [];
  globalThis.fetch = async (_address, options) => {
    sent.push(options);
    return sent.length === 1
      ? Response.json({ success: true, hostname: "www.nazarrestaurantandbakery.com" })
      : new Response(null, { status: 204 });
  };
  const payload = {
    ...vip(), kind: "catering", consentEmail: false, eventDate: "", guests: "30",
    message: "Mixed cold appetizers, please",
    menuChoice: { type: "trays", selections: [
      { id: "cold-appetizers-platter", size: 30 },
      { id: "jajik", size: 10 },
      { id: "chicken-wings", size: 30 },
      { id: "falafel", size: 10 },
    ], itemIds: ["baklava-4pcs"] },
  };
  assert.equal((await onRequestPost({ request: request(payload), env })).status, 200);
  assert.equal(JSON.parse(sent[1].body).p_meta.message,
    "Catering trays: Cold Appetizers Platter (30 servings, 30-guest option) $160.00, Jajik (Cacık) (10 servings, 10-guest option) $50.00, Grilled Chicken Wings (210 wings, 30-guest option) $450.00, Falafel (10 pieces, 10-guest option, with rice pilav) $22.00; shown tray subtotal: $682.00; additional dishes: Baklava\n\nMixed cold appetizers, please");
  const selection = JSON.parse(sent[1].body).p_meta.menu_selection;
  assert.equal(JSON.parse(sent[1].body).p_meta.customer_message, "Mixed cold appetizers, please");
  assert.equal(selection.type, "trays");
  assert.equal(selection.trays[2].quantity, 210);
  assert.equal(selection.trays[2].unit, "wings");
  assert.equal(selection.trays[2].shown_price, 450);
  assert.deepEqual(selection.additional_dishes,
    [{ id: "baklava-4pcs", label: "Baklava", quantity: null }]);
});

test("unknown or empty catering menu choices are rejected before verification", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Unexpected network call"); };
  const base = { ...vip(), kind: "catering", consentEmail: false, eventDate: "", guests: "", message: "" };
  for (const menuChoice of [
    { type: "package", id: "unknown" },
    { type: "custom", itemIds: [] },
    { type: "custom", itemIds: ["shawarma"] },
    { type: "custom", itemIds: ["rice-pilav", "rice-pilav"] },
    { type: "trays", selections: [], itemIds: [] },
    { type: "trays", selections: [{ id: "chicken-wings", size: 40 }], itemIds: [] },
    { type: "trays", selections: [{ id: "unknown", size: 10 }], itemIds: [] },
    { type: "trays", selections: [{ id: "falafel", size: 10 }, { id: "falafel", size: 20 }], itemIds: [] },
  ]) {
    assert.equal((await onRequestPost({ request: request({ ...base, menuChoice }), env })).status, 400);
  }
  assert.equal(calls, 0);
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

test("a transient database failure can be retried with the same request ID", async () => {
  const databaseBodies = [];
  let databaseAttempts = 0;
  globalThis.fetch = async (address, options) => {
    if (String(address).includes("/siteverify")) {
      return Response.json({ success: true, hostname: "www.nazarrestaurantandbakery.com" });
    }
    databaseBodies.push(options.body);
    databaseAttempts++;
    return new Response(null, { status: databaseAttempts === 1 ? 503 : 204 });
  };
  const payload = { ...vip(), kind: "catering", consentEmail: false,
    eventDate: "2027-01-20", message: "Synthetic retry check" };
  assert.equal((await onRequestPost({ request: request(payload), env })).status, 503);
  assert.equal((await onRequestPost({ request: request(payload), env })).status, 200);
  assert.equal(databaseAttempts, 2);
  assert.equal(databaseBodies[0], databaseBodies[1]);
});

test("a lost database response remains uncertain and can be retried", async () => {
  const databaseBodies = [];
  globalThis.fetch = async (address, options) => {
    if (String(address).includes("/siteverify")) {
      return Response.json({ success: true, hostname: "www.nazarrestaurantandbakery.com" });
    }
    databaseBodies.push(options.body);
    if (databaseBodies.length === 1) throw new Error("Response lost after database request");
    return new Response(null, { status: 204 });
  };
  const payload = { ...vip(), kind: "catering", consentEmail: false,
    eventDate: "2027-01-20", message: "Synthetic lost-response check" };
  assert.equal((await onRequestPost({ request: request(payload), env })).status, 503);
  assert.equal((await onRequestPost({ request: request(payload), env })).status, 200);
  assert.equal(databaseBodies.length, 2);
  assert.equal(databaseBodies[0], databaseBodies[1]);
});
