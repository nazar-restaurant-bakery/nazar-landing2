import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fixture} from './fixtures/campaignEngineNative.mjs';

// Owned loopback PG18.6 only. No hosted URL, key, account, provider or email.
const h=await fixture(),{a,b}=h.config.scopeFixture.businesses,u=h.config.scopeFixture.users;
const checks=[],sha=bytes=>createHash('sha256').update(bytes).digest('hex');
after(async()=>{await writeFile(join(h.config.run,'staff-manage-summary.json'),JSON.stringify({
 scope:'STAFF_MANAGE_NATIVE_SYNTHETIC',checks,passed:checks.filter(c=>c.passed).length,total:checks.length,
 hosted_connections:0,provider_calls:0,account_operations:0,message_sends:0},null,2)+'\n');await h.stop();});
function check(name,body){test(name,async()=>{try{await body();checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,error:e.message});throw e;}});}
const migration='supabase/migrations/20261021000850_staff_manage_authorization.sql';
const source=await readFile(join(h.repo,migration));
const definitions=()=>h.sql(`SELECT json_agg(json_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),'acl',p.proacl,'config',p.proconfig,'definer',p.prosecdef) ORDER BY p.oid)
 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname IN('core','public','auth')`);
const previous=definitions();
check('forward migration has LF bytes; applied K9 bytes immutable',async()=>{
 assert.equal(source.includes(13),false);
 assert.equal(sha(await readFile(join(h.repo,'supabase/migrations/20261021000200_campaign_engine.sql'))),'a8b48363414e134f58379a03f848f4195141bd8c11047a75066d0feb66faba7d');
 assert.equal(h.authorized(u.ownerA,a,'staff.manage'),false);
 h.sql(source.toString());
 const current=definitions();assert.equal(current.length,previous.length);
 const differences=previous.filter((p,i)=>JSON.stringify(p)!==JSON.stringify(current[i]));
 assert.equal(differences.length,1);assert.match(differences[0].definition,/FUNCTION core.staff_authorized_v1/);
 const changed=current.find(p=>p.oid===differences[0].oid);
 assert.deepEqual({...changed,definition:undefined},{...differences[0],definition:undefined});
 await writeFile(join(h.config.run,'staff-manage-function-parity.json'),JSON.stringify({
  migration,sha256:sha(source),before:previous,after:current,changedFunctions:1,unchangedAclConfigDefiner:true},null,2)+'\n');
});
const matrix=[
 ['owner',u.ownerA,a,true],['ordinary manager',u.managerA,a,false],['ordinary staff',u.staffA,a,false],
 ['platform active member',u.platformMember,a,true],['platform-only',u.platformOnly,a,false],
 ['inactive membership',u.inactiveA,a,false],['legacy-only',u.legacyOnly,a,false],
 ['wrong business',u.ownerA,b,false],['NULL actor',null,a,false],['NULL business',u.ownerA,null,false],
 ['unknown business',u.ownerA,randomUUID(),false],['inactive platform-only',u.inactivePlatform,a,false]
];
for(const [name,actor,business,expected] of matrix)check(`staff.manage ${name}`,()=>assert.equal(h.authorized(actor,business,'staff.manage'),expected));
check('platform member role is independent; inactive platform does not remove owner authority',()=>{
 h.sql(`UPDATE core.business_staff SET role='staff' WHERE staff_id='${u.platformMember}';`);
 assert.equal(h.authorized(u.platformMember,a,'staff.manage'),true);
 h.sql(`UPDATE core.business_staff SET active=false WHERE staff_id='${u.platformMember}';`);
 assert.equal(h.authorized(u.platformMember,a,'staff.manage'),false);
 h.sql(`UPDATE core.business_staff SET active=true WHERE staff_id='${u.platformMember}';UPDATE core.platform_operators SET active=false WHERE staff_id='${u.platformMember}';`);
 assert.equal(h.authorized(u.platformMember,a,'staff.manage'),false);
 h.sql(`UPDATE core.business_staff SET role='owner' WHERE staff_id='${u.platformMember}';`);
 assert.equal(h.authorized(u.platformMember,a,'staff.manage'),true);
 h.sql(`UPDATE core.platform_operators SET active=true WHERE staff_id='${u.platformMember}';`);
});
check('old operation allowlist and platform read/write split unchanged',()=>{
 for(const op of ['crm.read','orders.read','ops.read','loyalty.read']){
  assert.equal(h.authorized(u.platformOnly,a,op),true);assert.equal(h.authorized(u.staffA,a,op),true);
 }
 for(const op of ['crm.write','consent.restore','orders.match','campaign.staff_mark','ops.write']){
  assert.equal(h.authorized(u.platformOnly,a,op),false);assert.equal(h.authorized(u.staffA,a,op),true);
 }
 assert.equal(h.authorized(u.platformOnly,null,'platform.read'),true);
 assert.equal(h.authorized(u.ownerA,a,'unknown'),false);assert.equal(h.authorized(u.ownerA,a,null),false);
});
check('public wrapper requires authenticated identity; private ACL/core RLS unchanged',()=>{
 for(const actor of [u.ownerA,u.managerA])assert.equal(h.sql(`SELECT public.staff_business_authorized_v1('${a}','staff.manage')`,{subject:actor,role:'authenticated'}),actor===u.ownerA);
 for(const role of ['anon','authenticated','service_role']){
  assert.equal(h.sql(`SELECT has_function_privilege('${role}','core.staff_authorized_v1(uuid,text)','EXECUTE')`),false);
  for(const table of ['business_staff','platform_operators']){
   assert.equal(h.sql(`SELECT has_table_privilege('${role}','core.${table}','SELECT,INSERT,UPDATE,DELETE')`),false);
   assert.equal(h.sql(`SELECT relrowsecurity FROM pg_class WHERE oid='core.${table}'::regclass`),true);
  }
  assert.equal(h.sql(`SELECT has_schema_privilege('${role}','core','USAGE')`),false);
 }
 assert.notEqual(h.raw(`SELECT public.staff_business_authorized_v1('${a}','staff.manage')`,{role:'service_role'}).status,0);
});
check('replay or unexpected predecessor is refused transactionally',()=>{
 const before=definitions();assert.notEqual(h.raw(source.toString()).status,0);assert.deepEqual(definitions(),before);
});
check('operator postconditions execute against the actual forward migration',async()=>{
 const plans=JSON.parse(await readFile(join(h.repo,'tools/test-env/staff-manage/migration-plans.json')));
 assert.equal(plans['14b'].sha256.toLowerCase(),sha(source));
 for(const condition of plans['14b'].postconditions)assert.equal(h.sql('SELECT COALESCE(('+condition+'),false)'),true,condition);
});
check('#78 exact pinned test consumer integrates without widening grants',async()=>{
 const meta=JSON.parse(await readFile(join(h.repo,'tests/fixtures/staffManagementConsumer.source.json')));
 const consumer=await readFile(join(h.repo,'tests/fixtures/staffManagementConsumer.sql'));
 assert.equal(sha(consumer),meta.sha256);assert.equal(meta.test_only,true);
 assert.equal(sha(await readFile(join(h.repo,meta.path))),meta.sha256);
 assert.deepEqual(consumer,await readFile(join(h.repo,meta.path)));
 // Only synthetic identity columns required by consumer; no account operations.
 h.sql(`ALTER TABLE auth.users ADD COLUMN email text,ADD COLUMN raw_user_meta_data jsonb DEFAULT '{}'::jsonb;
 UPDATE auth.users SET email=id::text||'@synthetic.invalid';`);
 h.sql(consumer.toString());
 assert.equal(h.sql(`SELECT to_json(public.staff_members_list_v1('${a}')->>'businessId')`,{subject:u.ownerA,role:'authenticated'}),a);
});
check('protected RPC gives 42501 for manager/staff, foreign scope and spoofed UUID',()=>{
 for(const actor of [u.managerA,u.staffA,u.platformOnly,u.staffB]){
  const r=h.raw(`\\set VERBOSITY verbose
 SELECT public.staff_members_list_v1('${a}');`,{subject:actor,role:'authenticated'});
  assert.notEqual(r.status,0);assert.match(r.stderr,/42501/);
 }
 const r=h.raw(`\\set VERBOSITY verbose
 SELECT public.staff_member_update_v1('${b}','${u.staffB}','manager',true,'staff',true);`,{subject:u.ownerA,role:'authenticated'});
 assert.notEqual(r.status,0);assert.match(r.stderr,/42501/);
});
const update=(actor,target,role,active,expectedRole='owner',expectedActive=true)=>h.sql(
 `SELECT public.staff_member_update_v1('${a}','${target}','${role}',${active},'${expectedRole}',${expectedActive})`,{subject:actor,role:'authenticated'});
