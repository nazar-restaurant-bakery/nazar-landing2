import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {profileSyncHandler} from '../functions/api/staff/profile-sync.ts';

// Offline integration: real reviewed SQL and actual API/runtime/engine. Every
// fetch is injected below; no socket, real token, account or provider is used.
const runtime=process.env.PGLITE_MODULE;
if(!runtime)throw new Error('PGLITE_MODULE must select an isolated local database');
const {PGlite}=await import(runtime);
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
const baseline=await read('../supabase/baselines/20261019_application_schema.sql');
const markers=await read('../supabase/migrations/20261019000100_test_record_markers.sql');
const k4=await read('../supabase/migrations/20261019000200_suppression_consent_offers.sql');
const k5=await read('../supabase/migrations/20261019000300_klaviyo_profile_sync.sql');
const business=baseline.match(/CONSTRAINT businesses_id_check CHECK \(\(id = '([0-9a-f-]+)'::uuid\)\)/)[1];
const target='https://abcdefghijklmnopqrst.supabase.co';
const origin='https://fixture-preview.pages.dev';
const staffToken='synthetic.local.staff.token.only';
const foreignToken='synthetic.local.nonstaff.token.only';
const publicKey='sb_publishable_SYNTHETIC_LOCAL_ONLY';
const serviceKey='sb_secret_SYNTHETIC_LOCAL_ONLY';
const fakeProviderKey='pk_SYNTHETIC_LOCAL_ONLY_NOT_REAL';
const rpcParameters={
 crm_staff_authorized_v1:[],crm_profile_sync_queue_v1:['p_business_id'],
 klaviyo_profile_sync_enqueue_v1:['p_business_id','p_account','p_limit','p_customer_id'],
 klaviyo_profile_sync_claim_v1:['p_business_id','p_account','p_customer_id'],
 klaviyo_profile_sync_context_v1:['p_job_id','p_lease_id'],
 klaviyo_profile_sync_finish_v1:['p_job_id','p_lease_id','p_outcome'],
};
const reply=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json',...headers}});

