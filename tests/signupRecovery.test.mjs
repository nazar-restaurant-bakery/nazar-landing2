import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearSignupDraft, readSignupDraft, requestIdForSignup,
  saveSignupDraft, SIGNUP_DRAFT_MAX_AGE_MS,
} from "../src/lib/signupRecovery.ts";

function storage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

test("an unfinished form survives reopening the browser and expires after one day", () => {
  const browser = storage();
  const fields = { email: "retry@example.invalid", eventDate: "2027-01-20", message: "Quote" };
  saveSignupDraft(browser, "catering", fields, 1000);
  assert.deepEqual(readSignupDraft(browser, "catering", 2000)?.fields, fields);
  assert.equal(readSignupDraft(browser, "catering", 1000 + SIGNUP_DRAFT_MAX_AGE_MS + 1), null);
  assert.equal(browser.getItem("catering"), null);
});

test("the same submission keeps its request ID after reload; an edit gets a new ID", () => {
  const tab = storage();
  const fields = { email: "retry@example.invalid", message: "Quote" };
  const firstId = "f6d45fb6-0b8c-4e67-8a22-62ae287a8b13";
  const secondId = "f6d45fb6-0b8c-4e67-8a22-62ae287a8b14";
  const ids = [firstId, secondId];
  saveSignupDraft(tab, "catering", fields);
  const first = requestIdForSignup(tab, "catering", fields, {}, () => ids.shift());
  assert.equal(first, firstId);

  // A new component instance reads the same tab's stored form and request ID.
  assert.deepEqual(readSignupDraft(tab, "catering")?.fields, fields);
  const retry = requestIdForSignup(tab, "catering", fields, {}, () => { throw new Error("new ID on retry"); });
  assert.equal(retry, firstId);

  const changed = { ...fields, message: "Revised quote" };
  saveSignupDraft(tab, "catering", changed);
  assert.equal(requestIdForSignup(tab, "catering", changed, {}, () => ids.shift()), secondId);
  clearSignupDraft(tab, "catering");
  assert.equal(readSignupDraft(tab, "catering"), null);
});

test("immediate retries keep an ID even when browser storage is unavailable", () => {
  const memory = {};
  const first = requestIdForSignup(null, "vip", { email: "retry@example.invalid" }, memory, () => "request-one");
  const retry = requestIdForSignup(null, "vip", { email: "retry@example.invalid" }, memory, () => "request-two");
  assert.equal(first, retry);
});
