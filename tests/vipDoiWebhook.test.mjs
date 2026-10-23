import test from 'node:test';
import assert from 'node:assert/strict';
import {doiWebhookConfig,doiWebhookProvider,doiWebhookStore,handleDoiWebhook} from '../functions/_lib/vipDoiWebhook.ts';
const B='11111111-1111-4111-8111-111111111111',C='22222222-2222-4222-8222-222222222222',S='33333333-3333-4333-8333-333333333333';
const E='synthetic@recipient.invalid',KEY='synthetic_machine_key_'.repeat(3);
const config={enabled:true,key:KEY,flowId:'SYNTHETIC_FLOW',listId:'SYNTHETIC_VIP',coupon:{mode:'mock',isolated:true,businessId:B,url:'https://test.invalid',serviceKey:'synthetic-only',accountId:'ACCOUNT_ONE'}};
function request(body={version:1,email:E,listId:config.listId},headers={},method='POST'){
 return new Request('https://owned.invalid/api/webhooks/vip-doi',{method,headers:{Authorization:'Bearer '+KEY,'X-Klaviyo-Flow-ID':config.flowId,'Content-Type':'application/json',...headers},...(method==='POST'?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});
}
function harness(overrides={}){
 const calls=[],writes=[],now=Date.now(),at=new Date(now-10000).toISOString();
 const marketing={consent:'SUBSCRIBED',can_receive_email_marketing:true,double_optin:true,consent_timestamp:at,suppression:[],list_suppressions:[],...overrides.marketing};
 const profile={id:'PROFILE_ONE',attributes:{email:E,subscriptions:{email:{marketing}}}};
 const store={async rpc(name,args){calls.push([name,args]);if(overrides.rpc){const r=await overrides.rpc(name,args);if(r!==undefined)return r;}
  if(name==='vip_doi_webhook_match_v1')return {allowed:true,businessId:B,customerId:C,signupId:S};
  if(name==='coupon_confirmation_context_v1')return {allowed:true,businessId:B,customerId:C,signupId:S,email:E,vipListId:config.listId,requestedAt:new Date(now-20000).toISOString(),isTest:false};
  if(name==='vip_doi_webhook_confirm_v1'){writes.push(args);return {confirmed:true,issued:1};}
  if(name==='vip_doi_webhook_observe_v1'||name==='coupon_record_negative_v1')return true;
  assert.fail(name);
 }};
 const provider={mode:'mock',async get(path){calls.push(['GET',path]);if(overrides.get){const r=await overrides.get(path);if(r!==undefined)return r;}
  if(path==='/accounts')return {data:[{id:'ACCOUNT_ONE'}]};
  if(path==='/lists/'+config.listId)return {data:{id:config.listId,attributes:{opt_in_process:'double_opt_in'}}};
  return {data:[profile]};
 },async eventAccount(){assert.fail('eventAccount forbidden');},async event(){assert.fail('sending forbidden');}};
 return {calls,writes,store,provider,run:(req=request(),cfg=config)=>handleDoiWebhook(req,cfg,{store,provider})};
}
test('Flow webhook reuses DOI checks and atomic receipt wrapper; sends nothing',async()=>{
 const h=harness(),r=await h.run();assert.equal(r.status,200);assert.deepEqual(await r.json(),{code:'confirmation_recorded'});
 assert.equal(h.writes.length,1);assert.equal(h.writes[0].p_account_id,'ACCOUNT_ONE');assert.equal(h.writes[0].p_provider_profile_id,'PROFILE_ONE');
 assert.equal(h.calls.some(([n])=>n==='coupon_record_confirmed_vip_v1'),false);
 const audit=h.calls.find(([n])=>n==='vip_doi_webhook_observe_v1')[1];assert.match(audit.p_request_key,/^[a-f0-9]{64}$/);assert.equal(JSON.stringify(audit).includes(E),false);
 assert.equal(r.headers.get('Cache-Control'),'no-store');
});
for(const [name,headers] of [['wrong token',{Authorization:'Bearer wrong'}],['missing flow',{'X-Klaviyo-Flow-ID':''}],['wrong flow',{'X-Klaviyo-Flow-ID':'OTHER'}],['browser Origin',{Origin:'https://owned.invalid'}]])test(name,async()=>{
 const h=harness();assert.equal((await h.run(request(undefined,headers))).status,403);assert.equal(h.calls.length,0);
});
for(const [name,body] of [['malformed','{'],['extra tenant',{version:1,email:E,listId:config.listId,businessId:C}],['wrong list',{version:1,email:E,listId:'OTHER'}],['wrong version',{version:2,email:E,listId:config.listId}],['oversized',' '.repeat(1025)],['unnormalized',{version:1,email:'UPPER@recipient.invalid',listId:config.listId}]])test(name,async()=>{
 const h=harness();assert.equal((await h.run(request(body))).status,400);assert.equal(h.calls.length,0);
});
test('disabled and method gates make zero calls',async()=>{
 const h=harness();assert.equal((await h.run(request(),{...config,enabled:false})).status,503);assert.equal((await h.run(request(undefined,{},'GET'))).status,405);assert.equal(h.calls.length,0);
});
for(const code of ['local_request_unmatched','local_request_ambiguous','recipient_blocked'])test(code+' is safely acknowledged without provider call',async()=>{
 const h=harness({rpc:n=>n==='vip_doi_webhook_match_v1'?{allowed:false,code}:undefined});const r=await h.run();assert.equal(r.status,200);assert.equal((await r.json()).code,code);assert.equal(h.calls.some(([n])=>n==='GET'),false);
});
for(const [name,opts] of [['no DOI',{marketing:{double_optin:false}}],['not subscribed',{marketing:{consent:'NEVER_SUBSCRIBED'}}],['missing date',{marketing:{consent_timestamp:null}}],['wrong account',{get:p=>p==='/accounts'?{data:[{id:'OTHER'}]}:undefined}],['single opt in',{get:p=>p==='/lists/'+config.listId?{data:{id:config.listId,attributes:{opt_in_process:'single_opt_in'}}}:undefined}],['API failure',{get:()=>{throw Error('private body must not leak');}}]])test(name+' does not acknowledge a coupon',async()=>{
 const h=harness(opts),r=await h.run();assert.equal(r.status,503);assert.equal(h.writes.length,0);assert.doesNotMatch(await r.text(),/private|recipient/);assert.ok(h.calls.some(([n,a])=>n==='vip_doi_webhook_observe_v1'&&a.p_status==='retryable'));
});
test('provider unsubscribe wins and is persisted through existing negative RPC',async()=>{
 const h=harness({marketing:{consent:'UNSUBSCRIBED',can_receive_email_marketing:false}}),r=await h.run();assert.equal(r.status,200);assert.equal(h.writes.length,0);assert.ok(h.calls.some(([n])=>n==='coupon_record_negative_v1'));
});
test('wrong tenant from DB match is rejected before provider',async()=>{
 const h=harness({rpc:n=>n==='vip_doi_webhook_match_v1'?{allowed:true,businessId:C,customerId:C,signupId:S}:undefined});assert.equal((await h.run()).status,503);assert.equal(h.calls.some(([n])=>n==='GET'),false);
});
test('lost atomic DB response is retryable and leaks no credentials',async()=>{
 const h=harness({rpc:n=>{if(n==='vip_doi_webhook_confirm_v1')throw Error('pk_private email '+E);}});const r=await h.run();assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/pk_|synthetic@/);
});
test('runtime mock cannot fabricate consent or send',async()=>{
 let calls=0;const p=doiWebhookProvider(config,async()=>{calls++;throw Error('network');});await assert.rejects(p.get('/accounts'),/mock_evidence_required/);await assert.rejects(p.event({}),/doi_never_sends/);assert.equal(calls,0);
});
test('narrow store rejects unlisted RPC, binds configured endpoint and suppresses provider errors',async()=>{
 const calls=[],store=doiWebhookStore(config,async(url,init)=>{calls.push([url,init]);return Response.json(true);});await assert.rejects(store.rpc('submit_signup_once',{}));assert.equal(calls.length,0);await store.rpc('vip_doi_webhook_observe_v1',{});assert.equal(calls.length,1);assert.equal(calls[0][0],config.coupon.url+'/rest/v1/rpc/vip_doi_webhook_observe_v1');
});
test('config defaults closed; live needs only read key, approval, exact environment; never event key',()=>{
 const env={SUPABASE_SECRET_KEY:'sb_secret_synthetic',TURNSTILE_SECRET_KEY:'non_test_value',VIP_DOI_ENABLED:'true',VIP_DOI_MODE:'live',VIP_DOI_WEBHOOK_KEY:KEY,VIP_DOI_FLOW_ID:'FLOW',VIP_DOI_LIST_ID:'LIST',COUPON_KLAVIYO_ACCOUNT_ID:'ACCOUNT',COUPON_KLAVIYO_READ_KEY:'pk_synthetic_read_only',VIP_DOI_APPROVAL_ID:'TEST-APPROVAL'};
 assert.equal(doiWebhookConfig({},'www.nazarrestaurantandbakery.com').enabled,false);assert.equal(doiWebhookConfig(env,'www.nazarrestaurantandbakery.com').enabled,true);
 assert.equal(doiWebhookConfig({...env,VIP_DOI_ENABLED:'false'},'www.nazarrestaurantandbakery.com').enabled,false);
 assert.equal(doiWebhookConfig(env,'sandbox.pages.dev').enabled,false);
 assert.equal(doiWebhookConfig(env,'www.nazarrestaurantandbakery.com').coupon.eventKey,'');
});
