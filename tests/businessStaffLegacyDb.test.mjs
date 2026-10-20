// Full reviewed-baseline synthetic proof. Owned native PG18.6 loopback only.
// No inherited PG credentials, hosted URL, production data or provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync,spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,join,sep} from 'node:path';
import {fixture} from './fixtures/campaignEngineNative.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const legacyNames=['crm_add_note','crm_catering_decisions_v1','crm_catering_notification_status_v1',
 'crm_complete_task_v1','crm_create_task_v1','crm_customer_tasks_v1','crm_follow_up_queue_v1',
 'crm_form_errors_v1','crm_klaviyo_status_v1','crm_overview','crm_overview_v2','crm_record_catering_decision_v1',
 'crm_request_catering_decision_v1','crm_resolve_form_error_v1','crm_staff_authorized_v1','crm_update_catering',
 'crm_restore_email_consent_v1','list_offers','crm_profile_sync_queue_v1','ops_assert_staff','ops_actions_v',
 'ops_connections_v','ops_dashboard_v','ops_request_action','ops_claim_action','clover_order_match_queue_v1',
 'clover_order_day_totals_v1','clover_order_match_resolve_v1'];
const expectedHashes={
 'supabase/baselines/20261019_application_schema.sql':'f3583bb461ba8ae50dea04ae03d6c5c4dbe729aacdec1ed7dd57982b7e25d230',
 'supabase/migrations/20261019000100_test_record_markers.sql':'bd5100fbc165d9dffee77b1199d5e346c5b2611ae665c46f42608aaaa645de90',
 'supabase/migrations/20261019000200_suppression_consent_offers.sql':'a80a4ef10a81e86237f5cf208036e5ec84b8b230db6d48dd90b47014e04b712e',
 'supabase/migrations/20261019000300_klaviyo_profile_sync.sql':'d28672a87149839c71e44c72116ebbf3b96b2e76c7ec42a2a79c1f7b9f4fabc2',
 'supabase/migrations/20261020000100_ops_panel.sql':'3204eab72b8b0a9dc64eefc2f02d05ff0fde7a96489e010eb125896347007fa4',
 'supabase/migrations/20261020000700_clover_order_core.sql':'5f68772059d9cd1e1d7a6a290aa31ee32d10ff5a367201577c4058861aada4a8',
 'supabase/migrations/20261020000800_message_send_gate.sql':'a772efa90eed339e298c373af43e8090952da7f0cea8f8ecb06c68cbec11663c',
 'supabase/migrations/20261020000900_clover_optional_scope_status.sql':'a3778d0b933c4ce1a56dba04bcadc31b3f6d1c8f214d56af8203a88d6bcc826e',
 'supabase/migrations/20261021000100_clover_webhook.sql':'1d305756deba4b614c6e60198ef7c954bca9008bc944be7e4bea52f4ff29a94e',
};

