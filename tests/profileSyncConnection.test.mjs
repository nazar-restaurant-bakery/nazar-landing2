import assert from 'node:assert/strict';
import {test} from 'node:test';
import {checkProfileSyncConnection} from '../functions/_lib/profileSyncConnection.ts';
import {profileSyncConfig} from '../functions/_lib/profileSyncRuntime.ts';
import {profileSyncHandler} from '../functions/api/staff/profile-sync.ts';
import {TEST_TURNSTILE_SECRET_KEY} from '../src/lib/deploymentEnvironment.ts';

// Entirely synthetic injected HTTP: no global fetch, accounts, keys or DB writes.
const origin = 'https://www.nazarrestaurantandbakery.com';
const token = 'synthetic_staff_token_1234567890';
const secret = 'pk_SYNTHETIC_NEW_PRODUCTION_KEY_ONLY';
const liveEnv = () => ({VITE_SUPABASE_ANON_KEY:'sb_publishable_synthetic_prod',
  SUPABASE_SECRET_KEY:'sb_secret_synthetic_prod', TURNSTILE_SECRET_KEY:'synthetic_turnstile',
  KLAVIYO_PROFILE_SYNC_MODE:'live', KLAVIYO_PROFILE_SYNC_ACCOUNT_ID:'synthetic_account',
  KLAVIYO_PROFILE_SYNC_LIVE_APPROVAL_ID:'synthetic-approval-only', KLAVIYO_PROFILE_SYNC_KEY:secret});
