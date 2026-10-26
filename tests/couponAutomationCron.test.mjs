// Owned native PostgreSQL18.6 + real application baseline/consumer DDL.
// pg_cron/pg_net/Vault are explicit synthetic mocks; no real HTTP or secret.
import test,{after} from 'node:test';import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';import {join} from 'node:path';import {createHmac,createHash,randomUUID} from 'node:crypto';
import {fixture,repo} from './fixtures/customerTestClassificationNative.mjs';
import {verifyCouponAutomation} from '../functions/_lib/couponAutomationAuth.ts';
const h=await fixture({currentCouponSchema:true});after(()=>h.stop());const q=h.literal,B=h.business;
await h.sql(await readFile(join(repo,'supabase/migrations/20261024000200_coupon_first_event_bootstrap.sql'),'utf8'));
await h.sql(await readFile(join(repo,'tools/test-env/welcome-automation/forward-candidate.sql'),'utf8'));
const candidate=await readFile(join(repo,'tools/test-env/welcome-automation/cron-candidate.sql'),'utf8');
h.sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
 CREATE SCHEMA cron;CREATE TABLE cron.job(jobid bigserial PRIMARY KEY,jobname text UNIQUE,schedule text,command text,active boolean NOT NULL DEFAULT true);
 CREATE FUNCTION cron.schedule(job_name text,schedule text,command text) RETURNS bigint LANGUAGE plpgsql AS $$DECLARE i bigint;BEGIN INSERT INTO cron.job(jobname,schedule,command) VALUES($1,$2,$3) RETURNING jobid INTO i;RETURN i;END$$;
 CREATE FUNCTION cron.alter_job(job_id bigint,active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS $$UPDATE cron.job SET active=$2 WHERE jobid=$1$$;
 CREATE SCHEMA vault;CREATE TABLE vault.decrypted_secrets(name text,decrypted_secret text);
 CREATE SCHEMA net;CREATE TABLE net.synthetic_requests(id bigserial PRIMARY KEY,url text,body jsonb,params jsonb,headers jsonb,timeout_milliseconds integer);
 CREATE TABLE net.synthetic_control(mode text);INSERT INTO net.synthetic_control VALUES('ok');
 CREATE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,timeout_milliseconds integer DEFAULT 2000) RETURNS bigint LANGUAGE plpgsql AS $$DECLARE i bigint;BEGIN
 IF (SELECT mode FROM net.synthetic_control)='error' THEN RAISE EXCEPTION 'SYNTHETIC_NET_FAILURE';END IF;
 INSERT INTO net.synthetic_requests(url,body,params,headers,timeout_milliseconds) VALUES($1,$2,$3,$4,$5) RETURNING id INTO i;
 IF (SELECT mode FROM net.synthetic_control)='null' THEN RETURN NULL;END IF;RETURN i;END$$;`);
const before=h.sql('SELECT jsonb_build_object(\'settings\',(SELECT count(*) FROM core.coupon_automation_settings),\'runs\',(SELECT count(*) FROM core.coupon_automation_runs))');
h.sql(candidate);
// Synthetic installation identity only, in the verified owned loopback cluster.
h.sql("UPDATE core.installation SET declared_project_ref='abcdefghijklmnopqrst'");
const tick=()=>h.sql('SELECT core.coupon_automation_cron_tick_v1()');
const queued=()=>h.sql('SELECT count(*) FROM net.synthetic_requests');
const clear=()=>h.sql(`TRUNCATE net.synthetic_requests;UPDATE core.coupon_automation_cron_targets SET last_enqueued_minute=NULL,last_run_id=NULL,last_request_id=NULL;UPDATE net.synthetic_control SET mode='ok'`);
const endpoint='https://abcdefghijklmnopqrst.supabase.co/functions/v1/coupon-welcome-run',secret='synthetic_cron_signing_secret_12345678901234567890';
const keys=()=>h.sql(`TRUNCATE vault.decrypted_secrets;INSERT INTO vault.decrypted_secrets VALUES('COUPON_AUTOMATION_SIGNING_SECRET',${q(secret)}),('COUPON_AUTOMATION_EDGE_URL',${q(endpoint)})`);
async function concurrentTick(){
 assert.equal(h.identity.host,'127.0.0.1');
 const bin=process.env.CUSTOMER_MARKER_PG_BIN||join(process.env.USERPROFILE,'scoop/apps/postgresql/18.6-4/bin');
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','COMSPEC','PATHEXT'].includes(k.toUpperCase())));
 return new Promise((resolve,reject)=>{
  const child=spawn(join(bin,'psql.exe'),['-X','-q','-w','-h','127.0.0.1','-p',String(h.identity.port),'-U','postgres','-d',h.identity.database,'-v','ON_ERROR_STOP=1','-At'],{windowsHide:true,env:{...env,PGCONNECT_TIMEOUT:'2',PGCLIENTENCODING:'UTF8',PGPASSFILE:join(repo,'nonexistent-cron-test-password-file')},stdio:['pipe','pipe','pipe']});
  let text='';child.stdout.on('data',d=>{text+=d;});child.stderr.resume();child.on('error',()=>reject(Error('local_synthetic_psql_spawn_failed')));child.on('close',code=>{if(code!==0)return reject(Error('local_synthetic_psql_failed'));try{resolve(JSON.parse(text.trim()));}catch{reject(Error('local_synthetic_result_invalid'));}});
  child.stdin.end('SELECT core.coupon_automation_cron_tick_v1();');
 });
}
const proofs=[];function check(name,fn){test(name,async()=>{await fn();proofs.push(name);});}
check('apply installs inactive exact normal cron, zero target rows, zero network and no consumer settings seed',()=>{
 assert.deepEqual(h.sql('SELECT jsonb_build_object(\'settings\',(SELECT count(*) FROM core.coupon_automation_settings),\'runs\',(SELECT count(*) FROM core.coupon_automation_runs))'),before);
 const job=h.sql("SELECT jsonb_build_object('active',active,'name',jobname,'schedule',schedule,'command',command) FROM cron.job WHERE jobname='coupon-automation-normal'");
 assert.equal(job.active,false);assert.equal(job.schedule,'* * * * *');assert.equal(job.command,'SELECT core.coupon_automation_cron_tick_v1();');assert.equal(queued(),0);
 assert.equal(h.sql('SELECT count(*) FROM core.coupon_automation_cron_targets'),0);
});
check('default off returns before touching even missing Vault relation',()=>{
 h.sql('ALTER TABLE vault.decrypted_secrets RENAME TO synthetic_vault_unavailable');try{assert.equal(tick().queued,0);assert.equal(queued(),0);}finally{h.sql('ALTER TABLE vault.synthetic_vault_unavailable RENAME TO decrypted_secrets');}
});
check('no extra table/function execution grants for anon/authenticated/service role',()=>{
 for(const role of ['anon','authenticated','service_role']){
  assert.equal(h.sql(`SELECT has_function_privilege(${q(role)},'core.coupon_automation_cron_tick_v1()','EXECUTE')`),false);
  assert.equal(h.sql(`SELECT has_table_privilege(${q(role)},'core.coupon_automation_cron_targets','SELECT')`),false);
  const r=h.raw('SELECT core.coupon_automation_cron_tick_v1()',{role});assert.notEqual(r.status,0);assert.equal(queued(),0);
 }
});
check('canonical JSON byteexact with JS over UUID/int fields; no jsonb whitespace',()=>{
 for(const issued of [1,1793052000,2147483647]){
  const run=randomUUID();const actual=h.sql(`SELECT to_jsonb(core.coupon_automation_cron_canonical_v1('${B}','${run}',${issued}))`);
  assert.equal(actual,JSON.stringify(['coupon.automation.v1',1,B,run,issued]));
 }
});
check('normal setting remains false by default, independent cron target false gate',()=>{
 h.sql(`INSERT INTO core.coupon_automation_settings(business_id) VALUES('${B}');INSERT INTO core.coupon_automation_cron_targets(business_id) VALUES('${B}')`);
 assert.equal(tick().queued,0);h.sql(`UPDATE core.coupon_automation_cron_targets SET enabled=true WHERE business_id='${B}'`);assert.equal(tick().queued,0);
 h.sql(`UPDATE core.coupon_automation_settings SET enabled=true,review_ref='synthetic-reviewed-only' WHERE business_id='${B}';UPDATE core.coupon_automation_cron_targets SET enabled=false WHERE business_id='${B}'`);assert.equal(tick().queued,0);assert.equal(queued(),0);
});
check('only explicit synthetic enable reaches Vault; missing key remains zero network',()=>{
 h.sql(`UPDATE core.coupon_automation_cron_targets SET enabled=true WHERE business_id='${B}'`);assert.equal(tick().code,'cron_configuration_unconfirmed');assert.equal(queued(),0);
});
check('malformed singleton installation identity cannot enqueue',()=>{
 h.sql("UPDATE core.installation SET declared_project_ref='not-a-project-ref'");try{assert.equal(tick().code,'cron_installation_unconfirmed');assert.equal(queued(),0);}finally{h.sql("UPDATE core.installation SET declared_project_ref='abcdefghijklmnopqrst'");}
});
check('duplicate installation rows fail closed even when project refs agree',()=>{
 h.sql("INSERT INTO core.installation(version,declared_project_ref) VALUES('synthetic-cron-duplicate','abcdefghijklmnopqrst')");try{assert.equal(tick().code,'cron_installation_unconfirmed');assert.equal(queued(),0);}finally{h.sql("DELETE FROM core.installation WHERE version='synthetic-cron-duplicate'");}
});
check('duplicate key names and invalid secret format do not enqueue',()=>{
 keys();h.sql(`INSERT INTO vault.decrypted_secrets VALUES('COUPON_AUTOMATION_SIGNING_SECRET','synthetic_duplicate')`);assert.equal(tick().queued,0);
 keys();h.sql("UPDATE vault.decrypted_secrets SET decrypted_secret='short' WHERE name='COUPON_AUTOMATION_SIGNING_SECRET'");assert.equal(tick().queued,0);assert.equal(queued(),0);
});
for(const bad of ['https://zyxwvutsrqponmlkjihg.supabase.co/functions/v1/coupon-welcome-run','https://trap.invalid/functions/v1/coupon-welcome-run','http://abcdefghijklmnopqrst.supabase.co/functions/v1/coupon-welcome-run','https://abcdefghijklmnopqrst.supabase.co/functions/v1/coupon-bootstrap','https://abcdefghijklmnopqrst.supabase.co/functions/v1/coupon-welcome-run?secret=not-real','https://user@abcdefghijklmnopqrst.supabase.co/functions/v1/coupon-welcome-run'])check('invalid target rejected without net '+bad,()=>{
 keys();h.sql(`UPDATE vault.decrypted_secrets SET decrypted_secret=${q(bad)} WHERE name='COUPON_AUTOMATION_EDGE_URL'`);assert.equal(tick().queued,0);assert.equal(queued(),0);
});
check('one mocked net enqueue contains exact current signed machine body; HMAC accepted and stale rejected',async()=>{
 keys();clear();const start=Date.now();assert.equal(tick().queued,1);assert.equal(queued(),1);
 const wire=h.sql('SELECT jsonb_build_object(\'url\',url,\'body\',body,\'headers\',headers,\'params\',params,\'timeout\',timeout_milliseconds) FROM net.synthetic_requests ORDER BY id DESC LIMIT 1');
 assert.equal(wire.url,endpoint);assert.deepEqual(Object.keys(wire.body).sort(),['businessId','issuedAt','runId','version']);assert.equal(wire.body.businessId,B);assert.equal(wire.body.version,1);assert.match(wire.body.runId,/^[a-f0-9-]{36}$/);assert.ok(Math.abs(wire.body.issuedAt-start/1000)<3);
 assert.deepEqual(Object.keys(wire.headers).sort(),['Content-Type','X-Coupon-Automation-Signature']);assert.equal(wire.headers['Content-Type'],'application/json');assert.deepEqual(wire.params,{});assert.equal(wire.timeout,180000);
 const canonical=JSON.stringify(['coupon.automation.v1',1,B,wire.body.runId,wire.body.issuedAt]);const expected=createHmac('sha256',secret).update(canonical).digest('hex');assert.equal(wire.headers['X-Coupon-Automation-Signature'],expected);
 assert.equal(await verifyCouponAutomation(wire.body,expected,secret,wire.body.issuedAt*1000),true);assert.equal(await verifyCouponAutomation(wire.body,expected,secret,(wire.body.issuedAt+60)*1000),true);assert.equal(await verifyCouponAutomation(wire.body,expected,secret,(wire.body.issuedAt+61)*1000),false);
 assert.doesNotMatch(JSON.stringify(wire),/synthetic_cron_signing_secret|COUPON_PROCESS_KEY|Authorization/);
 assert.equal(h.sql('SELECT count(*) FROM core.coupon_automation_runs'),0); // Only Edge starts/claims; cron did not bypass it.
});
check('same-minute duplicate tick does not enqueue again',()=>{assert.equal(tick().queued,0);assert.equal(queued(),1);});
check('same-minute concurrent sessions cannot enqueue target twice',async()=>{
 clear();const result=await Promise.all([concurrentTick(),concurrentTick()]);assert.equal(result.reduce((s,r)=>s+r.queued,0),1);assert.equal(queued(),1);
});
check('future-minute marker clock rollback fails closed',()=>{
 clear();h.sql("UPDATE core.coupon_automation_cron_targets SET last_enqueued_minute=date_trunc('minute',clock_timestamp())+interval '1 minute'");assert.equal(tick().queued,0);assert.equal(queued(),0);
});
for(const mode of ['error','null'])check('mocked pgnet '+mode+' no partial target mark or queued HTTP and no raw error',()=>{
 clear();h.sql(`UPDATE net.synthetic_control SET mode='${mode}'`);const result=tick();assert.deepEqual(result,{code:'cron_enqueue_unconfirmed',queued:0});assert.equal(queued(),0);assert.equal(h.sql('SELECT last_run_id IS NULL FROM core.coupon_automation_cron_targets'),true);assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC|secret|http|profile/i);
});
check('missing consumer business setting cannot acquire a cron target',()=>{
 const r=h.raw(`INSERT INTO core.coupon_automation_cron_targets(business_id,enabled) VALUES('${randomUUID()}',true)`);assert.notEqual(r.status,0);assert.equal(queued(),0);
});
check('pause target stops future tick; no flags reopened or job auto-enabled by runtime',()=>{
 clear();h.sql('UPDATE core.coupon_automation_cron_targets SET enabled=false');assert.equal(tick().queued,0);assert.equal(queued(),0);assert.equal(h.sql("SELECT active FROM cron.job WHERE jobname='coupon-automation-normal'"),false);
});
check('candidate rerun cannot overwrite existing normal cron job',()=>{
 const count=h.sql('SELECT count(*) FROM cron.job');const result=h.raw(candidate);assert.notEqual(result.status,0);assert.equal(h.sql('SELECT count(*) FROM cron.job'),count);assert.equal(h.sql("SELECT active FROM cron.job WHERE jobname='coupon-automation-normal'"),false);
});
check('source carries root accepted pg_net redirect limitation and no enable/secret creation command',()=>{
 assert.match(candidate,/ROOT ARCHITECTURE DECISION \/ LIMITATION/);assert.match(candidate,/pg_net may follow redirects/);assert.doesNotMatch(candidate,/create_secret|update_secret|active\s*:=\s*true|COUPON_AUTOMATION_ENABLED\s*=\s*true/i);
});
after(async()=>{
 const dir=process.env.NORMAL_CRON_PROOF_DIR;if(dir){await mkdir(dir,{recursive:true});await writeFile(join(dir,'cron-synthetic-proof.json'),JSON.stringify({passed:proofs.length,scope:'native PG18.6 full baseline + actual consumer candidate; explicit mocked cron/net/Vault; not actual extension/HTTP acceptance',tests:proofs,pg_version:h.identity.version,networkCalls:0,realSecretsRead:false,cron_candidate_sha256:createHash('sha256').update(candidate).digest('hex'),scheduler_redirect_limitation_root_accepted:true},null,2)+'\n');}
});
