import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { subscribeVipEmail } from "../src/lib/klaviyo.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("VIP signup requests email double opt-in on the dedicated list", async () => {
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = { url, options };
    return new Response(null, { status: 202 });
  };
  assert.equal(await subscribeVipEmail({
    email: "customer@customer-mail.com",
    name: "Test Guest",
    campaign: "onscene_20261013",
  }), true);
  assert.equal(sent.url, "https://a.klaviyo.com/client/subscriptions/?company_id=W6Kr7z");
  assert.equal(sent.options.headers.revision, "2026-07-15");
  const data = JSON.parse(sent.options.body).data;
  assert.equal(data.attributes.profile.data.attributes.email, "customer@customer-mail.com");
  assert.deepEqual(data.attributes.profile.data.attributes.subscriptions, {
    email: { marketing: { consent: "SUBSCRIBED" } },
  });
  assert.equal(data.relationships.list.data.id, "UeJynm");
  assert.match(data.attributes.custom_source, /onscene_20261013/);
  assert.equal(data.attributes.profile.data.attributes.phone_number, undefined);
  assert.equal(data.attributes.profile.data.attributes.subscriptions.sms, undefined);
});

test("Klaviyo rejection is reported so the visitor can retry", async () => {
  globalThis.fetch = async () => new Response(null, { status: 429 });
  assert.equal(await subscribeVipEmail({
    email: "customer@customer-mail.com", name: "", campaign: null,
  }), false);
});

test("explicit tests never contact Klaviyo, even when consent was checked", async () => {
 let calls=0; globalThis.fetch=async()=>{calls++;return new Response(null,{status:202})};
 for(const value of [
  {email:'a@example.com',name:'Guest'}, {email:'a@sub.invalid',name:'Guest'},
  {email:'a@customer-mail.com',name:'INTERNAL TEST live check'}
 ]) assert.equal(await subscribeVipEmail({...value,campaign:null}),false);
 assert.equal(calls,0);
});
