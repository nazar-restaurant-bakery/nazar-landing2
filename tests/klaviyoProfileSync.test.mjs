import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runProfileSync,profileFingerprint,assertProfileRequest,KLAVIYO_REVISION} from '../functions/_lib/klaviyoProfileSync.ts';

const now=Date.parse('2026-10-20T12:00:00Z');
const context=()=>({businessId:'business_synthetic',customerId:'customer_synthetic',accountId:'account_synthetic',email:'person@example.invalid',name:'Synthetic Person',source:'website_vip_page',registeredAt:'2026-10-18T10:00:00Z',utm:{utm_source:'synthetic'},tags:['vip','pickup'],emailStatus:'subscribed',isTest:false,suppressedAt:null});
const lease=(attempt=1)=>({jobId:'job_synthetic',leaseId:'lease_synthetic',attempt});
const marketing=(overrides={})=>({consent:'SUBSCRIBED',can_receive_email_marketing:true,last_updated:'2026-10-19T10:00:00Z',suppression:[],list_suppressions:[],...overrides});
const profile=(ctx,properties={},status=marketing())=>({type:'profile',id:'profile_synthetic',attributes:{email:ctx.email,properties,subscriptions:{email:{marketing:status}}}});

function harness(options={}){
 const h={state:context(),reads:0,calls:[],outcomes:[],negativeEvents:0,profile:undefined};
 h.profile=options.missing?null:profile(h.state,{},options.marketing||marketing());
 const store={
  async readContext(){h.reads++;options.beforeRead?.(h);return structuredClone(h.state);},
  async finish(_lease,outcome){if(options.finishThrows)throw Error('synthetic private raw store error');h.outcomes.push(structuredClone(outcome));if(outcome.status==='provider_blocked'){h.state.emailStatus='unsubscribed';h.state.suppressedAt=new Date(now).toISOString();h.negativeEvents++;}},
 };
 const provider={async request(request){h.calls.push(request);assert.equal(request.headers.revision,KLAVIYO_REVISION);assert.equal(request.headers.Authorization,undefined);assertProfileRequest(request,h.state.email.trim().toLowerCase());if(options.request)return options.request(request,h);if(request.method==='GET')return {status:200,body:{data:h.profile?[h.profile]:[],links:{next:null}}};const sent=JSON.parse(request.body).data;h.profile={type:'profile',id:'profile_synthetic',attributes:{...sent.attributes,subscriptions:{email:{marketing:options.newMarketing||marketing()}}}};return {status:options.missing?201:200,body:{data:h.profile}};}};
 h.run=(attempt=1,extra={})=>runProfileSync({lease:lease(attempt),store,provider,now:()=>now,...extra});
 return h;
}

