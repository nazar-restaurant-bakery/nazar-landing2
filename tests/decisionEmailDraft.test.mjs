import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { onRequestPost } from "../functions/api/staff/decision-email-draft.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const env = { VITE_SUPABASE_ANON_KEY: "sb_publishable_test" };
const token = `Bearer ${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`;
const decisionId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
function request(origin = "https://www.nazarrestaurantandbakery.com") {
  return new Request("https://www.nazarrestaurantandbakery.com/api/staff/decision-email-draft", {
    method: "POST", headers: { Origin: origin, Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ decisionId }),
  });
}

test("unauthorized staff cannot retrieve routing addresses or decision text", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json(false); };
  const response = await onRequestPost({ request: request(), env });
  assert.equal(response.status, 403);
  assert.equal(calls, 1);
  assert.equal((await response.json()).to, undefined);
});

test("authorized staff gets a draft for an existing pending decision", async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return urls.length === 1 ? Response.json(true) : Response.json({ items: [
      { id: decisionId, request_id: requestId, question: "Confirm menu and price", recorded_at: null },
    ] });
  };
  const response = await onRequestPost({ request: request(), env });
  assert.equal(response.status, 200);
  const draft = await response.json();
  assert.equal(draft.to, "ctnazarbakery@gmail.com");
  assert.equal(draft.cc, "talipbalik@gmail.com");
  assert.match(draft.body, /Confirm menu and price/);
  assert.match(draft.body, /reply all/);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.match(urls[0], /crm_staff_authorized_v1/);
  assert.match(urls[1], /crm_catering_decisions_v1/);
});

test("completed decisions and cross-origin calls produce no draft", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1 ? Response.json(true) : Response.json({ items: [
      { id: decisionId, request_id: requestId, question: "private", recorded_at: "2026-10-13T00:00:00Z" },
    ] });
  };
  assert.equal((await onRequestPost({ request: request(), env })).status, 404);
  assert.equal((await onRequestPost({ request: request("https://other.example"), env })).status, 403);
  assert.equal(calls, 2);
});
