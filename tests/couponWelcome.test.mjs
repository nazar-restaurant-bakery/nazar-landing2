import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmCouponVip, processCouponWelcome, liveCouponProvider, couponConfig, couponStore,
  handleCouponProcessRequest, COUPON_WELCOME_METRIC } from '../functions/_lib/couponWelcome.ts';
const NOW = Date.parse('2026-10-20T23:00:00Z');
const B = '10000000-0000-4000-8000-000000000001', C = '20000000-0000-4000-8000-000000000001';
const S = '30000000-0000-4000-8000-000000000001', Q = '40000000-0000-4000-8000-000000000001';
const J = '50000000-0000-4000-8000-000000000001', L = '60000000-0000-4000-8000-000000000001';
const R = '70000000-0000-4000-8000-000000000001', G = '80000000-0000-4000-8000-000000000001';
const E = '90000000-0000-4000-8000-000000000001', A = 'a0000000-0000-4000-8000-000000000001';
const EMAIL = 'synthetic-customer@example.invalid';
const MARKETING = { consent:'SUBSCRIBED', can_receive_email_marketing:true, double_optin:true,
  consent_timestamp:'2026-10-20T22:00:00Z', suppression:[], list_suppressions:[] };
const makeProfile = (patch = {}) => ({id:'PROFILE_ONE',attributes:{email:EMAIL,subscriptions:{email:{marketing:{...MARKETING,...patch}}}}});
const makeJob = () => ({allowed:true,code:'claimed',jobId:J,jobLeaseId:L,couponId:Q,businessId:B,customerId:C,
  messageKey:`coupon-welcome:${Q}`,eventUniqueId:E,recipient:EMAIL,properties:{
    coupon_code:'2345-6789-ABCD-EFGH',coupon_qr_payload:'VIPCOUPON1:2345-6789-ABCD-EFGH',coupon_qr_token:'a'.repeat(32),
    campaign_id:A,coupon_id:Q,minimum_amount_cents:3000,channels:['dine_in','site_pickup','site_delivery'],expires_at:null,message_key:`coupon-welcome:${Q}`}});