test('full reviewed baseline: unified staff migration preserves contracts and enforces all legacy boundaries',async t=>{
 const h=await fixture();
 const workspace=resolve(h.repo,'../..');
 const evidence=resolve(workspace,'20_Yonetim/Teslim_Raporlari/K9_kanit/unified-scope');
 const run=resolve(evidence,'full-baseline-'+new Date().toISOString().replaceAll(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
 assert.ok(run.startsWith(evidence+sep));await mkdir(join(run,'applied-sql'),{recursive:true});
 const database='k9_full_'+randomUUID().replaceAll('-','').slice(0,12);
 const exe=name=>join(h.config.bin,name+(process.platform==='win32'?'.exe':''));
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','COMSPEC','PATHEXT'].includes(key.toUpperCase())));
 Object.assign(env,{PGCLIENTENCODING:'UTF8',PGCONNECT_TIMEOUT:'2',PGPASSFILE:join(run,'not-a-password-file'),
  PGOPTIONS:'-c statement_timeout=20000 -c lock_timeout=12000 -c app.ops_project_ref=local-k9-unified'});
 const common={env,windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024};
 const args=['-X','-q','-w','-h','127.0.0.1','-p',String(h.config.port),'-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-At'];
 const journal=[],checks=[];
 function command(name,params,input){const result=spawnSync(exe(name),params,{...common,input});
  if(result.status!==0)throw Error(name+': '+(result.stderr||result.stdout||result.error?.message));return result;}
 const raw=input=>command('psql',args,input);
 const json=input=>JSON.parse(raw(input).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
 const functions=()=>json(`SELECT COALESCE(json_agg(json_build_object('schema',n.nspname,'name',p.proname,
  'arguments',pg_get_function_identity_arguments(p.oid),'acl',p.proacl,'securityDefiner',p.prosecdef,
  'config',p.proconfig,'definition',pg_get_functiondef(p.oid),'md5',md5(pg_get_functiondef(p.oid))) ORDER BY n.nspname,p.proname),'[]'::json)
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('core','public')`);
 async function apply(relative,{external=null}={}){
  const path=external||join(h.repo,relative);const checkout=await readFile(path);
  // The reviewed dump is a -text immutable captured artifact with pinned mixed
  // endings. Apply its exact raw bytes. New/additive migrations remain LF-only.
  const capturedBaseline=relative==='supabase/baselines/20261019_application_schema.sql';
  const bytes=capturedBaseline?checkout:Buffer.from(checkout.toString('utf8').replaceAll('\r\n','\n'));
  if(expectedHashes[relative])assert.equal(sha(bytes),expectedHashes[relative],'canonical source hash '+relative);
  if(!capturedBaseline)assert.equal(bytes.includes(13),false,'LF-only applied SQL');
  const saved=join(run,'applied-sql',String(journal.length).padStart(2,'0')+'-'+relative.split('/').at(-1));
  await writeFile(saved,bytes);const result=command('psql',[...args,'-f',saved]);
  await writeFile(saved+'.output.txt',result.stdout+result.stderr);
  journal.push({path:relative,sourcePath:path,checkoutSha256:sha(checkout),appliedSha256:sha(bytes),canonicalPin:expectedHashes[relative]||null,
   LF:!bytes.includes(13),immutableCapturedBaselineBytes:capturedBaseline,scope:'owned local native PG18.6',stdoutFile:saved+'.output.txt'});
  await writeFile(join(run,'applied-manifest.json'),JSON.stringify(journal,null,2)+'\n');return result;
 }
 async function check(label,fn){await t.test(label,async()=>{await fn();checks.push({label,passed:true});});}
 try{
  assert.equal(h.config.host,'127.0.0.1');assert.match(h.config.scope,/OWNED_NATIVE_SYNTHETIC/);
  command('createdb',['-h','127.0.0.1','-p',String(h.config.port),'-U','postgres','-w',database]);
  const identity=json("SELECT json_build_object('host',host(inet_server_addr()),'port',inet_server_port(),'database',current_database(),'dataDirectory',current_setting('data_directory'),'serverVersion',current_setting('server_version'))");
  assert.equal(identity.host,'127.0.0.1');assert.equal(identity.port,h.config.port);assert.equal(identity.database,database);
  assert.equal(resolve(identity.dataDirectory),resolve(h.config.dataDirectory));assert.match(identity.serverVersion,/^18\.6\b/);
  await writeFile(join(run,'local-target.json'),JSON.stringify({...identity,ownedClusterNonce:h.config.nonce,hosted:false},null,2)+'\n');
  await apply('tests/fixtures/businessStaffLegacyPlatform.sql');
  await apply('supabase/baselines/20261019_application_schema.sql');
  await apply('tests/fixtures/businessStaffLegacyAfterDump.sql');
  for(const relative of Object.keys(expectedHashes).filter(path=>path.startsWith('supabase/migrations/')&&!path.includes('21000100'))){await apply(relative);}
  await apply('supabase/migrations/20261021000100_clover_webhook.sql',{external:join(workspace,'tmp/nazar-k7-order-core/supabase/migrations/20261021000100_clover_webhook.sql')});
  const before=functions();await writeFile(join(run,'functions-before.json'),JSON.stringify(before,null,2)+'\n');
  assert.equal(before.filter(f=>legacyNames.includes(f.name)).length,28);
  await apply('supabase/migrations/20261021000200_campaign_engine.sql');
  const after=functions();await writeFile(join(run,'functions-after.json'),JSON.stringify(after,null,2)+'\n');
  await check('all 28 reviewed legacy RPC definitions exist and use shared authorization',()=>{
   const rows=after.filter(f=>legacyNames.includes(f.name));assert.equal(rows.length,28);
   for(const row of rows){assert.doesNotMatch(row.definition,/core\.crm_staff\b/);assert.match(row.definition,/staff_authorized_v1|business_staff/);}
  });
  await check('all 28 existing ACL, SECURITY DEFINER and search_path contracts remain',()=>{
   for(const previous of before.filter(f=>legacyNames.includes(f.name))){const next=after.find(f=>f.schema===previous.schema&&f.name===previous.name);
    assert.deepEqual(next.acl,previous.acl,previous.name+' ACL');assert.equal(next.securityDefiner,previous.securityDefiner,previous.name+' SECURITY DEFINER');
    assert.deepEqual(next.config,previous.config,previous.name+' search_path');}
  });
  await check('all unrelated existing function MD5 definitions remain unchanged',()=>{
   for(const previous of before.filter(f=>!legacyNames.includes(f.name))){const next=after.find(f=>f.schema===previous.schema&&f.name===previous.name&&f.arguments===previous.arguments);
    assert.ok(next,previous.name);assert.equal(next.md5,previous.md5,previous.name+' definition MD5');assert.deepEqual(next.acl,previous.acl);}
  });
  await check('K4 evidence guard is intact and restore has target consent.restore gate',()=>{
   const restore=after.find(f=>f.name==='crm_restore_email_consent_v1').definition;
   assert.match(restore,/consent\.restore/);assert.match(restore,/staff_authorized_v1/);
   for(const name of ['guard_email_suppression_v1','reject_consent_evidence_mutation_v1'])
    assert.equal(after.find(f=>f.name===name).md5,before.find(f=>f.name===name).md5);
  });
  await check('K7 optional-scope report retains reconciliation evidence fields',()=>{
   const definition=after.find(f=>f.name==='clover_order_day_totals_v1').definition;
   for(const field of ['refundUnverifiedCount','customerAccessDeniedCount','reconciliationConfirmed'])assert.ok(definition.includes(field));
  });
  await check('all canonical baseline/migration bytes retain recorded pin evidence',()=>{
   for(const entry of journal.filter(entry=>entry.canonicalPin))assert.equal(entry.appliedSha256,entry.canonicalPin);
   assert.equal(journal.filter(entry=>entry.canonicalPin).length,9);
  });
  for(const relative of ['tests/fixtures/businessStaffLegacyAcceptance.sql','tests/fixtures/businessStaffLegacyPolicies.sql']){
   const result=await apply(relative);const labels=[...result.stderr.matchAll(/NOTICE:\s+PASS ([^\r\n]+)/g)].map(m=>m[1]);
   assert.ok(labels.length>=5,'functional SQL proof emits meaningful assertions');
   for(const label of labels)await check(label,()=>{});
  }
  await check('all synthetic acceptance mutations roll back',()=>{
   const data=json("SELECT json_build_object('customers',(SELECT count(*) FROM core.customers),'staff',(SELECT count(*) FROM core.business_staff),'messages',(SELECT count(*) FROM core.message_log),'jobs',(SELECT count(*) FROM core.klaviyo_profile_sync_jobs))");
   assert.deepEqual(data,{customers:0,staff:0,messages:0,jobs:0});
  });
  await check('manual setup script creates exactly two memberships and one platform mapping from verified synthetic Auth UUIDs',async()=>{
   const business=randomUUID(),talip=randomUUID(),yucel=randomUUID();
   raw(`INSERT INTO core.businesses(id,name,is_test) VALUES('${business}','Synthetic manual setup',true);
    INSERT INTO auth.users(id) VALUES('${talip}'),('${yucel}');`);
   const setupPath=join(h.repo,'docs/K9_STAFF_SCOPE_SETUP.sql'),setupBytes=await readFile(setupPath);
   const result=command('psql',[...args,'-v','business_id='+business,'-v','talip_staff_id='+talip,
    '-v','yucel_staff_id='+yucel,'-v','talip_role=owner','-f',setupPath]);
   assert.match(result.stdout,/t\|t/);
   const receipt=json(`SELECT json_build_object('memberships',(SELECT count(*) FROM core.business_staff WHERE business_id='${business}' AND active),
    'platformOperators',(SELECT count(*) FROM core.platform_operators WHERE staff_id='${talip}' AND active),
    'tenantOwner',(SELECT role='owner' FROM core.business_staff WHERE business_id='${business}' AND staff_id='${yucel}'),
    'tenantIsPlatform',(SELECT EXISTS(SELECT 1 FROM core.platform_operators WHERE staff_id='${yucel}')))`);
   assert.deepEqual(receipt,{memberships:2,platformOperators:1,tenantOwner:true,tenantIsPlatform:false});
   await writeFile(join(run,'manual-setup-receipt.json'),JSON.stringify({synthetic:true,realIdentities:false,
    setupSha256:sha(setupBytes),invocations:1,receipt,output:result.stdout.trim()},null,2)+'\n');
   raw(`DELETE FROM core.business_staff WHERE business_id='${business}';DELETE FROM core.platform_operators WHERE staff_id='${talip}';
    DELETE FROM auth.users WHERE id IN('${talip}','${yucel}');DELETE FROM core.businesses WHERE id='${business}';`);
  });
  await check('K4 restore rechecks the locked business after an observed concurrent tenant move',async()=>{
   const a=randomUUID(),b=randomUUID(),actor=randomUUID(),customer=randomUUID(),tag='k9_move_'+randomUUID().replaceAll('-','');
   raw(`INSERT INTO core.businesses(id,name,is_test) VALUES('${a}','Synthetic race A',true),('${b}','Synthetic race B',true);
    INSERT INTO auth.users(id) VALUES('${actor}');
    INSERT INTO core.business_staff(business_id,staff_id,role,active) VALUES('${a}','${actor}','staff',true);
    INSERT INTO core.customers(id,business_id,identity_key,name,email,email_status,email_suppressed_at,is_test)
     VALUES('${customer}','${a}','synthetic:${customer}','INTERNAL TEST','${customer}@example.invalid','unsubscribed',now()-interval '2 minutes',true);
    INSERT INTO core.consent_events(customer_id,event_type,source,evidence_status,created_at)
     VALUES('${customer}','suppression','synthetic','admin_suppression',now()-interval '2 minutes');`);
   function session(input){const child=spawn(exe('psql'),args,{...common,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
    const result=new Promise((accept,reject)=>{child.on('error',reject);child.on('close',status=>accept({status,stdout,stderr}));});
    child.stdin.end(input);return{child,result};}
   const mover=session(`BEGIN;SET LOCAL application_name='${tag}';SELECT id FROM core.customers WHERE id='${customer}' FOR UPDATE;
    SELECT pg_sleep(5);UPDATE core.customers SET business_id='${b}' WHERE id='${customer}';COMMIT;`);
   mover.result.catch(()=>{});let reader=null;
   try{
    let holder=null;for(let n=0;n<60;n++){holder=json(`SELECT json_build_object('pid',pid,'waitEvent',wait_event) FROM pg_stat_activity WHERE application_name='${tag}'`);
     if(holder?.waitEvent==='PgSleep')break;await new Promise(resolve=>setTimeout(resolve,30));}
    assert.equal(holder?.waitEvent,'PgSleep','first backend holds customer row lock');
    reader=session(`\\set VERBOSITY verbose
     BEGIN;SET LOCAL application_name='${tag}_restore';SET LOCAL request.jwt.claim.role='authenticated';
     SET LOCAL request.jwt.claim.sub='${actor}';
     SELECT public.crm_restore_email_consent_v1('${customer}',now()-interval '1 minute','customer_web','synthetic race evidence','${'c'.repeat(64)}',true,true);COMMIT;`);
    reader.result.catch(()=>{});let blocked=null;
    for(let n=0;n<70;n++){blocked=json(`SELECT json_build_object('pid',pid,'blockers',pg_blocking_pids(pid),'waitEventType',wait_event_type)
      FROM pg_stat_activity WHERE application_name='${tag}_restore'`);
     if(blocked?.waitEventType==='Lock'&&blocked.blockers.includes(holder.pid))break;
     await new Promise(resolve=>setTimeout(resolve,30));}
    assert.equal(blocked?.waitEventType,'Lock');assert.ok(blocked.blockers.includes(holder.pid),'restore must visibly wait behind moving row');
    const [moved,restored]=await Promise.all([mover.result,reader.result]);assert.equal(moved.status,0,moved.stderr);
    assert.notEqual(restored.status,0);assert.match(restored.stderr,/42501/);
    const state=json(`SELECT json_build_object('targetBusinessChanged',business_id='${b}','status',email_status,
      'reconsentEvents',(SELECT count(*) FROM core.consent_events WHERE customer_id='${customer}' AND event_type='reconsent'))
      FROM core.customers WHERE id='${customer}'`);
    assert.deepEqual(state,{targetBusinessChanged:true,status:'unsubscribed',reconsentEvents:0});
    await writeFile(join(run,'locked-customer-scope-race.json'),JSON.stringify({observedHolder:holder,observedBlocked:blocked,
     restoreSqlstate:'42501',state,synthetic:true,distinctBackends:holder.pid!==blocked.pid,providerCalls:0},null,2)+'\n');
   }finally{if(mover.child.exitCode===null)mover.child.kill();if(reader&&reader.child.exitCode===null)reader.child.kill();}
  });
  await writeFile(join(run,'summary.json'),JSON.stringify({passed:checks.length,total:checks.length,checks,appliedSources:journal,
   native:'PostgreSQL18.6',hostedConnection:false,realCustomerData:false,providerCalls:0,messageSends:0,cleanup:'owned cluster stopped in finally'},null,2)+'\n');
  console.log('K9 full-baseline evidence: '+run);
 }catch(error){await writeFile(join(run,'failure.json'),JSON.stringify({error:String(error.stack||error),checks,hosted:false},null,2)+'\n');throw error;}
 finally{await h.stop();}
});
