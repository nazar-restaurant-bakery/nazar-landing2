import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { productionAnalyticsHtml } from '../tools/build/productionAnalytics.ts';
import { resolveBrowserEnvironment, resolveServerEnvironment, PRODUCTION_SUPABASE_URL, PRODUCTION_BUSINESS_ID, TEST_TURNSTILE_SITE_KEY, TEST_TURNSTILE_SECRET_KEY } from '../src/lib/deploymentEnvironment.ts';
import { onRequestPost } from '../functions/api/signup.ts';
import { onRequest as middleware } from '../functions/api/_middleware.ts';
import { subscribeVipEmail } from '../src/lib/klaviyo.ts';
import { trackCloverOrderHandoffs, trackCateringRequestSubmitted } from '../src/lib/analytics.ts';

const host = 'synthetic-preview.example.pages.dev';
const target = 'https://abcdefghijklmnopqrst.supabase.co';
const business = '11111111-1111-4111-8111-111111111111';
const expectedHostname = 'example.com'; // Observed public dummy Siteverify response; never a production default.
const server = { APP_ENV:'isolated-test', TEST_SUPABASE_URL:target, TEST_BUSINESS_ID:business, TEST_SUPABASE_SECRET_KEY:'sb_secret_synthetic_test', TEST_TURNSTILE_SECRET_KEY, TEST_TURNSTILE_EXPECTED_HOSTNAME:expectedHostname };
const browser = { VITE_APP_ENV:'isolated-test', VITE_TEST_SUPABASE_URL:target, VITE_TEST_BUSINESS_ID:business, VITE_TEST_SUPABASE_ANON_KEY:'sb_publishable_synthetic_test', VITE_TEST_TURNSTILE_SITE_KEY:TEST_TURNSTILE_SITE_KEY };
const production = { VITE_SUPABASE_URL:PRODUCTION_SUPABASE_URL, VITE_SUPABASE_ANON_KEY:'sb_publishable_synthetic_production', VITE_NAZAR_BUSINESS_ID:PRODUCTION_BUSINESS_ID };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch=originalFetch; delete globalThis.window; delete globalThis.document; });
function request(overrides={}) { return new Request(`https://${host}/api/signup`, {method:'POST',headers:{Origin:`https://${host}`,'Content-Type':'application/json'},body:JSON.stringify({kind:'vip',name:'INTERNAL TEST',email:'synthetic@example.invalid',phone:'',consentEmail:true,turnstileToken:'XXXX.DUMMY.TOKEN.XXXX',extra:'',utm:null,requestId:'22222222-2222-4222-8222-222222222222',...overrides})}); }