function harness(opts={}) {
  const h={calls:[],events:[],finishes:[],reserved:null,outbox:'queued'};
  const store={async rpc(name,args){
    h.calls.push([name,structuredClone(args)]);
    if(opts.rpc) { const override=await opts.rpc(name,args,h); if(override!==undefined) return override; }
    switch(name) {
      case 'coupon_confirmation_context_v1':return {allowed:true,businessId:B,customerId:C,signupId:S,email:EMAIL,vipListId:'VIP_LIST',requestedAt:'2026-10-20T21:00:00Z',isTest:false,...opts.confirmContext};
      case 'coupon_record_confirmed_vip_v1':return {confirmed:true};
      case 'coupon_record_negative_v1':return {blocked:true};
      case 'coupon_welcome_claim_v1':if(h.outbox!=='queued')return {allowed:false,code:'already_processed'};h.outbox='claimed';return {...makeJob(),...opts.job};
      case 'coupon_welcome_context_v1':return {...makeJob(),...opts.fresh};
      case 'message_send_reserve_v1':h.reserved=structuredClone(args);return {allowed:true,code:'reserved',status:'reserved',reservationId:R};
      case 'message_send_claim_v1':return {allowed:true,code:'claimed',status:'claimed',reservationId:R,leaseId:G,dispatchExpiresAt:new Date(NOW+120000).toISOString()};
      case 'message_send_context_v1':return {allowed:true,code:'dispatch_authorized',status:'sending',reservationId:R,context:{businessId:B,customerId:C,messageKey:h.reserved.p_message_key,messageKind:'flow',payloadSha256:h.reserved.p_payload_sha256,leaseId:G,dispatchExpiresAt:new Date(NOW+120000).toISOString(),email:EMAIL,emailStatus:'subscribed',isTest:false,suppressedAt:null,providerBlockedStatus:null,...opts.gateContext}};
      case 'message_send_finalize_v1':h.finishes.push(args.p_outcome);return {status:args.p_outcome,idempotent:false};
      case 'coupon_welcome_finish_v1':h.outbox=args.p_outcome;return {acknowledged:true,status:args.p_outcome};
      default:assert.fail(name);
    }
  }};
  const provider={mode:'mock',async get(path,query){h.calls.push(['GET',path]);
    if(opts.get) {const x=await opts.get(path,query);if(x!==undefined)return x;}
    if(path==='/accounts')return {data:[{id:'ACCOUNT_ONE'}]};
    if(path==='/lists/VIP_LIST')return {data:{id:'VIP_LIST',attributes:{opt_in_process:'double_opt_in'}}};
    return {data:[makeProfile(opts.marketing)]};
  },async eventAccount(){h.calls.push(['EVENT_ACCOUNT']);return {data:[{id:opts.eventAccount||'ACCOUNT_ONE'}]};},
  async event(body,signal){h.calls.push(['EVENT']);h.events.push(structuredClone(body));assert.ok(signal instanceof AbortSignal);return opts.event ? opts.event(body,signal) : {status:202};}};
  h.confirm=extra=>confirmCouponVip({store,provider,businessId:B,customerId:C,signupId:S,accountId:'ACCOUNT_ONE',now:()=>NOW,...extra});
  h.welcome=extra=>processCouponWelcome({store,provider,businessId:B,accountId:'ACCOUNT_ONE',qrOrigin:'https://owned.invalid',now:()=>NOW,...extra});
  return Object.assign(h,{store,provider});
}
test('dated exact-list double opt-in writes trusted hashed evidence, never provider consent',async()=>{
  const h=harness();assert.deepEqual(await h.confirm(),{status:'confirmed',code:'confirmation_recorded',synthetic:true,activationReady:false});
  const saved=h.calls.find(c=>c[0]==='coupon_record_confirmed_vip_v1')[1];
  assert.equal(saved.p_provider_profile_id,'PROFILE_ONE');assert.equal(saved.p_confirmed_at,MARKETING.consent_timestamp);
  assert.match(saved.p_evidence.emailSha256,/^[a-f0-9]{64}$/);assert.equal(saved.p_evidence.doubleOptIn,true);
  assert.equal(JSON.stringify(saved.p_evidence).includes(EMAIL),false);assert.equal(h.events.length,0);
  assert.deepEqual(h.calls.filter(c=>c[0]==='GET').map(c=>c[1]),['/accounts','/lists/VIP_LIST','/profiles','/lists/VIP_LIST/profiles']);
});
for(const [name,options] of [
  ['checkbox/local test',{confirmContext:{isTest:true}}],['wrong business',{confirmContext:{businessId:C}}],
  ['future signup',{confirmContext:{requestedAt:'2026-10-21T21:00:00Z'}}],
  ['not subscribed',{marketing:{consent:'NEVER_SUBSCRIBED'}}],['unsubscribed',{marketing:{consent:'UNSUBSCRIBED'}}],
  ['missing double opt-in',{marketing:{double_optin:null}}],['string double opt-in',{marketing:{double_optin:'true'}}],
  ['false double opt-in',{marketing:{double_optin:false}}],['suppressed',{marketing:{suppression:[{reason:'user_suppressed'}]}}],
  ['VIP list suppression',{marketing:{list_suppressions:[{list_id:'VIP_LIST'}]}}],
  ['stale consent',{marketing:{consent_timestamp:'2026-10-19T22:00:00Z'}}],['missing consent date',{marketing:{consent_timestamp:null}}],
  ['future consent',{marketing:{consent_timestamp:'2026-10-21T22:00:00Z'}}],
]) test(`confirmation rejects ${name}`,async()=>{const h=harness(options);assert.notEqual((await h.confirm()).status,'confirmed');assert.equal(h.calls.some(c=>c[0]==='coupon_record_confirmed_vip_v1'),false);});
for(const [name,path,body] of [
  ['wrong account','/accounts',{data:[{id:'OTHER_ACCOUNT'}]}],
  ['single opt-in list','/lists/VIP_LIST',{data:{id:'VIP_LIST',attributes:{opt_in_process:'single_opt_in'}}}],
  ['ambiguous profile','/profiles',{data:[makeProfile(),makeProfile()]}],
  ['missing list member','/lists/VIP_LIST/profiles',{data:[]}],
  ['mismatched list identity','/lists/VIP_LIST/profiles',{data:[{...makeProfile(),id:'OTHER_PROFILE'}]}],
]) test(`confirmation rejects ${name}`,async()=>{const h=harness({get:p=>p===path?body:undefined});assert.notEqual((await h.confirm()).status,'confirmed');assert.equal(h.calls.some(c=>c[0]==='coupon_record_confirmed_vip_v1'),false);});
test('202 is provider accepted, K6 unknown and activation remains blocked; no re-dispatch',async()=>{
  const h=harness();const r=await h.welcome();assert.equal(r.status,'provider_accepted');assert.equal(r.activationReady,false);
  assert.equal(r.code,'pending_delivery_receipt_reconciliation');assert.deepEqual(h.finishes,['unknown']);assert.equal(h.outbox,'provider_accepted');
  const event=h.events[0].data.attributes;assert.equal(event.unique_id,E);assert.equal(event.metric.data.attributes.name,COUPON_WELCOME_METRIC);
  assert.match(event.properties.coupon_qr_image_url,/^https:\/\/owned.invalid\/api\/coupon-qr\/[a-f0-9]{32}\.gif$/);
  assert.equal(event.properties.coupon_qr_image_url.includes('2345'),false);assert.equal(event.properties.coupon_qr_token,undefined);
  assert.equal(event.profile.data.attributes.subscriptions,undefined);assert.deepEqual(Object.keys(event.profile.data.attributes),['email']);
  assert.equal(event.properties.customer_id,undefined);assert.equal(JSON.stringify(r).includes(EMAIL),false);assert.equal(JSON.stringify(r).includes('2345'),false);
  const order=h.calls.map(c=>c[0]);assert.ok(order.indexOf('message_send_context_v1')<order.indexOf('EVENT'));
  assert.equal(order[order.indexOf('EVENT')-1],'message_send_context_v1');
  await h.welcome();assert.equal(h.events.length,1);
});
for(const [name,options] of [
  ['167-hour frequency denial',{rpc:n=>n==='message_send_reserve_v1'?{allowed:false,code:'frequency_limited'}:undefined}],
  ['settings disabled',{rpc:n=>n==='message_send_reserve_v1'?{allowed:false,code:'settings_disabled'}:undefined}],
  ['local late unsubscribe',{gateContext:{emailStatus:'unsubscribed'}}],['late suppression',{gateContext:{suppressedAt:'2026-10-20T23:00:00Z'}}],
  ['identity changed',{gateContext:{email:'another@example.invalid'}}],['test person',{gateContext:{isTest:true}}],
  ['wrong payload',{gateContext:{payloadSha256:'f'.repeat(64)}}],['wrong lease',{gateContext:{leaseId:L}}],
  ['outbox lease changed',{fresh:{jobLeaseId:G}}],['outbox job changed',{fresh:{jobId:R}}],
  ['event key wrong account',{eventAccount:'OTHER_ACCOUNT'}],['provider unsubscribed',{marketing:{consent:'UNSUBSCRIBED'}}],
]) test(`welcome never posts on ${name}`,async()=>{const h=harness(options);assert.notEqual((await h.welcome()).status,'provider_accepted');assert.equal(h.events.length,0);assert.equal(h.finishes.includes('sent'),false);});
test('provider negative is recorded locally and wins before event authorization',async()=>{
  const h=harness({marketing:{consent:'UNSUBSCRIBED'}});await h.welcome();assert.equal(h.calls.some(c=>c[0]==='coupon_record_negative_v1'),true);assert.equal(h.events.length,0);
});
for(const [name,event] of [['lost acknowledgement',async()=>{throw Error('network secret recipient');}],['non202',async()=>({status:500})],['timeout',async()=>new Promise(()=>{})]])
  test(`welcome ${name} is unknown and never automatically resent`,async()=>{const h=harness({event});const r=await h.welcome({timeoutMs:10});assert.equal(r.status,'unknown');assert.deepEqual(h.finishes,['unknown']);await h.welcome();assert.equal(h.events.length,1);assert.equal(JSON.stringify(r).includes('network secret'),false);});