async function setup(t){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE SCHEMA extensions;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;`);
 await db.exec(baseline.replace(/^\\(?:un)?restrict\s+\S+\r?$/gm,''));
 await db.exec(markers);await db.exec(k4);await db.exec(k5);
 await db.query("INSERT INTO core.businesses(id,name,intake_enabled) VALUES($1,'Synthetic local fixture',true)",[business]);
 const staff=randomUUID(),foreign=randomUUID();
 await db.query('INSERT INTO auth.users(id) VALUES($1)',[staff]);
 await db.query("INSERT INTO core.crm_staff(auth_user_id,role) VALUES($1,'staff')",[staff]);
 const h={db,staff,foreign,rpcCalls:[],providerCalls:[],profiles:new Map(),beforeRpc:null,providerReply:null};
 h.admin=async(callback)=>{await db.exec('RESET ROLE');return callback(db);};
 h.customer=async(fields={})=>h.admin(async()=>{
  const id=randomUUID();
  await db.query("INSERT INTO core.customers(id,business_id,identity_key,name,email,email_status,is_test) VALUES($1,$2,$3,$4,$5,$6,$7)",
   [id,business,id,'Synthetic Fixture',`${id}@fixture.test`,fields.status??'subscribed',fields.isTest??false]);
  if(fields.signup)await db.query("INSERT INTO core.signups(customer_id,business_id,source,fingerprint,utm) VALUES($1,$2,'website_vip_page',$3,$4)",
   [id,business,id,JSON.stringify({utm_source:'offline_fixture',utm_campaign:'integration',ignored_meta:'not_exported'})]);
  return id;
 });
 h.env=(id,extra={})=>({APP_ENV:'isolated-test',TEST_SUPABASE_URL:target,TEST_BUSINESS_ID:business,
  TEST_SUPABASE_SECRET_KEY:serviceKey,VITE_TEST_SUPABASE_ANON_KEY:publicKey,
  TEST_TURNSTILE_SECRET_KEY:'1x0000000000000000000000000000000AA',TEST_TURNSTILE_EXPECTED_HOSTNAME:'fixture-preview.pages.dev',
  TEST_KLAVIYO_PROFILE_SYNC_ACCOUNT_ID:'account_fixture',TEST_KLAVIYO_PROFILE_SYNC_MODE:'live',
  TEST_KLAVIYO_PROFILE_SYNC_KEY:fakeProviderKey,TEST_KLAVIYO_PROFILE_SYNC_LIVE_APPROVAL_ID:'LOCAL_MOCK_TRANSPORT_ONLY',
  TEST_KLAVIYO_PROFILE_SYNC_CUSTOMER_ID:id,...extra});
 h.fetch=async(input,init={})=>{
  const url=new URL(String(input));const headers=new Headers(init.headers);
  if(url.origin===target){
   assert.equal(init.method,'POST');assert.equal(init.redirect,'manual');
   const name=url.pathname.replace('/rest/v1/rpc/','');const names=rpcParameters[name];
   assert.ok(names,`No unexpected SQL RPC ${name}`);
   const args=JSON.parse(init.body??'{}');assert.ok(Object.keys(args).every(key=>names.includes(key)));
   const staffRequest=headers.get('apikey')===publicKey;
   if(staffRequest && ![`Bearer ${staffToken}`,`Bearer ${foreignToken}`].includes(headers.get('authorization')))return reply({code:'PGRST301'},401);
   if(!staffRequest)assert.equal(headers.get('apikey'),serviceKey);
   h.rpcCalls.push({name,args,role:staffRequest?'authenticated':'service_role'});
   if(h.beforeRpc)await h.beforeRpc(name,args,h);
   await db.exec('RESET ROLE');
   await db.query("SELECT set_config('request.jwt.claim.role',$1,false),set_config('request.jwt.claim.sub',$2,false)",
    [staffRequest?'authenticated':'service_role',staffRequest?(headers.get('authorization')===`Bearer ${staffToken}`?staff:foreign):'']);
   await db.exec(`SET ROLE ${staffRequest?'authenticated':'service_role'}`);
   try{
    const values=names.map(key=>key==='p_outcome'?JSON.stringify(args[key]):args[key]??null);
    const named=names.map((key,i)=>`${key}=>$${i+1}`).join(',');
    const result=(await db.query(`SELECT public.${name}(${named}) AS result`,values)).rows[0].result;
    return reply(result);
   }catch(error){return reply({code:error.code??'SQL_FAILURE'},error.code==='42501'?(staffRequest?403:401):400);}
  }
  assert.equal(url.origin,'https://a.klaviyo.com','Injected transport must never fall through to real network');
  assert.equal(init.redirect,'manual');assert.equal(headers.get('Authorization'),`Klaviyo-API-Key ${fakeProviderKey}`);
  assert.ok(['GET','POST'].includes(init.method));
  const call={method:init.method,url:url.href,body:init.body?JSON.parse(init.body):undefined};
  h.providerCalls.push(call);
  if(h.providerReply)return h.providerReply(call,h);
  if(init.method==='GET'){
   assert.equal(url.pathname,'/api/profiles');
   const match=/^equals\(email,(".*")\)$/.exec(url.searchParams.get('filter')??'');assert.ok(match);
   const found=h.profiles.get(JSON.parse(match[1]));return reply({data:found?[found]:[],links:{next:null}});
  }
  assert.equal(url.pathname,'/api/profile-import');
  assert.deepEqual(Object.keys(call.body),['data']);assert.deepEqual(Object.keys(call.body.data.attributes).sort(),['email','properties']);
  const attributes=call.body.data.attributes;
  const profile={type:'profile',id:'SYNTHETIC_PROFILE',attributes:{...attributes,subscriptions:{email:{marketing:{
   consent:'NEVER_SUBSCRIBED',can_receive_email_marketing:false,suppression:[],list_suppressions:[]}}}}};
  const existed=h.profiles.has(attributes.email);h.profiles.set(attributes.email,profile);
  return reply({data:profile},existed?200:201);
 };
 h.handler=profileSyncHandler(h.fetch);
 h.request=async(method,env,token=staffToken)=>{
  const response=await h.handler({env,request:new Request(origin+'/api/staff/profile-sync',{
   method,headers:{Origin:origin,Authorization:`Bearer ${token}`,...(method==='POST'?{'Content-Type':'application/json'}:{})},
   ...(method==='POST'?{body:JSON.stringify({action:'run'})}:{})})});
  return {status:response.status,body:await response.json()};
 };
 return h;
}

test('actual API→engine→SQL→mock transport succeeds once and repeated identical run does not claim or write again',async t=>{
 const h=await setup(t);const id=await h.customer({signup:true});const other=await h.customer();const env=h.env(id);
 const first=await h.request('POST',env);assert.equal(first.status,200);assert.equal(first.body.succeeded,1);
 assert.deepEqual(h.providerCalls.map(c=>c.method),['GET','POST']);assert.equal(h.profiles.size,1);
 const attributes=h.providerCalls[1].body.data.attributes;
 assert.equal(attributes.properties.crm_source,'website_vip_page');assert.deepEqual(attributes.properties.crm_utm,{utm_source:'offline_fixture',utm_campaign:'integration'});
 assert.ok(!('crm_tags'in attributes.properties));assert.ok(!('subscriptions'in attributes));
 const finishes=h.rpcCalls.filter(c=>c.name==='klaviyo_profile_sync_finish_v1');
 assert.equal(finishes.length,1);assert.deepEqual(finishes[0].args.p_outcome,{status:'succeeded'});
 const second=await h.request('POST',env);assert.equal(second.status,200);assert.equal(second.body.processed,0);
 assert.equal(h.providerCalls.length,2);assert.equal(h.rpcCalls.filter(c=>c.name==='klaviyo_profile_sync_finish_v1').length,1);
 await h.admin(async db=>{const rows=(await db.query('SELECT customer_id,status,attempts FROM core.klaviyo_profile_sync_jobs')).rows;
  assert.deepEqual(rows,[{customer_id:id,status:'succeeded',attempts:1}]);assert.notEqual(rows[0].customer_id,other);});
 const read=await h.request('GET',env);assert.equal(read.status,200);assert.equal(read.body.counts.succeeded,1);assert.equal(read.body.jobs[0].attempts,1);
 assert.ok(!JSON.stringify(read.body).includes('@fixture.test'));assert.ok(!JSON.stringify(read.body).includes(serviceKey));
});

test('actual SQL excludes marked test and unsubscribed customers before the provider adapter runs',async t=>{
 const h=await setup(t);
 for(const fields of [{isTest:true},{status:'unsubscribed'},{status:'not_subscribed'},{status:'pending_review'}]){
  const id=await h.customer(fields);const result=await h.request('POST',h.env(id));
  assert.equal(result.status,200);assert.equal(result.body.processed,0);
 }
 assert.equal(h.providerCalls.length,0);await h.admin(async db=>assert.equal((await db.query('SELECT count(*)::int AS n FROM core.klaviyo_profile_sync_jobs')).rows[0].n,0));
});

test('negative local state at first context atomically invalidates lease; API acknowledges blocked rather than double-finishing',async t=>{
 const h=await setup(t);const id=await h.customer();let changed=false;
 h.beforeRpc=async(name,_args,state)=>{if(name==='klaviyo_profile_sync_context_v1'&&!changed){changed=true;
  await state.admin(db=>db.query("UPDATE core.customers SET email_status='unsubscribed',email_suppressed_at=clock_timestamp() WHERE id=$1",[id]));}};
 const result=await h.request('POST',h.env(id));assert.equal(result.status,200);assert.equal(result.body.blocked,1);
 assert.equal(h.providerCalls.length,0);assert.equal(h.rpcCalls.filter(c=>c.name==='klaviyo_profile_sync_finish_v1').length,0);
 await h.admin(async db=>assert.deepEqual((await db.query('SELECT status,lease_id FROM core.klaviyo_profile_sync_jobs')).rows[0],{status:'blocked',lease_id:null}));
});

test('changed payload before provider POST is safely requeued without a second finish or provider write',async t=>{
 const h=await setup(t);const id=await h.customer();let contexts=0;
 h.beforeRpc=async(name,_args,state)=>{if(name==='klaviyo_profile_sync_context_v1'&&++contexts===3)
  await state.admin(db=>db.query("UPDATE core.customers SET name='Changed locally' WHERE id=$1",[id]));};
 const result=await h.request('POST',h.env(id));assert.equal(result.status,200);assert.equal(result.body.retry,1);
 assert.deepEqual(h.providerCalls.map(c=>c.method),['GET']);assert.equal(h.rpcCalls.filter(c=>c.name==='klaviyo_profile_sync_finish_v1').length,0);
 await h.admin(async db=>assert.equal((await db.query('SELECT status FROM core.klaviyo_profile_sync_jobs')).rows[0].status,'queued'));
});

test('built-in mock 429 persists safe retry/error which authorized GET reads from actual SQL',async t=>{
 const h=await setup(t);const id=await h.customer();const env=h.env(id,{TEST_KLAVIYO_PROFILE_SYNC_MODE:'mock',TEST_KLAVIYO_PROFILE_SYNC_MOCK_FAILURE:'rate_limit'});
 const result=await h.request('POST',env);assert.equal(result.status,200);assert.equal(result.body.retry,1);assert.equal(result.body.mode,'mock');
 const read=await h.request('GET',env);assert.equal(read.status,200);assert.equal(read.body.jobs[0].status,'retry');
 assert.equal(read.body.jobs[0].lastErrorCode,'PROVIDER_RATE_LIMITED');assert.equal(read.body.counts.retry,1);
 await h.admin(async db=>{const row=(await db.query("SELECT attempts,last_error_code,next_attempt_at>clock_timestamp()+interval '50 seconds' AS delayed FROM core.klaviyo_profile_sync_jobs")).rows[0];
  assert.deepEqual(row,{attempts:1,last_error_code:'provider_rate_limited',delayed:true});});
 assert.equal(h.providerCalls.length,0);const again=await h.request('POST',env);assert.equal(again.body.processed,0);
});

test('mock provider unsubscribe goes through actual finish/readback SQL, preserves K4 and performs no profile POST',async t=>{
 const h=await setup(t);const id=await h.customer();
 h.providerReply=call=>{assert.equal(call.method,'GET');const email=JSON.parse(new URL(call.url).searchParams.get('filter').match(/^equals\(email,(".*")\)$/)[1]);
  return reply({data:[{type:'profile',id:'SYNTHETIC_BLOCKED',attributes:{email,subscriptions:{email:{marketing:{consent:'UNSUBSCRIBED'}}}}}],links:{next:null}});};
 const result=await h.request('POST',h.env(id));assert.equal(result.status,200);assert.equal(result.body.blocked,1);assert.equal(h.providerCalls.length,1);
 await h.admin(async db=>{assert.equal((await db.query('SELECT email_status FROM core.customers WHERE id=$1',[id])).rows[0].email_status,'unsubscribed');
  assert.deepEqual((await db.query('SELECT event_type,source FROM core.consent_events WHERE customer_id=$1',[id])).rows[0],{event_type:'suppression',source:'klaviyo_readback'});
  await assert.rejects(db.query("UPDATE core.customers SET email_status='subscribed',email_suppressed_at=NULL WHERE id=$1",[id]),e=>e.code==='42501');});
});

test('existing staff authorization is actual SQL; unknown/nonstaff tokens cannot collect or read queue',async t=>{
 const h=await setup(t);const id=await h.customer();const env=h.env(id);
 const foreign=await h.request('POST',env,foreignToken);assert.equal(foreign.status,403);
 const unknown=await h.request('GET',env,'synthetic.unknown.staff.token');assert.equal(unknown.status,401);
 assert.equal(h.providerCalls.length,0);assert.ok(h.rpcCalls.every(c=>c.name==='crm_staff_authorized_v1'));
 await h.admin(async db=>assert.equal((await db.query('SELECT count(*)::int AS n FROM core.klaviyo_profile_sync_jobs')).rows[0].n,0));
});

test('SQL unknown UTM is omitted by actual provider adapter while known empty UTM remains explicit empty',async t=>{
 const h=await setup(t);const unknown=await h.customer();
 const one=await h.request('POST',h.env(unknown));assert.equal(one.status,200);assert.equal(one.body.succeeded,1);
 const first=h.providerCalls.find(c=>c.method==='POST');assert.ok(!('crm_utm'in first.body.data.attributes.properties));
 const known=await h.customer({signup:true});
 await h.admin(db=>db.query("UPDATE core.signups SET utm='{}'::jsonb WHERE customer_id=$1",[known]));
 const two=await h.request('POST',h.env(known));assert.equal(two.status,200);assert.equal(two.body.succeeded,1);
 const last=h.providerCalls.filter(c=>c.method==='POST').at(-1);assert.deepEqual(last.body.data.attributes.properties.crm_utm,{});
});

test('lost mock POST acknowledgement retries by GET reconciliation without a duplicate profile write',async t=>{
 const h=await setup(t);const id=await h.customer();let saved;
 h.providerReply=call=>{
  if(call.method==='GET')return reply({data:saved?[saved]:[],links:{next:null}});
  saved={type:'profile',id:'SYNTHETIC_ACK_LOSS',attributes:{...call.body.data.attributes,
   subscriptions:{email:{marketing:{consent:'NEVER_SUBSCRIBED',can_receive_email_marketing:false,suppression:[],list_suppressions:[]}}}}};
  throw Error('PRIVATE_RAW_PROVIDER_ERROR synthetic-address@fixture.test');
 };
 const first=await h.request('POST',h.env(id));assert.equal(first.status,200);assert.equal(first.body.retry,1);
 assert.deepEqual(h.providerCalls.map(c=>c.method),['GET','POST']);
 const waiting=await h.request('GET',h.env(id));assert.equal(waiting.body.jobs[0].status,'retry');
 assert.doesNotMatch(JSON.stringify(waiting.body),/PRIVATE_RAW|synthetic-address|@fixture[.]test/);
 await h.admin(db=>db.query("UPDATE core.klaviyo_profile_sync_jobs SET next_attempt_at=clock_timestamp()-interval '1 second'"));
 const second=await h.request('POST',h.env(id));assert.equal(second.status,200);assert.equal(second.body.succeeded,1);
 assert.deepEqual(h.providerCalls.map(c=>c.method),['GET','POST','GET']);
 await h.admin(async db=>assert.deepEqual((await db.query('SELECT status,attempts FROM core.klaviyo_profile_sync_jobs')).rows[0],{status:'succeeded',attempts:2}));
});
