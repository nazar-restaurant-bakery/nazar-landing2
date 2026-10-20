import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const runtime=process.env.PGLITE_MODULE;
if(!runtime)throw new Error('PGLITE_MODULE must select the isolated local database');
const {PGlite}=await import(runtime);
const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const baseline=await read('../supabase/baselines/20261019_application_schema.sql');
const k4=await read('../supabase/migrations/20261019000200_suppression_consent_offers.sql');
const migration=await read('../supabase/migrations/20261019000300_klaviyo_profile_sync.sql');
const business=baseline.match(/CONSTRAINT businesses_id_check CHECK \(\(id = '([0-9a-f-]+)'::uuid\)\)/)[1];
async function fixture(t,markers=false){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE SCHEMA extensions;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;`);
 await db.exec(baseline.replace(/^\\(?:un)?restrict\s+\S+\r?$/gm,''));
 if(markers)await db.exec(await read('../supabase/migrations/20261019000100_test_record_markers.sql'));
 await db.exec(k4);await db.exec(migration);
 await db.query("INSERT INTO core.businesses(id,name,intake_enabled) VALUES($1,'Synthetic local fixture',true)",[business]);
 const staff=randomUUID();await db.query('INSERT INTO auth.users(id) VALUES($1)',[staff]);
 await db.query("INSERT INTO core.crm_staff(auth_user_id,role) VALUES($1,'staff')",[staff]);
 return {db,staff};
}
async function as(db,role,uid=null){
 await db.exec('RESET ROLE');
 await db.query("SELECT set_config('request.jwt.claim.role',$1,false),set_config('request.jwt.claim.sub',$2,false)",[role,uid??'']);
 if(role!=='postgres')await db.exec(`SET ROLE ${role}`);
}
async function customer(db,fields={}){
 await as(db,'postgres');const id=randomUUID();
 await db.query("INSERT INTO core.customers(id,business_id,identity_key,name,email,email_status,email_suppressed_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
 [id,business,id,fields.name??'Synthetic Person',fields.email??`${id}@fixture.test`,fields.status??'subscribed',fields.suppressedAt??null]);
 if(fields.testSignup)await db.query("INSERT INTO core.signups(business_id,customer_id,source,fingerprint,is_test,utm) VALUES($1,$2,'website_vip_page',$3,true,'{}')",[business,id,id]);
 return id;
}
async function rpc(db,name,args=[]){return (await db.query(`SELECT public.${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) AS result`,args)).rows[0].result;}
async function start(db,id,account='acct_fixture'){
 await as(db,'service_role');await rpc(db,'klaviyo_profile_sync_enqueue_v1',[business,account,100,id]);
 return rpc(db,'klaviyo_profile_sync_claim_v1',[business,account,id]);
}
async function finish(db,job,outcome){return rpc(db,'klaviyo_profile_sync_finish_v1',[job.jobId,job.leaseId,JSON.stringify(outcome)]);}
const sqlerror=(code)=>error=>error.code===code;

test('K5 LF SQL installs over exact baseline+K4 with or without optional test markers',async t=>{
 assert.ok(!migration.includes('\r'));assert.ok(!migration.includes(business));
 assert.ok(!migration.includes('khgczybubufouraqyrcj'));
 for(const markers of [false,true]){
  const {db}=await fixture(t,markers);
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='core.klaviyo_profile_sync_jobs'::regclass")).rows[0].relrowsecurity,true);
  for(const role of ['anon','authenticated','service_role']){
   assert.equal((await db.query("SELECT has_schema_privilege($1,'core','USAGE') AS allowed",[role])).rows[0].allowed,false);
  }
 }
});

test('service-only APIs and staff-only metadata preserve private-core access boundaries',async t=>{
 const {db,staff}=await fixture(t);const id=await customer(db);
 for(const role of ['anon','authenticated']){
  await as(db,role,staff);
  await assert.rejects(rpc(db,'klaviyo_profile_sync_enqueue_v1',[business,'acct_fixture',100,id]),sqlerror('42501'));
  await assert.rejects(db.query('SELECT * FROM core.klaviyo_profile_sync_jobs'),sqlerror('42501'));
 }
 await as(db,'authenticated',randomUUID());
 await assert.rejects(rpc(db,'crm_profile_sync_queue_v1',[business]),sqlerror('42501'));
 await as(db,'authenticated',staff);
 assert.equal((await rpc(db,'crm_profile_sync_queue_v1',[business])).items.length,0);
 await as(db,'service_role');await assert.rejects(rpc(db,'crm_profile_sync_queue_v1',[business]),sqlerror('42501'));
});

test('one durable job per account/customer and truthful minimal context; no positive consent event',async t=>{
 const {db,staff}=await fixture(t);const id=await customer(db);
 await db.query("INSERT INTO core.signups(business_id,customer_id,source,fingerprint,utm,meta) VALUES($1,$2,'website_vip_page',$3,$4,$5)",
  [business,id,id,JSON.stringify({utm_source:'source-fixture',utm_campaign:'campaign-fixture',email:'not-exported'}),JSON.stringify({message:'not-exported',tags:['not-a-defined-field']})]);
 await as(db,'service_role');
 assert.equal((await rpc(db,'klaviyo_profile_sync_enqueue_v1',[business,'acct_fixture',100,id])).enqueued,1);
 assert.equal((await rpc(db,'klaviyo_profile_sync_enqueue_v1',[business,'acct_fixture',100,id])).unchanged,1);
 const job=await rpc(db,'klaviyo_profile_sync_claim_v1',[business,'acct_fixture',id]);
 assert.equal(await rpc(db,'klaviyo_profile_sync_claim_v1',[business,'acct_fixture',id]),null);
 const context=await rpc(db,'klaviyo_profile_sync_context_v1',[job.jobId,job.leaseId]);
 assert.equal(context.customerId,id);assert.equal(context.eligible,true);
 assert.deepEqual(context.eligibility,{emailStatus:'subscribed',isTest:false,suppressedAt:null});
 assert.equal(context.profile.name,'Synthetic Person');assert.equal(context.profile.source,'website_vip_page');
 assert.deepEqual(context.profile.utm,{utm_source:'source-fixture',utm_campaign:'campaign-fixture'});assert.equal(context.profile.tags,null);
 assert.match(context.fingerprint,/^[0-9a-f]{64}$/);assert.match(context.idempotencyKey,/^k5:/);
 assert.equal((await finish(db,job,{status:'succeeded'})).status,'succeeded');
 await as(db,'postgres');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM core.klaviyo_profile_sync_jobs')).rows[0].n,1);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM core.consent_events')).rows[0].n,0);
 await as(db,'authenticated',staff);const queue=await rpc(db,'crm_profile_sync_queue_v1',[business]);
 assert.equal(queue.counts.succeeded,1);assert.ok(!JSON.stringify(queue).includes('@fixture.test'));assert.ok(!JSON.stringify(queue).includes('Synthetic Person'));
});

test('ineligible statuses, suppressed and test records never queue; last-minute suppression blocks existing lease',async t=>{
 const {db}=await fixture(t,true);
 const ids=[];
 for(const status of ['not_subscribed','pending_review','unsubscribed'])ids.push(await customer(db,{status}));
 ids.push(await customer(db,{testSignup:true}));
 ids.push(await customer(db,{email:'internal@example.com'}));
 const marked=await customer(db);await db.query('UPDATE core.customers SET is_test=true WHERE id=$1',[marked]);ids.push(marked);
 for(const id of ids){await as(db,'service_role');assert.equal((await rpc(db,'klaviyo_profile_sync_enqueue_v1',[business,'acct_fixture',100,id])).enqueued,0);}
 const good=await customer(db);const job=await start(db,good);
 await as(db,'postgres');await db.query("UPDATE core.customers SET email_status='unsubscribed',email_suppressed_at=clock_timestamp() WHERE id=$1",[good]);
 await as(db,'service_role');assert.deepEqual(await rpc(db,'klaviyo_profile_sync_context_v1',[job.jobId,job.leaseId]),{eligible:false,reason:'customer_ineligible',status:'blocked'});
 await assert.rejects(finish(db,job,{status:'succeeded'}),sqlerror('22023'));
});

test('payload revision invalidates old lease and gets new fingerprint; stale completion rejected',async t=>{
 const {db}=await fixture(t);const id=await customer(db);const job=await start(db,id);
 const before=await rpc(db,'klaviyo_profile_sync_context_v1',[job.jobId,job.leaseId]);
 await as(db,'postgres');await db.query("UPDATE core.customers SET name='Changed fixture' WHERE id=$1",[id]);
 await as(db,'service_role');assert.deepEqual(await rpc(db,'klaviyo_profile_sync_context_v1',[job.jobId,job.leaseId]),{eligible:false,reason:'payload_changed',status:'queued'});
 await assert.rejects(finish(db,job,{status:'succeeded'}),sqlerror('22023'));
 const second=await rpc(db,'klaviyo_profile_sync_claim_v1',[business,'acct_fixture',id]);
 const after=await rpc(db,'klaviyo_profile_sync_context_v1',[second.jobId,second.leaseId]);
 assert.notEqual(before.fingerprint,after.fingerprint);assert.equal(second.jobId,job.jobId);assert.equal(second.attempt,1);
 assert.equal((await finish(db,second,{status:'succeeded'})).status,'succeeded');
});

test('expired leases recover unknown writes with stable key and bounded six attempts',async t=>{
 const {db}=await fixture(t);const id=await customer(db);let job=await start(db,id);let key;
 for(let attempt=1;attempt<=6;attempt++){
  assert.equal(job.attempt,attempt);
  const context=await rpc(db,'klaviyo_profile_sync_context_v1',[job.jobId,job.leaseId]);
  if(key)assert.equal(context.idempotencyKey,key);key=context.idempotencyKey;
  await as(db,'postgres');await db.query("UPDATE core.klaviyo_profile_sync_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job.jobId]);
  await as(db,'service_role');await assert.rejects(finish(db,job,{status:'succeeded'}),sqlerror('22023'));
  const next=await rpc(db,'klaviyo_profile_sync_claim_v1',[business,'acct_fixture',id]);
  if(attempt<6){assert.ok(next);assert.notEqual(next.leaseId,job.leaseId);job=next;}else assert.equal(next,null);
 }
 await as(db,'postgres');const row=(await db.query('SELECT status,attempts,last_error_code FROM core.klaviyo_profile_sync_jobs')).rows[0];
 assert.deepEqual(row,{status:'failed',attempts:6,last_error_code:'attempts_exhausted'});
});

test('retry scheduling is bounded; safe outcomes reject raw error bodies and invalid fields',async t=>{
 const {db}=await fixture(t);const id=await customer(db);const job=await start(db,id);
 for(const outcome of [{status:'retry',errorCode:'customer@example.com'}, {status:'retry',errorCode:'provider_network',message:'raw'},
  {status:'retry',errorCode:'provider_network',retryAfterSeconds:90000},{status:'succeeded',providerStatus:'confirmed'},
  {status:'provider_blocked',providerStatus:'confirmed'},{status:'retry',errorCode:'provider_network',retryAfterSeconds:-1}]){
  await assert.rejects(finish(db,job,outcome),sqlerror('22023'));
 }
 assert.equal((await finish(db,job,{status:'retry',errorCode:'unknown_write',retryAfterSeconds:120})).status,'retry');
 assert.equal(await rpc(db,'klaviyo_profile_sync_claim_v1',[business,'acct_fixture',id]),null);
 await as(db,'postgres');const row=(await db.query("SELECT last_error_code,next_attempt_at>clock_timestamp()+interval '110 seconds' AS delayed FROM core.klaviyo_profile_sync_jobs")).rows[0];
 assert.equal(row.last_error_code,'unknown_write');assert.equal(row.delayed,true);
});

test('provider unsubscribe is recorded atomically through sanctioned RPC and K4 prevents re-subscription',async t=>{
 const {db}=await fixture(t);const id=await customer(db);const job=await start(db,id);
 assert.equal((await finish(db,job,{status:'provider_blocked',providerStatus:'unsubscribed'})).status,'blocked');
 await as(db,'postgres');const state=(await db.query('SELECT email_status,email_suppressed_at IS NOT NULL AS blocked FROM core.customers WHERE id=$1',[id])).rows[0];
 assert.deepEqual(state,{email_status:'unsubscribed',blocked:true});
 const event=(await db.query("SELECT event_type,source FROM core.consent_events WHERE customer_id=$1",[id])).rows[0];
 assert.deepEqual(event,{event_type:'suppression',source:'klaviyo_readback'});
 await assert.rejects(db.query("UPDATE core.customers SET email_status='subscribed',email_suppressed_at=NULL WHERE id=$1",[id]),sqlerror('42501'));
 await as(db,'service_role');assert.equal((await rpc(db,'klaviyo_profile_sync_enqueue_v1',[business,'acct_fixture',100,id])).enqueued,0);
});

test('configured account/customer filters cannot claim a different queued customer',async t=>{
 const {db}=await fixture(t);const one=await customer(db);const two=await customer(db);
 await as(db,'service_role');await rpc(db,'klaviyo_profile_sync_enqueue_v1',[business,'acct_fixture',100,one]);
 assert.equal(await rpc(db,'klaviyo_profile_sync_claim_v1',[business,'acct_fixture',two]),null);
 assert.equal(await rpc(db,'klaviyo_profile_sync_claim_v1',[business,'other_account',one]),null);
 await assert.rejects(rpc(db,'klaviyo_profile_sync_enqueue_v1',[business,'acct_fixture',100,randomUUID()]),sqlerror('22023'));
 assert.ok(await rpc(db,'klaviyo_profile_sync_claim_v1',[business,'acct_fixture',one]));
});

test('small collection limit prioritizes new/changed profiles over unchanged successes',async t=>{
 const {db}=await fixture(t);const one=await customer(db);let job=await start(db,one);
 await finish(db,job,{status:'succeeded'});const two=await customer(db);
 await as(db,'service_role');assert.equal((await rpc(db,'klaviyo_profile_sync_enqueue_v1',[business,'acct_fixture',1])).enqueued,1);
 job=await rpc(db,'klaviyo_profile_sync_claim_v1',[business,'acct_fixture',two]);assert.ok(job);
 await finish(db,job,{status:'succeeded'});
 await as(db,'postgres');await db.query("UPDATE core.customers SET name='Changed older profile' WHERE id=$1",[one]);
 await as(db,'service_role');assert.equal((await rpc(db,'klaviyo_profile_sync_enqueue_v1',[business,'acct_fixture',1])).enqueued,1);
 assert.ok(await rpc(db,'klaviyo_profile_sync_claim_v1',[business,'acct_fixture',one]));
});

test('context fingerprint is timezone-stable and finish cannot undo a later local suppression',async t=>{
 const {db}=await fixture(t);const id=await customer(db);const job=await start(db,id);
 const before=await rpc(db,'klaviyo_profile_sync_context_v1',[job.jobId,job.leaseId]);
 await db.exec("SET TIME ZONE 'America/Los_Angeles'");
 const after=await rpc(db,'klaviyo_profile_sync_context_v1',[job.jobId,job.leaseId]);
 assert.equal(after.fingerprint,before.fingerprint);assert.equal(after.profile.createdAt,before.profile.createdAt);
 await as(db,'postgres');await db.query("UPDATE core.customers SET email_status='unsubscribed',email_suppressed_at=clock_timestamp() WHERE id=$1",[id]);
 await as(db,'service_role');assert.equal((await finish(db,job,{status:'succeeded'})).status,'blocked');
 await as(db,'postgres');assert.equal((await db.query('SELECT email_status FROM core.customers WHERE id=$1',[id])).rows[0].email_status,'unsubscribed');
});

test('negative provider suppression is fail-closed while already stored provider block is never queued',async t=>{
 const {db}=await fixture(t);const one=await customer(db);const job=await start(db,one);
 assert.equal((await finish(db,job,{status:'provider_blocked',providerStatus:'suppressed'})).status,'blocked');
 await as(db,'postgres');assert.equal((await db.query('SELECT blocked_status FROM core.klaviyo_email_observations WHERE customer_id=$1',[one])).rows[0].blocked_status,'suppressed');
 const two=await customer(db);
 await db.query("INSERT INTO core.klaviyo_email_observations(customer_id,status,checked_at,blocked_status,blocked_at) VALUES($1,'confirmed',clock_timestamp(),'suppressed',clock_timestamp())",[two]);
 await as(db,'service_role');assert.equal((await rpc(db,'klaviyo_profile_sync_enqueue_v1',[business,'acct_fixture',100,two])).enqueued,0);
});

test('profile identity changes requeue without applying the old address negative to a new identity',async t=>{
 const {db}=await fixture(t);const id=await customer(db);const job=await start(db,id);
 await as(db,'postgres');await db.query("UPDATE core.customers SET email='new-identity@fixture.test' WHERE id=$1",[id]);
 await as(db,'service_role');assert.equal((await finish(db,job,{status:'provider_blocked',providerStatus:'unsubscribed'})).status,'queued');
 await as(db,'postgres');assert.equal((await db.query('SELECT email_status FROM core.customers WHERE id=$1',[id])).rows[0].email_status,'subscribed');
 assert.equal((await db.query('SELECT count(*)::int AS n FROM core.consent_events WHERE customer_id=$1',[id])).rows[0].n,0);
});

test('unknown signup UTM stays null while explicitly stored empty UTM stays known empty',async t=>{
 const {db}=await fixture(t);const id=await customer(db);
 const payload=async()=>((await db.query('SELECT core.klaviyo_profile_sync_payload_v1($1,$2) AS p',[business,id])).rows[0].p);
 assert.equal((await payload()).utm,null);
 await db.query("INSERT INTO core.signups(business_id,customer_id,source,fingerprint,utm) VALUES($1,$2,'website_vip_page',$3,'null'::jsonb)",[business,id,id]);
 assert.equal((await payload()).utm,null);
 await db.query("UPDATE core.signups SET utm='{}'::jsonb WHERE customer_id=$1",[id]);
 assert.deepEqual((await payload()).utm,{});
 await db.query("UPDATE core.signups SET utm='[]'::jsonb WHERE customer_id=$1",[id]);
 assert.equal((await payload()).utm,null);
});