const previewEnv = () => ({...liveEnv(), APP_ENV:'isolated-test',
  TEST_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',
  TEST_BUSINESS_ID:'11111111-2222-3333-4444-555555555555',
  VITE_TEST_SUPABASE_ANON_KEY:'sb_publishable_synthetic_test', TEST_SUPABASE_SECRET_KEY:'sb_secret_synthetic_test',
  TEST_TURNSTILE_SECRET_KEY, TEST_TURNSTILE_EXPECTED_HOSTNAME:'fixture.pages.dev',
  TEST_KLAVIYO_PROFILE_SYNC_MODE:'live', TEST_KLAVIYO_PROFILE_SYNC_ACCOUNT_ID:'synthetic_test_account',
  TEST_KLAVIYO_PROFILE_SYNC_KEY:'pk_SYNTHETIC_DIFFERENT_PREVIEW_KEY',
  TEST_KLAVIYO_PROFILE_SYNC_LIVE_APPROVAL_ID:'synthetic-preview-approval',
  TEST_KLAVIYO_PROFILE_SYNC_CUSTOMER_ID:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'});
const config = () => profileSyncConfig(liveEnv(), new URL(origin).hostname);
const json = (body,status=200,headers={}) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/vnd.api+json',...headers}});
const empty = () => json({data:[],links:{next:null}});
function harness({allowed=true,provider=empty}={}) {
  const calls=[];
  const fetcher=async(input,init={})=>{
    const url=new URL(String(input)); calls.push({url,init});
    if(url.hostname==='a.klaviyo.com') return provider(input,init);
    const rpc=url.pathname.split('/').at(-1);
    assert.equal(rpc,'staff_business_authorized_v1','Check must never enqueue, claim, read the queue, or finish a lease');
    assert.equal(init.method,'POST'); assert.equal(new Headers(init.headers).get('Authorization'),`Bearer ${token}`);
    return json(allowed);
  };
  return {calls,handler:profileSyncHandler(fetcher)};
}
async function request(h,{env=liveEnv(),site=origin,requestOrigin=site,bearer=token,action='check',extra={}}={}) {
  const response=await h.handler({env,request:new Request(site+'/api/staff/profile-sync',{
    method:'POST', headers:{Origin:requestOrigin,...(bearer?{Authorization:`Bearer ${bearer}`} : {}),'Content-Type':'application/json'},
    body:JSON.stringify({action,...extra})})});
  return {status:response.status,body:await response.json(),headers:response.headers};
}
const vendorCalls=h=>h.calls.filter(call=>call.url.hostname==='a.klaviyo.com');

test('check requires existing bearer, same origin and active staff authorization before any provider request',async()=>{
  for(const options of [{bearer:''},{requestOrigin:'https://foreign.invalid'},{requestOrigin:'null'}]){
    const h=harness(); const result=await request(h,options);
    assert.equal(result.status,options.bearer===''?401:403); assert.equal(h.calls.length,0);
  }
  const denied=harness({allowed:false}); assert.equal((await request(denied)).status,403);
  assert.equal(denied.calls.length,1); assert.equal(vendorCalls(denied).length,0);
  const h=harness(); assert.equal((await request(h,{extra:{email:'real-person@example.invalid'}})).status,400);
  assert.equal(h.calls.length,1); assert.equal(vendorCalls(h).length,0);
});

test('disabled, mock and even live isolated environments cannot run the diagnostic or touch the queue',async()=>{
  const variants=[{env:{...liveEnv(),KLAVIYO_PROFILE_SYNC_MODE:'disabled'}},
    {env:{...liveEnv(),KLAVIYO_PROFILE_SYNC_KEY:''}},
    {env:{...previewEnv(),TEST_KLAVIYO_PROFILE_SYNC_MODE:'mock'},site:'https://fixture.pages.dev'},
    {env:previewEnv(),site:'https://fixture.pages.dev'}];
  for(const options of variants){
    const h=harness(); const result=await request(h,options);
    assert.equal(result.status,503); assert.equal(result.body.code,'connection_unavailable');
    assert.equal(h.calls.length,1); assert.equal(vendorCalls(h).length,0);
  }
});

test('successful check uses exactly one fresh synthetic sparse GET and returns only safe server metadata',async()=>{
  const h=harness(); const first=await request(h);
  assert.equal(first.status,200);
  assert.deepEqual(Object.keys(first.body).sort(),['checkedAt','code','providerHttpStatus','readOnly']);
  assert.equal(first.body.code,'connection_verified'); assert.equal(first.body.readOnly,true);
  assert.equal(first.body.providerHttpStatus,200); assert.ok(Number.isFinite(Date.parse(first.body.checkedAt)));
  assert.equal(first.headers.get('Cache-Control'),'private, no-store');
  assert.equal(h.calls.length,2); const call=vendorCalls(h)[0];
  assert.equal(call.url.origin,'https://a.klaviyo.com'); assert.equal(call.url.pathname,'/api/profiles');
  assert.equal(call.url.username,''); assert.equal(call.url.password,''); assert.equal(call.url.hash,'');
  assert.deepEqual([...call.url.searchParams.keys()].sort(),['fields[profile]','filter','page[size]']);
  assert.equal(call.url.searchParams.get('fields[profile]'),'id'); assert.equal(call.url.searchParams.get('page[size]'),'1');
  assert.match(call.url.searchParams.get('filter'),/^equals\(email,"k5-auth-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@example\.invalid"\)$/);
  assert.equal(call.init.method,'GET'); assert.equal(call.init.redirect,'manual'); assert.equal(call.init.credentials,'omit');
  assert.equal(call.init.body,undefined); assert.ok(call.init.signal instanceof AbortSignal);
  assert.deepEqual(Object.fromEntries(new Headers(call.init.headers)),{accept:'application/vnd.api+json',authorization:`Klaviyo-API-Key ${secret}`,revision:'2026-07-15'});
  assert.ok(!JSON.stringify(first.body).includes(secret)); assert.ok(!JSON.stringify(first.body).includes('example.invalid'));
  const second=harness(); await request(second);
  assert.notEqual(vendorCalls(second)[0].url.searchParams.get('filter'),call.url.searchParams.get('filter'));
});

test('provider auth, rate limit, rejection and redirects are sanitized without reading error bodies or retrying',async()=>{
  for(const status of [401,403,429,302,307,308,400,500]){
    let bodyRead=false;
    const h=harness({provider:()=>{
      const response=new Response('RAW_PRIVATE_EMAIL_AND_KEY',{status,headers:{Location:'https://trap.invalid', 'X-Private':'SECRET'}});
      Object.defineProperty(response,'body',{get(){bodyRead=true;throw new Error('MUST_NOT_READ');}});
      return response;
    }});
    const result=await request(h);
    assert.equal(result.status,[401,403].includes(status)?502:status===429?429:502);
    assert.equal(result.body.code,[401,403].includes(status)?'connection_auth_failed':status===429?'connection_rate_limited':'connection_unconfirmed');
    assert.equal(result.body.providerHttpStatus,status); assert.equal(bodyRead,false);
    assert.equal(vendorCalls(h).length,1); assert.equal(h.calls.length,2);
    for(const forbidden of ['RAW_PRIVATE','trap.invalid','SECRET',secret]) assert.ok(!JSON.stringify(result.body).includes(forbidden));
  }
});

test('malformed, nonempty, paginated and contradictory success responses fail closed without reflecting profiles',async()=>{
  for(const body of [null,[],{}, {data:{}},{data:[{id:'PRIVATE_ID',attributes:{email:'PRIVATE_EMAIL'}}]},
    {data:[],links:{next:'https://trap.invalid/next'}},{data:[],links:null},
    {data:[],links:{next:''}},{data:[],errors:[]},{data:[],included:[{id:'PRIVATE_ID'}]}]){
    const h=harness({provider:()=>json(body)}); const result=await request(h);
    assert.equal(result.status,502); assert.equal(result.body.code,'connection_unconfirmed');
    assert.equal(vendorCalls(h).length,1); assert.ok(!JSON.stringify(result.body).includes('PRIVATE_'));
  }
  const malformed=harness({provider:()=>new Response('NOT_JSON_PRIVATE')});
  assert.equal((await request(malformed)).body.code,'connection_unconfirmed');
});

test('the response cap rejects declared and streamed bodies larger than16KiB, including missing Content-Length',async()=>{
  for(const response of [new Response('x',{headers:{'Content-Length':'16385'}}),
    new Response('x'.repeat(16385)),new Response('x',{headers:{'Content-Length':'invalid'}}),
    new Response(new Uint8Array([0xff,0xfe]))]){
    const h=harness({provider:()=>response}); const result=await request(h);
    assert.equal(result.status,502); assert.equal(result.body.code,'connection_unconfirmed');
    assert.equal(vendorCalls(h).length,1);
  }
  const exact=JSON.stringify({data:[],padding:'x'.repeat(16384-24)});
  assert.equal(Buffer.byteLength(exact),16384);
  const h=harness({provider:()=>new Response(exact)});
  assert.equal((await request(h)).body.code,'connection_verified');
});

test('network failures expose neither keys nor URLs and never retry',async()=>{
  const h=harness({provider:()=>{throw new Error(`https://private.invalid ${secret} PRIVATE_EMAIL`);}});
  const result=await request(h); assert.equal(result.status,503); assert.equal(result.body.code,'connection_unavailable');
  assert.equal('providerHttpStatus'in result.body,false); assert.equal(vendorCalls(h).length,1);
  assert.ok(!JSON.stringify(result.body).includes(secret)); assert.ok(!JSON.stringify(result.body).includes('private.invalid'));
});

test('five-second deadline aborts a stalled request with no retry or exposed credential',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let signal; let calls=0;
  const pending=checkProfileSyncConnection(config(),async(_url,init)=>{calls++;signal=init.signal;return new Promise(()=>{});});
  t.mock.timers.tick(5000); const result=await pending;
  assert.equal(signal.aborted,true); assert.equal(calls,1); assert.equal(result.status,503);
  assert.equal(result.body.code,'connection_unavailable'); assert.equal('providerHttpStatus'in result.body,false);
});

test('the same deadline covers a stalled success body after HTTP headers arrive',async t=>{
  t.mock.timers.enable({apis:['setTimeout']}); let signal;
  const pending=checkProfileSyncConnection(config(),async(_url,init)=>{signal=init.signal;return new Response(new ReadableStream({start(){}}));});
  await Promise.resolve(); await Promise.resolve(); t.mock.timers.tick(5000);
  const result=await pending; assert.equal(result.status,503); assert.equal(result.body.providerHttpStatus,200);
  assert.equal(signal.aborted,true);
});

test('helper independently refuses isolated/nonlive configurations; legacy run and GET paths remain separate',async()=>{
  for(const changes of [{isolated:true},{mode:'disabled'},{mode:'mock'},{readable:false},{providerKey:''}]){
    let calls=0; const result=await checkProfileSyncConnection({...config(),...changes},async()=>{calls++;return empty();});
    assert.equal(result.status,503); assert.equal(calls,0);
  }
  const calls=[]; const handler=profileSyncHandler(async(input)=>{
    const name=new URL(String(input)).pathname.split('/').at(-1); calls.push(name);
    if(name==='staff_business_authorized_v1')return json(true);
    if(name==='klaviyo_profile_sync_enqueue_v1')return json({enqueued:0,unchanged:0});
    if(name==='klaviyo_profile_sync_claim_v1')return json(null);
    if(name==='crm_profile_sync_queue_v1')return json({items:[],counts:{total:0}});
    assert.fail(`Unexpected endpoint ${name}`);
  });
  const result=await request({handler},{action:'run'});
  assert.equal(result.status,200); assert.equal(result.body.processed,0);
  assert.deepEqual(calls,['staff_business_authorized_v1','klaviyo_profile_sync_enqueue_v1','klaviyo_profile_sync_claim_v1']);
  const invalid=await request({handler},{action:['check']}); assert.equal(invalid.status,400);
  const response=await handler({env:liveEnv(),request:new Request(origin+'/api/staff/profile-sync',{headers:{Authorization:`Bearer ${token}`}})});
  assert.equal(response.status,200); assert.equal((await response.json()).mode,'live');
  assert.deepEqual(calls.slice(-2),['staff_business_authorized_v1','crm_profile_sync_queue_v1']);
});