test('finalization acknowledgement loss is unknown; no contradictory outcome or retry',async()=>{
  const h=harness({rpc:n=>{if(n==='message_send_finalize_v1')throw Error('ack lost');}});assert.equal((await h.welcome()).code,'gate_finalize_unconfirmed');await h.welcome();assert.equal(h.events.length,1);
});
test('one of concurrent synthetic claims dispatches once (native DB races tested separately)',async()=>{const h=harness();await Promise.all([h.welcome(),h.welcome()]);assert.equal(h.events.length,1);});
test('HTTP entry is machine-only, exact command-shaped, no browser Origin or arbitrary business',async()=>{
  const expiry=new Date(Date.now()+120000).toISOString();
  const h=harness({rpc:n=>n==='message_send_claim_v1'?{allowed:true,code:'claimed',status:'claimed',reservationId:R,leaseId:G,dispatchExpiresAt:expiry}:undefined,gateContext:{dispatchExpiresAt:expiry}});const config={mode:'mock',processKey:'x'.repeat(40),businessId:B,accountId:'ACCOUNT_ONE',qrOrigin:'https://owned.invalid'};
  const req=(patch={},headers={})=>new Request('https://owned.invalid/api/internal/coupon-welcome',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.processKey}`,...headers},body:JSON.stringify({action:'welcome',businessId:B,couponId:Q,...patch})});
  assert.equal((await handleCouponProcessRequest(req(),{...config,mode:'disabled'},h)).status,503);
  assert.equal((await handleCouponProcessRequest(req({}, {Origin:'https://owned.invalid'}),config,h)).status,403);
  assert.equal((await handleCouponProcessRequest(req({businessId:C}),config,h)).status,403);
  assert.equal((await handleCouponProcessRequest(req({email:EMAIL}),config,h)).status,400);
  assert.equal((await handleCouponProcessRequest(req(),config,h)).status,200);
});
test('production runtime is disabled unless all explicit approval and distinct narrow keys are set',()=>{
  assert.equal(couponConfig({},'www.nazarrestaurantandbakery.com').mode,'disabled');
  const env={SUPABASE_SECRET_KEY:'sb_secret_test',COUPON_PROCESS_MODE:'live',COUPON_PROCESS_ENABLED:'true',COUPON_PROCESS_KEY:'x'.repeat(40),COUPON_KLAVIYO_ACCOUNT_ID:'ACCOUNT_ONE',COUPON_KLAVIYO_READ_KEY:'pk_read_1234567890',COUPON_KLAVIYO_EVENT_KEY:'pk_event_1234567890',COUPON_QR_ORIGIN:'https://owned.invalid',COUPON_LIVE_APPROVAL_ID:'talip:approved:future'};
  assert.equal(couponConfig(env,'www.nazarrestaurantandbakery.com').mode,'live');
  assert.equal(couponConfig({...env,COUPON_LIVE_APPROVAL_ID:''},'www.nazarrestaurantandbakery.com').mode,'disabled');
  assert.equal(couponConfig({...env,COUPON_KLAVIYO_EVENT_KEY:env.COUPON_KLAVIYO_READ_KEY},'www.nazarrestaurantandbakery.com').mode,'disabled');
  assert.equal(couponConfig(env,'branch.nazar-restaurant-website.pages.dev').mode,'disabled');
});
test('live transport only sends event and readonly identity calls; blocks arbitrary paths before network',async()=>{
  const calls=[];const config={mode:'live',approvalId:'future:approved',readKey:'pk_read',eventKey:'pk_event'};
  const p=liveCouponProvider(config,async(url,options)=>{calls.push([url,options]);return Response.json({data:[{id:'ACCOUNT_ONE'}]});});
  for(const path of ['/profile-import','/profile-subscription-bulk-create-jobs','/lists/VIP_LIST/relationships/profiles','/profiles/../accounts','https://evil.invalid'])await assert.rejects(p.get(path));
  await p.get('/accounts');await p.eventAccount();assert.equal(calls.length,2);
  assert.equal(calls[0][1].headers.Authorization,'Klaviyo-API-Key pk_read');assert.equal(calls[1][1].headers.Authorization,'Klaviyo-API-Key pk_event');
  assert.equal(calls.every(c=>c[1].method==='GET'&&c[1].redirect==='manual'),true);
  assert.equal(calls.every(c=>new URL(c[0]).pathname.endsWith('/')),true);
  await assert.rejects(p.event({data:{type:'profile'}},new AbortController().signal));assert.equal(calls.length,2);
  const h=harness();await h.welcome();await p.event(h.events[0],new AbortController().signal);
  assert.equal(calls.length,3);assert.equal(calls[2][0],'https://a.klaviyo.com/api/events/');assert.equal(calls[2][1].method,'POST');
  assert.equal(calls[2][1].headers.Authorization,'Klaviyo-API-Key pk_event');
});
test('RPC runtime disallows arbitrary calls and never forwards service key to provider',async()=>{
  const calls=[];const store=couponStore({mode:'mock',url:'https://isolated.invalid',serviceKey:'sb_secret_synthetic'},async(u,o)=>{calls.push([u,o]);return Response.json({allowed:false});});
  await assert.rejects(store.rpc('submit_signup',{}));assert.equal(calls.length,0);
  await store.rpc('coupon_welcome_claim_v1',{p_business_id:B});assert.equal(calls[0][0],'https://isolated.invalid/rest/v1/rpc/coupon_welcome_claim_v1');assert.equal(calls[0][1].redirect,'manual');
});
test('generic allowed does not stand in for a positive confirmed receipt',async()=>{
  const h=harness({rpc:n=>n==='coupon_record_confirmed_vip_v1'?{allowed:true,confirmed:false}:undefined});
  assert.equal((await h.confirm()).code,'confirmation_receipt_unconfirmed');
});
test('negative confirmation evidence is persisted, never replaced by a positive coupon consent',async()=>{
  const h=harness({marketing:{consent:'UNSUBSCRIBED'}});await h.confirm();
  assert.equal(h.calls.some(c=>c[0]==='coupon_record_negative_v1'),true);
  assert.equal(h.calls.some(c=>c[0]==='coupon_record_confirmed_vip_v1'),false);
});
test('false outbox acknowledgement cannot report provider acceptance',async()=>{
  const h=harness({rpc:n=>n==='coupon_welcome_finish_v1'?{acknowledged:false,status:'provider_accepted'}:undefined});
  assert.equal((await h.welcome()).code,'outbox_finalize_unconfirmed');assert.equal(h.events.length,1);
});
for(const [name,patch] of [['higher threshold',{minimum_amount_cents:4000}],['restricted channels',{channels:['site_pickup']}]])
  test(`initial welcome template rejects ${name} rather than promise different campaign terms`,async()=>{
    const j=makeJob();j.properties={...j.properties,...patch};const h=harness({job:j});
    assert.equal((await h.welcome()).status,'blocked');assert.equal(h.events.length,0);
    assert.equal(h.calls.some(c=>c[0]==='message_send_reserve_v1'),false);
  });
