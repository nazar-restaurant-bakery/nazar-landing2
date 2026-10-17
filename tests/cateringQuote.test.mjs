import assert from "node:assert/strict";
import test from "node:test";
import { dollarsToCents, customerQuoteMailto, customerQuoteMessage, loadQuoteOverview } from "../src/lib/cateringQuote.ts";

test("disabled quote workflow never contacts its undeployed RPC, including refreshes", async () => {
  let calls = 0;
  const fetch = () => { calls++; throw new Error("undeployed RPC"); };
  for (let i = 0; i < 3; i++) assert.equal(await loadQuoteOverview(false, fetch), null);
  assert.equal(calls, 0);
});

test("enabled quote workflow preserves real data and access-denial results", async () => {
  const success = { data: { items: [{ id: "synthetic-quote" }] }, error: null };
  assert.equal(await loadQuoteOverview(true, () => Promise.resolve(success)), success);
  const denied = { data: null, error: { code: "42501" } };
  assert.equal(await loadQuoteOverview(true, () => Promise.resolve(denied)), denied);
});

test("final quote amount accepts cents exactly and rejects ambiguous prices", () => {
  assert.equal(dollarsToCents("475"), 47500);
  assert.equal(dollarsToCents("475.05"), 47505);
  for (const invalid of ["", "0", "12.345", "$475", "1,000", "-4", "Infinity"]) {
    assert.equal(dollarsToCents(invalid), null, invalid);
  }
});

test("customer email contains the exact approved version and does not claim payment", () => {
  const quote = {
    id: "quote-1", request_id: "12345678-1234-1234-1234-123456789abc",
    version: 2, stage: "approved", menu: "Mixed Grill tray for 30",
    total_cents: 47500, pickup_terms: "October 20 at 2 PM",
    approved_at: "2026-10-13T12:00:00Z", sent_at: null,
  };
  const body = customerQuoteMessage("Nazar Test", quote);
  assert.match(body, /Mixed Grill tray for 30/);
  assert.match(body, /\$475\.00/);
  assert.match(body, /version 2/);
  assert.match(body, /order and payment are not completed/);
  const draft = customerQuoteMailto("test@example.com", quote, "Nazar Test");
  assert.match(draft, /^mailto:test%40example\.com\?/);
  assert.equal(new URL(draft).searchParams.get("body"), body);
});
