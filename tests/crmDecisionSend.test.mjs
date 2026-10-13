import assert from "node:assert/strict";
import test from "node:test";
import { onRequestPost } from "../functions/api/staff/decision-email-draft.ts";

const decisionId = "b0e34c4c-3d6f-4c6d-a34f-10d160a9baab";
const token = "a1856067-159b-44d0-8faa-b038a95a6a11";
const origin = "https://www.nazarrestaurantandbakery.com";
const env = { VITE_SUPABASE_ANON_KEY: "anon_test", CLOUDFLARE_EMAIL_SEND_TOKEN: "cf_test" };

function request(send) {
  return new Request(`${origin}/api/staff/decision-email-draft`, {
    method: "POST",
    headers: { Origin: origin, Authorization: `Bearer ${"a".repeat(30)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ decisionId, send }),
  });
}

test("preview sends no email; explicit send uses info@ and the verified destination", async () => {
  const previousFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/rpc/crm_staff_authorized_v1")) return Response.json(true);
    if (url.endsWith("/rpc/crm_catering_decisions_v1")) return Response.json({ items: [{ id: decisionId, request_id: decisionId, question: "Mixed Grill price?", recorded_at: null }] });
    if (url.endsWith("/rpc/crm_decision_email_token_v1")) return Response.json(token);
    if (url.includes("/email/sending/send")) {
      outbound.push({ authorization: options.headers.Authorization, body: JSON.parse(options.body) });
      return Response.json({ success: true, result: { delivered: ["ctnazarbakery@gmail.com"] } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  try {
    const preview = await onRequestPost({ request: request(false), env });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json()).from, "info@nazarrestaurantandbakery.com");
    assert.equal(outbound.length, 0);
    const sent = await onRequestPost({ request: request(true), env });
    assert.equal(sent.status, 200);
    assert.equal(outbound.length, 1);
    assert.equal(outbound[0].authorization, "Bearer cf_test");
    assert.equal(outbound[0].body.to, "ctnazarbakery@gmail.com");
    assert.equal(outbound[0].body.replyTo, "crm-decisions@nazarrestaurantandbakery.com");
  } finally { globalThis.fetch = previousFetch; }
});