test('is_test, unsubscribed, missing consent and known local/provider blocks cause zero provider requests',async()=>{
 for(const override of [{isTest:true},{emailStatus:'unsubscribed'},{emailStatus:'not_subscribed'},{emailStatus:'pending_review'},{suppressedAt:'2026-10-19T00:00:00Z'},{providerBlockedStatus:'suppressed'}]){
  const h=harness();Object.assign(h.state,override);const result=await h.run();assert.equal(result.status,'failed');assert.equal(result.errorCode,'local_ineligible');assert.equal(h.calls.length,0);
 }
});
test('local consent changing immediately before GET or POST stops the next provider request',async()=>{
 for(const read of [2,3]){const h=harness({beforeRead(h){if(h.reads===read)h.state.emailStatus='unsubscribed';}});const result=await h.run();assert.equal(result.errorCode,'local_ineligible');assert.deepEqual(h.calls.map(c=>c.method),read===2?[]:['GET']);}
});
test('an account, email or managed-payload change cannot retarget a leased snapshot',async()=>{
 for(const changed of [{accountId:'other_account'},{email:'other@example.invalid'},{name:'Updated meanwhile'}]){const h=harness({beforeRead(h){if(h.reads===3)Object.assign(h.state,changed);}});const result=await h.run();assert.equal(result.errorCode,'local_context_changed');assert.deepEqual(h.calls.map(c=>c.method),['GET']);}
});
test('unsubscribed and global/list suppression atomically record local negative evidence without POST',async()=>{
 for(const status of [marketing({consent:'UNSUBSCRIBED',suppression:undefined}),marketing({suppression:[{reason:'USER_SUPPRESSED',timestamp:'2026-10-19T00:00:00Z'}]}),marketing({list_suppressions:[{list_id:'synthetic_list',reason:'UNSUBSCRIBED',timestamp:'2026-10-19T00:00:00Z'}]}),marketing({can_receive_email_marketing:false})]){
  const h=harness({marketing:status});const result=await h.run();assert.equal(result.status,'provider_blocked');assert.equal(h.negativeEvents,1);assert.equal(h.state.emailStatus,'unsubscribed');assert.deepEqual(h.calls.map(c=>c.method),['GET']);
 }
});
test('explicit unsubscribe wins even with absent or future optional timestamp, using observation time',async()=>{
 const h=harness({marketing:{consent:'UNSUBSCRIBED',last_updated:'2099-01-01T00:00:00Z'}});const result=await h.run();assert.equal(result.status,'provider_blocked');assert.equal(result.providerUpdatedAt,new Date(now).toISOString());assert.equal(h.calls.length,1);
});
test('missing, malformed and future nonnegative provider metadata fail closed',async()=>{
 for(const status of [{},marketing({suppression:null}),marketing({list_suppressions:[{}]}),marketing({consent:'UNKNOWN'}),marketing({last_updated:42}),marketing({last_updated:'2099-01-01T00:00:00Z'})]){const h=harness({marketing:status});const result=await h.run();assert.equal(result.status,'failed');assert.equal(result.errorCode,'provider_status_unverified');assert.equal(h.calls.length,1);}
});
test('upsert creates only managed profile attributes and a second equal job does not write again',async()=>{
 const h=harness({missing:true,newMarketing:marketing({consent:'NEVER_SUBSCRIBED',can_receive_email_marketing:false})});const first=await h.run();assert.equal(first.status,'succeeded');assert.match(first.fingerprint,/^[a-f0-9]{64}$/);assert.deepEqual(h.calls.map(c=>c.method),['GET','POST']);
 const body=JSON.parse(h.calls[1].body);assert.deepEqual(Object.keys(body),['data']);assert.deepEqual(Object.keys(body.data).sort(),['attributes','type']);assert.deepEqual(Object.keys(body.data.attributes).sort(),['email','properties']);assert.deepEqual(Object.keys(body.data.attributes.properties).sort(),['crm_name','crm_registered_at','crm_source','crm_tags','crm_utm']);
 const next=await h.run(2);assert.equal(next.status,'succeeded');assert.equal(next.unchanged,true);assert.equal(h.calls.filter(c=>c.method==='POST').length,1);assert.equal(h.profile.attributes.subscriptions.email.marketing.consent,'NEVER_SUBSCRIBED');
});
test('an existing unblocked NEVER_SUBSCRIBED profile permits attributes only without changing provider consent',async()=>{
 const h=harness({marketing:marketing({consent:'NEVER_SUBSCRIBED',can_receive_email_marketing:false})});const result=await h.run();assert.equal(result.status,'succeeded');assert.equal(JSON.parse(h.calls[1].body).data.attributes.subscriptions,undefined);
});
test('lost POST acknowledgement is reconciled by email on the next attempt without duplicate create',async()=>{
 const h=harness({missing:true,request:async(req,h)=>{if(req.method==='GET')return {status:200,body:{data:h.profile?[h.profile]:[]}};h.profile=profile(h.state,JSON.parse(req.body).data.attributes.properties,marketing({consent:'NEVER_SUBSCRIBED',can_receive_email_marketing:false}));throw Error('synthetic secret raw ACK loss person@example.invalid');}});
 const first=await h.run();assert.equal(first.status,'retry');assert.equal(first.uncertainWrite,true);const second=await h.run(2);assert.equal(second.status,'succeeded');assert.equal(second.unchanged,true);assert.equal(h.calls.filter(c=>c.method==='POST').length,1);assert.doesNotMatch(JSON.stringify(h.outcomes),/secret raw|person@example/);
});
test('409 causes a queued retry, whose fresh GET reconciles, with no inline second write',async()=>{
 const h=harness({request:async(req,h)=>{if(req.method==='GET')return {status:200,body:{data:[h.profile]}};h.profile=profile(h.state,JSON.parse(req.body).data.attributes.properties);return {status:409,body:{errors:[{links:{self:'https://evil.invalid/retarget'}}]}};}});
 assert.equal((await h.run()).errorCode,'provider_conflict');assert.deepEqual(h.calls.map(c=>c.method),['GET','POST']);assert.equal((await h.run(2)).status,'succeeded');assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
});
test('ambiguous email, pagination and redirect responses never retarget another request',async()=>{
 for(const response of [{status:200,body:{data:[profile(context()),profile(context())]}},{status:200,body:{data:[profile(context())],links:{next:'https://evil.invalid/collect'}}},{status:200,body:{data:[profile({...context(),email:'other@example.invalid'})]}},{status:302,headers:{location:'https://evil.invalid'},body:null}]){const h=harness({request:async()=>response});const result=await h.run();assert.equal(result.status,'failed');assert.equal(h.calls.length,1);}
});
test('429 seconds and date Retry-After schedule bounded retry without in-process retry',async()=>{
 for(const value of ['120',new Date(now+180000).toUTCString()]){const h=harness({request:async()=>({status:429,headers:{'Retry-After':value},body:{errors:['do not log']}})});const result=await h.run();assert.equal(result.status,'retry');assert.ok(result.retryAfterSeconds>=120);assert.equal(h.calls.length,1);}
});
test('network/5xx/timeouts retry at most six leased attempts and produce no raw error details',async()=>{
 for(const request of [async()=>{throw Error('RAW key_synthetic person@example.invalid');},async()=>({status:503,body:{detail:'RAW key_synthetic'}}),async()=>new Promise(()=>{})]){const h=harness({request});const first=await h.run(1,{timeoutMs:5});assert.equal(first.status,'retry');const last=await h.run(6,{timeoutMs:5});assert.equal(last.status,'failed');assert.equal(last.errorCode,'retry_exhausted');assert.doesNotMatch(JSON.stringify(h.outcomes),/RAW|key_synthetic|person@example/);assert.equal(h.calls.length,2);}
});
test('transport policy forbids subscription, suppression, events, lists, native tags, account switches and payload extensions',()=>{
 const email=context().email;
 for(const url of ['https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs','https://a.klaviyo.com/api/profile-suppression-bulk-delete-jobs','https://a.klaviyo.com/api/events','https://a.klaviyo.com/api/lists','https://a.klaviyo.com/api/tags','https://a.klaviyo.com.evil.invalid/api/profile-import'])assert.throws(()=>assertProfileRequest({method:'POST',url,body:'{}'},email));
 for(const attributes of [{email,properties:{crm_name:'Safe'},subscriptions:{}},{email,properties:{arbitrary:'unsafe'}},{email,properties:{crm_name:'Safe'},phone_number:'+15555555555'},{email,properties:{crm_registered_at:new Date(now).toISOString(),crm_tags:{subscriptions:'unsafe'}}},{email,properties:{crm_registered_at:new Date(now).toISOString(),crm_utm:{suppression:'unsafe'}}}])assert.throws(()=>assertProfileRequest({method:'POST',url:'https://a.klaviyo.com/api/profile-import',body:JSON.stringify({data:{type:'profile',attributes}})},email));
});
test('fingerprint is stable across tag order and UTM key order, and bound to account and attributes',async()=>{
 const c=context(),equal={...c,tags:['pickup','vip','vip'],utm:{utm_source:'synthetic'}};assert.equal(await profileFingerprint(c),await profileFingerprint(equal));for(const changed of [{accountId:'different'},{name:'Changed'},{source:'Changed'}])assert.notEqual(await profileFingerprint(c),await profileFingerprint({...c,...changed}));
});
test('a failed local success receipt never becomes a reported success after provider write',async()=>{
 const h=harness({finishThrows:true});const result=await h.run();assert.equal(result.status,'retry');assert.equal(result.errorCode,'local_store_unavailable');assert.equal(result.uncertainWrite,true);assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
});
test('unknown tags and UTM are omitted instead of clearing stored provider properties',async()=>{
 const h=harness();h.state.tags=null;h.state.utm=null;h.profile.attributes.properties={crm_tags:['preserve'],crm_utm:{utm_source:'preserve'}};
 assert.equal((await h.run()).status,'succeeded');const properties=JSON.parse(h.calls[1].body).data.attributes.properties;assert.equal('crm_tags' in properties,false);assert.equal('crm_utm' in properties,false);
 const empty=harness();empty.state.tags=[];empty.state.utm={};assert.equal((await empty.run()).status,'succeeded');const known=JSON.parse(empty.calls[1].body).data.attributes.properties;assert.deepEqual(known.crm_tags,[]);assert.deepEqual(known.crm_utm,{});
});
test('nonstandard attribution is not exported, and provider 401/403 is an explicit nonretry auth error',async()=>{
 const h=harness();h.state.utm={utm_source:'safe',gclid:'not-exported',referrer:'not-exported'};assert.equal((await h.run()).status,'succeeded');assert.deepEqual(JSON.parse(h.calls[1].body).data.attributes.properties.crm_utm,{utm_source:'safe'});
 for(const status of [401,403]){const denied=harness({request:async()=>({status,body:{errors:['secret raw key']}})});const result=await denied.run();assert.equal(result.status,'failed');assert.equal(result.errorCode,'provider_auth');assert.equal(denied.calls.length,1);}
});
test('malformed successful write acknowledgement schedules email reconciliation rather than another immediate POST',async()=>{
 const h=harness({request:async(req,h)=>{if(req.method==='GET')return {status:200,body:{data:[h.profile]}};h.profile=profile(h.state,JSON.parse(req.body).data.attributes.properties);return {status:200,body:{data:{id:'malformed'}}};}});const first=await h.run();assert.equal(first.status,'retry');assert.equal(first.errorCode,'provider_write_ack_unverified');assert.equal((await h.run(2)).status,'succeeded');assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
});
