import assert from "node:assert/strict";
import test from "node:test";
import { parseDecisionReply } from "../workers/catering-decision-email/core.mjs";
import worker from "../workers/catering-decision-email/worker.mjs";

const decisionId = "b0e34c4c-3d6f-4c6d-a34f-10d160a9baab";
const token = "a1856067-159b-44d0-8faa-b038a95a6a11";
const base = {
  recipient: "crm-decisions@nazarrestaurantandbakery.com",
  envelopeFrom: "ctnazarbakery@gmail.com",
  headerFrom: "ctnazarbakery@gmail.com",
  subject: `Re: Nazar catering decision [NazarDecision:${decisionId}:${token}]`,
  messageId: "<gmail-message-123@example.com>",
  inReplyTo: "<nazar-request-122@example.com>",
  body: "Decision: Mixed Grill for 30 guests, $365.\nSigned: Yücel\n\nOn Tue, Oct 13, 2026 at 2:00 PM Talip wrote:\n> Decision: $1\n> Signed: Yücel",
};

test("imports the new reply and ignores the quoted request", () => {
  const result = parseDecisionReply(base);
  assert.equal(result?.p_decision_id, decisionId);
  assert.equal(result?.p_token, token);
  assert.equal(result?.p_answer, "Mixed Grill for 30 guests, $365.\n\nSigned: Yücel");
});

test("ignores the initial draft and a different sender", () => {
  assert.equal(parseDecisionReply({ ...base, envelopeFrom: "info@nazarrestaurantandbakery.com" }), null);
  assert.equal(parseDecisionReply({ ...base, headerFrom: "somebody@example.com" }), null);
  assert.equal(parseDecisionReply({ ...base, inReplyTo: undefined }), null);
});

test("requires the request marker, a signed decision, and the capture recipient", () => {
  assert.equal(parseDecisionReply({ ...base, subject: "Re: catering" }), null);
  assert.equal(parseDecisionReply({ ...base, body: "Looks good.\nSigned: Yücel" }), null);
  assert.equal(parseDecisionReply({ ...base, recipient: "info@nazarrestaurantandbakery.com" }), null);
});

test("the email worker sends only the new reply to the decision import function", async () => {
  const raw = [
    "From: Nazar <ctnazarbakery@gmail.com>",
    "To: crm-decisions@nazarrestaurantandbakery.com",
    `Subject: ${base.subject}`,
    `Message-ID: ${base.messageId}`,
    `In-Reply-To: ${base.inReplyTo}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "", base.body,
  ].join("\r\n");
  const previousFetch = globalThis.fetch;
  let payload;
  let forwardedTo;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.apikey, "sb_secret_test");
    assert.equal(options.headers.Authorization, undefined);
    payload = JSON.parse(options.body);
    return new Response("true", { status: 200 });
  };
  try {
    await worker.email({
      to: base.recipient, from: base.envelopeFrom, rawSize: raw.length,
      forward: async (address) => { forwardedTo = address; },
      raw: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(raw)); controller.close(); } }),
    }, { SUPABASE_SECRET_KEY: "sb_secret_test" });
    assert.equal(payload.p_decision_id, decisionId);
    assert.equal(payload.p_answer, "Mixed Grill for 30 guests, $365.\n\nSigned: Yücel");
    assert.equal(forwardedTo, "ctnazarbakery@gmail.com");
  } finally { globalThis.fetch = previousFetch; }
});
