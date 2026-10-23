import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyCloverWebhookSignature } from "../functions/_lib/cloverWebhookSignature.ts";

async function signature(body, secret, time) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${time}.${body}`)));
  return `t=${time},v1=${Buffer.from(bytes).toString("hex")}`;
}

test("accepts a fresh Clover-signed body and rejects alterations", async () => {
  const time = 1_800_000_000;
  const body = JSON.stringify({ type: "PAYMENT", status: "APPROVED" });
  const header = await signature(body, "test-secret", time);
  assert.equal(await verifyCloverWebhookSignature(body, header, "test-secret", time), true);
  assert.equal(await verifyCloverWebhookSignature(body + " ", header, "test-secret", time), false);
  assert.equal(await verifyCloverWebhookSignature(body, header, "wrong-secret", time), false);
  assert.equal(await verifyCloverWebhookSignature(body, header, "test-secret", time + 301), false);
  assert.equal(await verifyCloverWebhookSignature(body, null, "test-secret", time), false);
});