test('production target guard remains exact and preview never falls back to it', () => {
  assert.equal(resolveBrowserEnvironment(production,'www.nazarrestaurantandbakery.com').configured,true);
  assert.equal(resolveBrowserEnvironment({...production,VITE_SUPABASE_URL:target},'www.nazarrestaurantandbakery.com').configured,false);
  assert.equal(resolveBrowserEnvironment(production,'nazar-restaurant-website.pages.dev').configured,true);
  for(const hostname of [host,'localhost']) {
    assert.equal(resolveBrowserEnvironment(production,hostname).configured,false);
    assert.equal(resolveServerEnvironment({SUPABASE_SECRET_KEY:'sb_secret_synthetic'},hostname).configured,false);
  }
});
test('explicit test config requires a different project and a configured valid business UUID', () => {
  assert.equal(resolveBrowserEnvironment(browser,host).url,target);
  assert.equal(resolveServerEnvironment(server,host).businessId,business);
  for(const fields of [{VITE_TEST_SUPABASE_URL:PRODUCTION_SUPABASE_URL},{VITE_TEST_BUSINESS_ID:'invalid-uuid'},{VITE_APP_ENV:undefined},{VITE_TEST_SUPABASE_URL:target+'/extra'},{VITE_TEST_SUPABASE_ANON_KEY:''}]) assert.equal(resolveBrowserEnvironment({...browser,...fields},host).configured,false);
  for(const fields of [{TEST_SUPABASE_URL:PRODUCTION_SUPABASE_URL},{TEST_BUSINESS_ID:'invalid-uuid'},{APP_ENV:undefined},{TEST_TURNSTILE_SECRET_KEY:'not-the-isolated-test-key'},{TEST_TURNSTILE_EXPECTED_HOSTNAME:undefined},{TEST_TURNSTILE_EXPECTED_HOSTNAME:'https://example.com/path'},{SUPABASE_SECRET_KEY:server.TEST_SUPABASE_SECRET_KEY}]) assert.equal(resolveServerEnvironment({...server,...fields},host).configured,false);
  // A separate database may retain the existing business UUID for legacy RPC
  // compatibility; project and credentials, not that UUID, provide isolation.
  assert.equal(resolveBrowserEnvironment({...browser,VITE_TEST_BUSINESS_ID:PRODUCTION_BUSINESS_ID},host).configured,true);
  assert.equal(resolveServerEnvironment({...server,TEST_BUSINESS_ID:PRODUCTION_BUSINESS_ID},host).configured,true);
});
test('documented test Turnstile keys cannot enable a production form',()=>{
  assert.equal(resolveBrowserEnvironment({...production,VITE_TURNSTILE_SITE_KEY:TEST_TURNSTILE_SITE_KEY},'www.nazarrestaurantandbakery.com').turnstileSiteKey,undefined);
  assert.equal(resolveServerEnvironment({SUPABASE_SECRET_KEY:'sb_secret_synthetic_production',TURNSTILE_SECRET_KEY:TEST_TURNSTILE_SECRET_KEY},'www.nazarrestaurantandbakery.com').configured,false);
  assert.equal(resolveServerEnvironment({...server,APP_ENV:'isolated_test'},'www.nazarrestaurantandbakery.com').configured,false);
});
test('misconfigured preview rejects signup before any outbound request', async () => {
  let calls=0; globalThis.fetch=async()=>{calls++;throw Error('Unexpected outbound request');};
  for(const env of [{},{SUPABASE_SECRET_KEY:'sb_secret_synthetic_production',TURNSTILE_SECRET_KEY:'synthetic'}, {...server,TEST_SUPABASE_URL:PRODUCTION_SUPABASE_URL},{...server,TEST_TURNSTILE_EXPECTED_HOSTNAME:undefined}]) assert.equal((await onRequestPost({request:request(),env})).status,503);
  assert.equal(calls,0);
});
test('preview accepts the observed example.com dummy hostname only with explicit expected-host setting, then writes only test project', async () => {
  const calls=[],pending=[];
  globalThis.fetch=async(url,options)=>{calls.push({url:String(url),body:JSON.parse(options.body),headers:options.headers});return calls.length===1?Response.json({success:true,hostname:expectedHostname}):new Response(null,{status:204});};
  const env={...server,SUPABASE_SECRET_KEY:'sb_secret_synthetic_production',CLOUDFLARE_EMAIL_SEND_TOKEN:'synthetic-should-never-be-used',FORM_ERROR_ALERTS_ENABLED:'true'};
  assert.equal((await onRequestPost({request:request({kind:'catering',consentEmail:false,eventDate:'2027-02-01',guests:'10',message:'Synthetic only',p_business_id:PRODUCTION_BUSINESS_ID}),env,waitUntil:p=>pending.push(p)})).status,200);
  assert.equal(calls.length,2);assert.equal(calls[0].body.secret,TEST_TURNSTILE_SECRET_KEY);
  assert.equal(calls[1].url,target+'/rest/v1/rpc/submit_signup_once');assert.equal(calls[1].body.p_business_id,business);
  assert.equal(calls[1].headers.apikey,server.TEST_SUPABASE_SECRET_KEY);assert.equal(pending.length,0);
});
test('test mode still rejects failed challenge or wrong verification hostname', async()=>{
  for(const verification of [{success:false},{success:true,hostname:'wrong.example.invalid'}]) {
    let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(verification);};
    assert.equal((await onRequestPost({request:request(),env:server})).status,403);assert.equal(calls,1);
  }
});
test('preview database failure never invokes production error logging or email alerts',async()=>{
  const calls=[],pending=[];globalThis.fetch=async(url)=>{calls.push(String(url));return calls.length===1?Response.json({success:true,hostname:expectedHostname}):Response.json({code:'synthetic_failure'},{status:503});};
  assert.equal((await onRequestPost({request:request(),env:server,waitUntil:p=>pending.push(p)})).status,503);
  await Promise.all(pending);assert.equal(calls.length,2);assert.ok(calls.every(url=>!url.includes(new URL(PRODUCTION_SUPABASE_URL).hostname)));
});
test('all existing staff provider routes fail closed in preview while production middleware passes through',async()=>{
  let next=0;
  for(const route of ['clover-orders','klaviyo-status','decision-email-draft','form-error-setup-test']) assert.equal((await middleware({request:new Request(`https://${host}/api/staff/${route}`),env:{},next:async()=>{next++;return new Response();}})).status,503);
  assert.equal(next,0);
  assert.equal((await middleware({request:new Request('https://www.nazarrestaurantandbakery.com/api/staff/clover-orders'),env:{},next:async()=>{next++;return new Response();}})).status,200);assert.equal(next,1);
});
test('preview browser never invokes public Klaviyo writer or emits analytics events',async()=>{
  globalThis.window={location:{hostname:host},gtag:()=>{throw Error('Analytics forbidden');}};
  globalThis.document={addEventListener:()=>{throw Error('No tracking listener in preview');}};
  globalThis.fetch=async()=>{throw Error('Provider forbidden');};
  assert.equal(await subscribeVipEmail({email:'synthetic@customer.example',name:'Synthetic',campaign:null}),false);
  assert.doesNotThrow(()=>{trackCloverOrderHandoffs();trackCateringRequestSubmitted('synthetic-id');});
});
test('build-time isolation removes production GA4 while Production keeps its original static loader',()=>{
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const transform=(env)=>productionAnalyticsHtml({command:'build',mode:'production',env}).transformIndexHtml.handler(html);
  assert.equal(transform({}),html);
  assert.match(html,/<script async src="https:\/\/www\.googletagmanager/);
  assert.doesNotMatch(transform({VITE_APP_ENV:'isolated-test'}),/googletagmanager|G-LK46HFY46G/);
  assert.doesNotMatch(transform({CF_PAGES_BRANCH:'feat/isolated-test-env'}),/googletagmanager|G-LK46HFY46G/);
});

test('printed QR VIP payload retains allowlisted tags on signup RPC without outbound subscription',async()=>{
 const calls=[],pending=[];globalThis.fetch=async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init.body)});return calls.length===1?Response.json({success:true,hostname:expectedHostname}):new Response(null,{status:204});};
 const utm={utm_source:'qr',utm_medium:'offline',utm_campaign:'qr_paket',landing_page:'/vip'};
 assert.equal((await onRequestPost({request:request({utm:{...utm,untrusted:'discard'}}),env:server,waitUntil:p=>pending.push(p)})).status,200);await Promise.all(pending);
 assert.equal(calls.length,2);assert.equal(calls[1].url,target+'/rest/v1/rpc/submit_signup_once');assert.deepEqual(calls[1].body.p_utm,utm);assert.equal(calls[1].body.p_source,'website_vip_page');
});
