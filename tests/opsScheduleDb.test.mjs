import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';

// The actual migration/functions execute in isolated PostgreSQL (PGlite).
// pg_cron, pg_net and Vault APIs are private SQL stubs here, NOT live extensions.
const installed=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite').catch(error=>{
 if(process.env.PGLITE_MODULE||error.code!=='ERR_MODULE_NOT_FOUND')throw error;return null;
});
const PGlite=installed?.PGlite;
const skip=!PGlite?'Set PGLITE_MODULE to run isolated scheduler SQL tests.':false;
const business='a358eba4-b197-4309-805b-46f43a718454',staff='11111111-1111-4111-8111-111111111111';
const scheduleSql=await fs.readFile(new URL('../supabase/migrations/20261019_ops_schedule.sql',import.meta.url),'utf8');
const baseSql=await fs.readFile(new URL('../supabase/migrations/20261018_ops_panel.sql',import.meta.url),'utf8');
const secret='f'.repeat(64);
const jwt=(claims={})=>['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({role:'anon',ref:'khgczybubufouraqyrcj',exp:Math.floor(Date.now()/1000)+86400,...claims})).toString('base64url'),'syntheticSignature'].join('.');

async function fixture(){
 const db=new PGlite();
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE SCHEMA core;CREATE SCHEMA auth;CREATE SCHEMA storage;CREATE SCHEMA cron;CREATE SCHEMA net;CREATE SCHEMA vault;
 CREATE TABLE core.installation(declared_project_ref text);INSERT INTO core.installation VALUES('khgczybubufouraqyrcj');
 CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES('${staff}');
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE TABLE core.crm_staff(auth_user_id uuid,active boolean);INSERT INTO core.crm_staff VALUES('${staff}',true);
 CREATE FUNCTION public.crm_staff_authorized_v1() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$SELECT EXISTS(SELECT 1 FROM core.crm_staff WHERE auth_user_id=auth.uid() AND active)$$;
 CREATE TABLE core.business_settings(business_id uuid PRIMARY KEY,baseline_monthly numeric,commission_rate numeric);
 CREATE TABLE core.commissions(business_id uuid,period_month date,qualified_sales numeric,baseline numeric,refunds numeric,qicr numeric,rate numeric,commission_amount numeric,computed_at timestamptz,UNIQUE(business_id,period_month));
 CREATE TABLE core.signups(business_id uuid,is_test boolean,processed boolean,created_at timestamptz);
 CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid(),bucket_id text,name text);ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
 CREATE TABLE vault.decrypted_secrets(name text,decrypted_secret text);
 CREATE TABLE cron.job(jobid bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,jobname text UNIQUE,schedule text,command text,database text DEFAULT current_database(),username text DEFAULT current_user,active boolean NOT NULL DEFAULT true);
 CREATE FUNCTION cron.schedule(p_name text,p_schedule text,p_command text) RETURNS bigint LANGUAGE plpgsql AS $$DECLARE id bigint;BEGIN INSERT INTO cron.job(jobname,schedule,command)VALUES(p_name,p_schedule,p_command) ON CONFLICT(jobname) DO UPDATE SET schedule=excluded.schedule,command=excluded.command,active=true RETURNING jobid INTO id;RETURN id;END$$;
 CREATE FUNCTION cron.alter_job(p_jobid bigint,schedule text DEFAULT NULL,command text DEFAULT NULL,database text DEFAULT NULL,username text DEFAULT NULL,active boolean DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$BEGIN UPDATE cron.job j SET active=coalesce(alter_job.active,j.active) WHERE jobid=p_jobid;IF NOT FOUND THEN RAISE EXCEPTION 'Synthetic cron job not found';END IF;END$$;
 CREATE TABLE net.http_request_queue(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,url text,body jsonb,headers jsonb);
 CREATE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}',params jsonb DEFAULT '{}',headers jsonb DEFAULT '{}',timeout_milliseconds integer DEFAULT 5000) RETURNS bigint LANGUAGE plpgsql AS $$DECLARE id bigint;BEGIN INSERT INTO net.http_request_queue(url,body,headers)VALUES(url,body,headers)RETURNING net.http_request_queue.id INTO id;RETURN id;END$$;
 REVOKE ALL ON vault.decrypted_secrets,net.http_request_queue,cron.job FROM PUBLIC,anon,authenticated,service_role;
 SET cron.timezone='UTC';SET request.jwt.claim.sub='${staff}';`);
 await db.exec(baseSql);
 const rows=async(sql,args=[])=>(await db.query(sql,args)).rows;
 const value=async(sql,args=[])=>(await rows(sql,args))[0]?.data;
 const role=async(name)=>db.exec(`RESET ROLE;SET ROLE ${name}`);
 const credentials=async(token=jwt(),scheduleSecret=secret)=>{
  await db.exec('RESET ROLE;DELETE FROM vault.decrypted_secrets');
  await rows('INSERT INTO vault.decrypted_secrets VALUES($1,$2),($3,$4)',['nazar_ops_gateway_anon_jwt',token,'nazar_ops_schedule_secret',scheduleSecret]);
 };
 const status=()=>value('SELECT public.ops_schedule_status_v() data');
 const dailyKey=()=>value("SELECT core.ops_schedule_run_key((now() AT TIME ZONE 'America/New_York')::date)::text data");
 const activate=()=>db.exec("RESET ROLE;SELECT core.ops_set_schedule_enabled(true,'Synthetic reviewed Edge deployment');");
 const finish=(action,metrics=[],state='done')=>value('SELECT public.ops_finish_action($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) data',[action.id,action.claim_token,state,JSON.stringify({code:'synthetic_done'}),JSON.stringify(metrics),'[]']);
 return {db,rows,value,role,credentials,status,dailyKey,activate,finish};
}

test('optional schedule migration: inactive preparation, private credentials, actor isolation and atomic snapshot proof',{skip},async()=>{
 const {db,rows,value,role,credentials,status,dailyKey,activate,finish}=await fixture();
 try{
  await db.exec(scheduleSql);
  const job=(await rows('SELECT * FROM cron.job'))[0];
  assert.equal(job.jobname,'nazar-ops-collect');assert.equal(job.schedule,'0 10 * * *');assert.equal(job.active,false);
  assert.equal(job.command,'SELECT core.ops_dispatch_scheduled_collect();');
  assert.equal((await rows('SELECT count(*)::int n FROM net.http_request_queue'))[0].n,0,'migration must not dispatch once');
  assert.equal((await value('SELECT row_to_json(s) data FROM core.ops_schedule_settings s')).enabled,false);
  const key=await dailyKey();
  for(const name of ['anon','authenticated','service_role']){
   await role(name);await assert.rejects(()=>value('SELECT core.ops_schedule_credentials() data'));
   await assert.rejects(()=>value('SELECT core.ops_set_schedule_enabled(true,$1) data',['Synthetic reviewed Edge deployment']));
   await assert.rejects(()=>value('SELECT core.ops_dispatch_scheduled_collect() data'));
   await assert.rejects(()=>value('SELECT core.ops_finish_action_base($1,$2,$3,$4::jsonb) data',[crypto.randomUUID(),crypto.randomUUID(),'done','{}']));
   await assert.rejects(()=>rows('SELECT * FROM core.ops_schedule_settings'));
   if(name!=='service_role'){
    await assert.rejects(()=>value('SELECT public.ops_enqueue_scheduled_collect($1) data',[key]));
    await assert.rejects(status);
   }
  }
  await role('service_role');assert.deepEqual(await status(),{enabled:false,active:false,verified:false,runs_24h:0,failed_24h:0,last_failure_name:null,last_failure_at:null,secret_sha256:null});
  assert.equal(await value('SELECT public.ops_enqueue_scheduled_collect($1) data',[key]),null);
  await assert.rejects(activate,/readiness/);
  for(const token of [jwt({role:'service_role'}),jwt({ref:'wrongproject'}),jwt({exp:1}),'sb_publishable_synthetic']){
   await credentials(token);await assert.rejects(activate,/readiness/);
  }
  await credentials(jwt(),'not-64-hex');await assert.rejects(activate,/readiness/);
  await credentials();await activate();await role('service_role');
  assert.equal((await status()).verified,false,'activation alone is not snapshot proof');
  await assert.rejects(()=>value('SELECT public.ops_enqueue_scheduled_collect($1) data',[crypto.randomUUID()]),/daily key/);
  assert.equal(await value('SELECT public.ops_enqueue_scheduled_collect($1) data',[key]),null,'secret alone cannot mint an unqueued scheduled actor');
  // A real manual collection uses the same active-collect uniqueness gate.
  await role('authenticated');const manual=await value('SELECT public.ops_request_action($1,$2::jsonb) data',['collect',JSON.stringify({clientRequestId:crypto.randomUUID()})]);
  assert.equal(manual.actor_kind,'staff');assert.equal(manual.requested_by,staff);
  await role('service_role');assert.equal(await value('SELECT public.ops_enqueue_scheduled_collect($1) data',[key]),null);
  const manualClaim=await value('SELECT public.ops_claim_action($1,$2) data',[manual.id,staff]);await finish(manualClaim);
  assert.equal((await status()).runs_24h,0,'manual runs must not masquerade as scheduled runs');
  await role('authenticated');const failedManual=await value('SELECT public.ops_request_action($1,$2::jsonb) data',['collect',JSON.stringify({clientRequestId:crypto.randomUUID()})]);
  await role('service_role');const failedManualClaim=await value('SELECT public.ops_claim_action($1,$2) data',[failedManual.id,staff]);await finish(failedManualClaim,[],'failed');
  await role('authenticated');const retry=await value('SELECT public.ops_request_action($1,$2::jsonb) data',['retry_failed_job',JSON.stringify({clientRequestId:crypto.randomUUID(),actionId:failedManual.id})]);
  await assert.rejects(()=>value('SELECT public.ops_request_action($1,$2::jsonb) data',['collect',JSON.stringify({clientRequestId:crypto.randomUUID()})]),/duplicate key/);
  await role('service_role');assert.equal(await value('SELECT public.ops_enqueue_scheduled_collect($1) data',[key]),null,'retry also shares collection mutex');
  const retryClaim=await value('SELECT public.ops_claim_action($1,$2) data',[retry.id,staff]);await finish(retryClaim);
  await db.exec('RESET ROLE');const requestId=await value('SELECT core.ops_dispatch_scheduled_collect() data');assert.equal(typeof requestId,'number');
  assert.equal(await value('SELECT core.ops_dispatch_scheduled_collect() data'),null,'no second HTTP dispatch for same NY day');
  const queued=(await rows('SELECT * FROM net.http_request_queue'))[0];
  assert.equal(queued.url,'https://khgczybubufouraqyrcj.supabase.co/functions/v1/ops-collect');
  assert.deepEqual(queued.body,{scheduledCollect:true,runKey:key});
  assert.equal(queued.headers['x-nazar-ops-schedule-secret'],secret);
  assert.equal('Origin' in queued.headers,false);
  assert.equal(queued.headers.apikey.split('.')[1],queued.headers.Authorization.slice(7).split('.')[1]);
  await role('service_role');assert.equal((await status()).verified,false,'HTTP queued is never collection success');
  await db.exec("RESET ROLE;UPDATE core.ops_schedule_dispatches SET queued_at=now()-interval '11 minutes'");
  await role('service_role');assert.equal(await value('SELECT public.ops_enqueue_scheduled_collect($1) data',[key]),null,'expired transport receipt cannot start a scheduled action');
  await db.exec('RESET ROLE;UPDATE core.ops_schedule_dispatches SET queued_at=now()');await role('service_role');
  const scheduled=await value('SELECT public.ops_enqueue_scheduled_collect($1) data',[key]);
  assert.equal(scheduled.actor_kind,'scheduler');assert.equal(scheduled.requested_by,null);assert.equal(scheduled.action,'collect');assert.equal(typeof scheduled.claim_token,'string');
  assert.equal(await value('SELECT public.ops_enqueue_scheduled_collect($1) data',[key]),null);
  assert.equal(await value('SELECT public.ops_claim_action($1,$2) data',[scheduled.id,staff]),null);
  await db.exec('RESET ROLE');
  const replayPayload=JSON.stringify({clientRequestId:key});
  await rows("UPDATE core.ops_actions SET request_fingerprint=md5('collect'||$1::jsonb::text) WHERE id=$2",[replayPayload,scheduled.id]);
  await role('authenticated');await assert.rejects(()=>value('SELECT public.ops_request_action($1,$2::jsonb) data',['collect',replayPayload]),/Conflicting request key/);
  // Key derivation is calendar-stable even when a connection uses another DateStyle.
  await db.exec("RESET ROLE;SET DateStyle='SQL,DMY'");assert.equal(await dailyKey(),key);await db.exec("SET DateStyle='ISO,MDY'");
  await role('authenticated');const safe=(await value('SELECT public.ops_actions_v() data')).items.find(a=>a.id===scheduled.id);
  assert.equal(safe.actor_kind,'scheduler');assert.equal(safe.requested_by,null);assert.equal('claim_token' in safe,false);assert.equal('payload' in safe,false);
  assert.equal(JSON.stringify(safe).includes(secret),false);
  await db.exec('RESET ROLE');await assert.rejects(()=>rows("UPDATE core.ops_actions SET actor_kind='staff',requested_by=$1 WHERE id=$2",[staff,scheduled.id]),/immutable/);
  await role('service_role');const stamp=new Date().toISOString();
  const metrics=[{source:'site',metric:'http_status',value_num:200,value_text:null,period_start:null,period_end:null,collected_at:stamp,collector:'edge_fn',is_test:false}];
  assert.equal(await finish(scheduled,metrics),true);assert.equal(await finish(scheduled,metrics),false);
  assert.deepEqual(await status(),{enabled:true,active:true,verified:true,runs_24h:1,failed_24h:0,last_failure_name:null,last_failure_at:null,secret_sha256:createHash('sha256').update(secret).digest('hex')});
  await db.exec('RESET ROLE');assert.equal((await rows('SELECT metric_count FROM core.ops_scheduled_snapshots'))[0].metric_count,1);
  assert.deepEqual((await rows('SELECT payload FROM core.ops_actions WHERE id=$1',[scheduled.id]))[0].payload,{});
  await rows("UPDATE core.ops_scheduled_snapshots SET snapshot_at=now()-interval '37 hours' WHERE action_id=$1",[scheduled.id]);
  await role('service_role');assert.equal((await status()).verified,false,'stale proof must not keep the tile connected');
  await db.exec('RESET ROLE');await rows('UPDATE core.ops_scheduled_snapshots SET snapshot_at=now() WHERE action_id=$1',[scheduled.id]);
  await db.exec("UPDATE core.ops_connections SET status='connected' WHERE source='scheduler'");await activate();await role('service_role');
  assert.equal((await status()).verified,false,'re-activation requires a new snapshot from this activation');
  await db.exec('RESET ROLE');assert.equal((await rows("SELECT status FROM core.ops_connections WHERE source='scheduler'"))[0].status,'not_connected');
  await credentials(jwt(),'e'.repeat(64));await role('service_role');assert.equal((await status()).verified,false,'credential rotation invalidates old proof');
  await activate();await role('service_role');assert.equal((await status()).verified,false,'re-activation cannot reuse proof from former secret');
  await db.exec("RESET ROLE;UPDATE core.ops_connections SET status='connected' WHERE source='scheduler';SELECT core.ops_set_schedule_enabled(false);");
  assert.equal((await rows("SELECT status FROM core.ops_connections WHERE source='scheduler'"))[0].status,'not_connected');await role('service_role');
  assert.equal((await status()).enabled,false);assert.equal((await status()).active,false);
  assert.equal(await value('SELECT public.ops_enqueue_scheduled_collect($1) data',[key]),null);
  await db.exec('RESET ROLE');assert.equal(await value('SELECT core.ops_dispatch_scheduled_collect() data'),null);
 }finally{await db.close();}
});

test('prepared schedule fails closed for existing named job, non-UTC cron or exposed request headers',{skip},async()=>{
 for(const reason of ['existing','timezone','privacy']){
  const {db}=await fixture();
  try{
   if(reason==='existing')await db.exec("SELECT cron.schedule('nazar-ops-collect','1 1 * * *','SELECT 42;')");
   if(reason==='timezone')await db.exec("SET cron.timezone='America/New_York'");
   if(reason==='privacy')await db.exec('GRANT SELECT ON net.http_request_queue TO authenticated');
   await assert.rejects(()=>db.exec(scheduleSql),reason==='existing'?/will not be overwritten/:reason==='timezone'?/cron.timezone/:/headers/);
   await db.exec('ROLLBACK');
   if(reason==='existing')assert.equal((await db.query('SELECT command FROM cron.job')).rows[0].command,'SELECT 42;');
   assert.equal((await db.query("SELECT to_regclass('core.ops_schedule_settings') AS installed")).rows[0].installed,null);
  }finally{await db.close();}
 }
});

test('daily scheduled failed/no-metric outcomes never create proof; active job drift is gray',{skip},async()=>{
 const {db,rows,value,role,credentials,dailyKey,activate,finish,status}=await fixture();
 try{
  await db.exec(scheduleSql);await credentials();await activate();const key=await dailyKey();await value('SELECT core.ops_dispatch_scheduled_collect() data');await role('service_role');
  const scheduled=await value('SELECT public.ops_enqueue_scheduled_collect($1) data',[key]);
  await finish(scheduled,[],'failed');
  const failed=await status();assert.equal(failed.runs_24h,1);assert.equal(failed.failed_24h,1);assert.equal(failed.last_failure_name,'collect');assert.equal(failed.verified,false);
  assert.equal(await value('SELECT public.ops_enqueue_scheduled_collect($1) data',[key]),null,'failed scheduled run is not silently repeated');
  await db.exec('RESET ROLE');assert.equal((await rows('SELECT count(*)::int n FROM core.ops_scheduled_snapshots'))[0].n,0);
  // A terminal row or cron success without a stored receipt cannot certify health.
  await rows("UPDATE core.ops_actions SET status='done' WHERE id=$1",[scheduled.id]);await role('service_role');assert.equal((await status()).verified,false);
  await db.exec("RESET ROLE;UPDATE cron.job SET schedule='0 11 * * *'");await role('service_role');assert.equal((await status()).active,false);
  await db.exec('RESET ROLE');assert.equal(await value('SELECT core.ops_dispatch_scheduled_collect() data'),null);
 }finally{await db.close();}
});

test('done without real stored source metrics does not certify scheduler health',{skip},async()=>{
 for(const metrics of [[],[{source:'scheduler',metric:'runs_24h',value_num:1,value_text:null,period_start:null,period_end:null,collected_at:new Date().toISOString(),collector:'edge_fn',is_test:false}]]){
  const {db,value,role,credentials,dailyKey,activate,finish,status}=await fixture();
  try{
   await db.exec(scheduleSql);await credentials();await activate();const key=await dailyKey();await value('SELECT core.ops_dispatch_scheduled_collect() data');await role('service_role');
   const action=await value('SELECT public.ops_enqueue_scheduled_collect($1) data',[key]);
   assert.equal(await finish(action,metrics),true);assert.equal((await status()).verified,false);
  }finally{await db.close();}
 }
});
