import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { onRequestPost } from "../functions/api/staff/klaviyo-status.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const env = {
  VITE_SUPABASE_ANON_KEY: "sb_publishable_test",
  KLAVIYO_CRM_READ_KEY: "pk_test_read_only",
};
const token = `Bearer ${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`;
function request(email = "guest@example.com") {
  return new Request("https://www.nazarrestaurantandbakery.com/api/staff/klaviyo-status", {
    method: "POST", headers: { Origin: "https://www.nazarrestaurantandbakery.com",
      Authorization: token, "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

test("unlisted staff never reaches Klaviyo", async () => {
  const urls = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return Response.json(false); };
  const result = await onRequestPost({ request: request(), env });
  assert.equal(result.status, 403);
  assert.equal(urls.length, 1);
  assert.match(urls[0], /crm_staff_authorized_v1/);
});

test("authorized staff gets a confirmed status only from Klaviyo consent", async () => {
  const urls = [];
  globalThis.fetch = async (url, options) => {
    urls.push(String(url));
    if (urls.length === 1) {
      assert.equal(options.headers.Authorization, token);
      return Response.json(true);
    }
    assert.match(String(url), /lists\/UeJynm\/profiles/);
    assert.match(String(url), /additional-fields%5Bprofile%5D=subscriptions/);
    assert.match(options.headers.Authorization, /^Klaviyo-API-Key /);
    return Response.json({ data: [{ attributes: { subscriptions: { email: {
      marketing: { consent: "SUBSCRIBED", suppression: [], list_suppressions: [], can_receive_email_marketing: true },
    } } } }] });
  };
  const result = await onRequestPost({ request: request(), env });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).status, "confirmed");
  assert.equal(result.headers.get("Cache-Control"), "private, no-store");
});

test("a suppressed profile is not marked confirmed", async () => {
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? Response.json(true) : Response.json({
    data: [{ attributes: { subscriptions: { email: { marketing: {
      consent: "SUBSCRIBED", suppression: [{ reason: "USER_SUPPRESSED" }],
    } } } } }],
  });
  const result = await onRequestPost({ request: request(), env });
  assert.equal((await result.json()).status, "suppressed");
});

test("cross-origin request is rejected before any network call", async () => {
  globalThis.fetch = async () => { throw new Error("should not fetch"); };
  const invalid = new Request("https://www.nazarrestaurantandbakery.com/api/staff/klaviyo-status", {
    method: "POST", headers: { Origin: "https://not-nazar.example", Authorization: token,
      "Content-Type": "application/json" }, body: JSON.stringify({ email: "guest@example.com" }),
  });
  assert.equal((await onRequestPost({ request: invalid, env })).status, 403);
});