check('own active owner deactivation is refused with another owner present',()=>{
 assert.deepEqual(update(u.ownerA,u.ownerA,'owner',false),{changed:false,code:'own_owner'});
 assert.equal(h.sql(`SELECT active FROM core.business_staff WHERE business_id='${a}' AND staff_id='${u.ownerA}'`),true);
});
check('last owner deactivation and demotion refused for platform member',()=>{
 h.sql(`UPDATE core.business_staff SET role='staff' WHERE staff_id='${u.platformMember}';`);
 assert.deepEqual(update(u.platformMember,u.ownerA,'owner',false),{changed:false,code:'last_owner'});
 assert.deepEqual(update(u.platformMember,u.ownerA,'staff',true),{changed:false,code:'last_owner'});
 h.sql(`UPDATE core.business_staff SET role='owner' WHERE staff_id='${u.platformMember}';`);
});
check('concurrent owner demotions serialize; only one succeeds, one owner remains',async()=>{
 const tags=['staff_a_'+randomUUID().replaceAll('-',''),'staff_b_'+randomUUID().replaceAll('-','')];
 const command=(actor,target)=>`SELECT public.staff_member_update_v1('${a}','${target}','manager',true,'owner',true);`;
 const prefix=(actor,tag)=>`BEGIN;SET LOCAL application_name='${tag}';SET LOCAL request.jwt.claim.role='authenticated';SET LOCAL request.jwt.claim.sub='${actor}';SET LOCAL ROLE authenticated;`;
 let first,second;
 try{
  first=h.session(prefix(u.ownerA,tags[0])+command(u.ownerA,u.ownerA)+'SELECT pg_sleep(3);COMMIT;',tags[0]);first.promise.catch(()=>{});
  let sleeping=false;for(let n=0;n<75;n++){sleeping=h.sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='${tags[0]}' AND wait_event='PgSleep')`);if(sleeping)break;await new Promise(r=>setTimeout(r,25));}
  assert.equal(sleeping,true);
  second=h.session(prefix(u.platformMember,tags[1])+command(u.platformMember,u.platformMember)+'COMMIT;',tags[1]);second.promise.catch(()=>{});
  let blocked=false;for(let n=0;n<75;n++){blocked=h.sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='${tags[1]}' AND cardinality(pg_blocking_pids(pid))>0)`);if(blocked)break;await new Promise(r=>setTimeout(r,25));}
  assert.equal(blocked,true,'second PostgreSQL session must actually block');
  const results=await Promise.all([first.promise,second.promise]);
  const decisions=results.map(r=>JSON.parse(r.stdout.split(/\r?\n/).find(line=>line.startsWith('{'))));
  assert.equal(decisions[0].changed,true);assert.deepEqual(decisions[1],{changed:false,code:'last_owner'});
  assert.equal(h.sql(`SELECT count(*) FROM core.business_staff WHERE business_id='${a}' AND role='owner' AND active`),1);
  await writeFile(join(h.config.run,'staff-manage-race.json'),JSON.stringify({blocked,decisions,remainingOwners:1,realBackends:true},null,2)+'\n');
 }finally{for(const s of [first,second])if(s?.child.exitCode===null)s.child.kill();}
});
