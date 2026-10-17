import assert from "node:assert/strict";
import { test } from "node:test";
import { captureUtm, getUtm, getUtmOrNull } from "../src/lib/utm.ts";

function browser(t, initial) {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const data = new Map(initial ? [["nazar_utm", initial]] : []);
  const window = { location: { search: "", pathname: "/menu" }, sessionStorage: {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
  } };
  const document = { referrer: "" };
  Object.defineProperty(globalThis, "window", { value: window, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", { value: document, configurable: true, writable: true });
  t.after(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete globalThis.window;
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument); else delete globalThis.document;
  });
  return { window, document, data };
}

test("first tagged visit records bounded values and its landing context", t => {
  const b = browser(t);
  b.window.location.search = "?utm_source=%20qr%20&utm_campaign=" + "x".repeat(250) + "&ignored=value";
  b.document.referrer = "https://referrer.invalid/" + "x".repeat(250);
  captureUtm();
  assert.deepEqual(getUtm(), { utm_source: "qr", utm_campaign: "x".repeat(200), landing_page: "/menu", referrer: b.document.referrer.slice(0, 200) });
});

test("a new partial campaign replaces the old campaign and click IDs as one context", t => {
  const b = browser(t, JSON.stringify({ utm_source: "google", utm_medium: "cpc", utm_campaign: "old", utm_term: "old term", utm_content: "old ad", gclid: "old-click", fbclid: "old-fb", ttclid: "old-tt", landing_page: "/catering", referrer: "https://old.invalid" }));
  b.window.location.search = "?utm_source=qr";
  b.window.location.pathname = "/vip";
  captureUtm();
  assert.deepEqual(getUtm(), { utm_source: "qr", landing_page: "/vip" });
});

test("a new click ID cannot inherit the previous campaign's UTM fields", t => {
  const b = browser(t, JSON.stringify({ utm_source: "qr", utm_campaign: "old", fbclid: "old-fb", landing_page: "/vip" }));
  b.window.location.search = "?gclid=new-click";
  b.window.location.pathname = "/catering";
  captureUtm();
  assert.deepEqual(getUtm(), { gclid: "new-click", landing_page: "/catering" });
});

test("a tag-only link retains only the fields actually supplied by that visit", t => {
  const b = browser(t, JSON.stringify({ utm_source: "old-source", utm_campaign: "old-campaign", landing_page: "/old" }));
  b.window.location.search = "?utm_content=new-content";
  captureUtm();
  assert.deepEqual(getUtm(), { utm_content: "new-content", landing_page: "/menu" });
});

test("untagged navigation preserves the captured campaign for the signup form", t => {
  const b = browser(t);
  b.window.location.search = "?utm_source=qr&utm_campaign=cards";
  captureUtm();
  const captured = getUtm();
  b.window.location.search = "";
  b.window.location.pathname = "/vip";
  captureUtm();
  assert.deepEqual(getUtmOrNull(), captured);
});

test("empty and unrelated query values do not erase a previous campaign", t => {
  const initial = { utm_source: "qr", landing_page: "/menu" };
  const b = browser(t, JSON.stringify(initial));
  b.window.location.search = "?utm_source=%20%20&utm_campaign=&unrelated=new";
  captureUtm();
  assert.deepEqual(getUtm(), initial);
});

test("a fresh campaign replaces corrupt saved state", t => {
  const b = browser(t, "not json");
  b.window.location.search = "?utm_source=google&utm_medium=cpc";
  captureUtm();
  assert.deepEqual(getUtm(), { utm_source: "google", utm_medium: "cpc", landing_page: "/menu" });
});

test("blocked session storage does not break the page or form", t => {
  const b = browser(t);
  b.window.location.search = "?utm_source=qr";
  b.window.sessionStorage.getItem = () => { throw new Error("blocked"); };
  b.window.sessionStorage.setItem = () => { throw new Error("blocked"); };
  assert.doesNotThrow(captureUtm);
  assert.equal(getUtmOrNull(), null);
});

test("a direct visit with no attribution stays unattributed", t => {
  browser(t);
  captureUtm();
  assert.equal(getUtmOrNull(), null);
});
