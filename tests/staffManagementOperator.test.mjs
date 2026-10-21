// Real disposable PG18.6 only; no hosted environment, Auth account or email.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fixture} from './fixtures/campaignEngineNative.mjs';

test('M15 guarded operator checks match the exact #78 SQL after actual M14b helper',async()=>{
 const h=await fixture();const checks=[];let evidence;
 try {
  const packageRoot=resolve(h.repo,'tools/test-env/staff-management');
  const plan=JSON.parse(await readFile(resolve(packageRoot,'migration-plans.json'),'utf8'))['15'];
  const helper=await readFile(resolve(h.repo,'tests/fixtures/staffManageAuthorizationOperator.sql'));
  assert.equal(createHash('sha256').update(helper).digest('hex'),'e6de5aa8ec80abc2ce2444d60a26e95c84ebded2451b8e7be24e67fe18008afe');
  h.sql(helper.toString('utf8'));
  const snapshot=()=>h.sql("SELECT json_build_object('helper',pg_get_functiondef('core.staff_authorized_v1(uuid,text)'::regprocedure),'authCount',(SELECT count(*) FROM auth.users),'memberCount',(SELECT count(*) FROM core.business_staff),'platformCount',(SELECT count(*) FROM core.platform_operators))");
  const before=snapshot();
  const expressions=items=>h.sql('SELECT json_build_array('+items.map(c=>'COALESCE(('+c+'),false)').join(',')+')');
  // The owned fixture uses a random database name; production connection's
  // database='postgres' guard remains in the pinned runner, not bypassed here.
  const pre=plan.preconditions;
  assert.deepEqual(expressions(pre),pre.map(()=>true));checks.push('all real preconditions true before M15');
  const sql=await readFile(resolve(packageRoot,'sql',plan.file));
  assert.equal(createHash('sha256').update(sql).digest('hex'),plan.sha256.toLowerCase());assert.ok(!sql.includes(13));
  h.sql(sql.toString('utf8'));
  assert.deepEqual(expressions(plan.postconditions),plan.postconditions.map(()=>true));checks.push('all real postconditions true after M15');
  assert.deepEqual(snapshot(),before);checks.push('helper, Auth identities, memberships and operators unchanged');
  h.sql('ALTER TABLE core.staff_management_audit DISABLE ROW LEVEL SECURITY');
  assert.ok(expressions(plan.postconditions).includes(false));checks.push('RLS drift detected');
  h.sql('ALTER TABLE core.staff_management_audit ENABLE ROW LEVEL SECURITY; GRANT EXECUTE ON FUNCTION public.staff_invite_finish_v1(uuid,uuid,uuid,uuid,text) TO authenticated');
  assert.ok(expressions(plan.postconditions).includes(false));checks.push('wrong privileged RPC grant detected');
  h.sql('REVOKE EXECUTE ON FUNCTION public.staff_invite_finish_v1(uuid,uuid,uuid,uuid,text) FROM authenticated');
  assert.deepEqual(expressions(plan.postconditions),plan.postconditions.map(()=>true));
  evidence={scope:'OWNED_LOOPBACK_POSTGRES_18_6_ONLY',migrationSha256:plan.sha256,planPrechecks:pre.length,operatorConnectionGuards:3,postchecks:plan.postconditions.length,groups:checks.length,checks,hostedConnections:0,emails:0,clusterShutdown:false};
 } finally {await h.stop();if(evidence)evidence.clusterShutdown=true;}
 const out=resolve(h.repo,'../../20_Yonetim/Teslim_Raporlari/StaffManagement_kanit/tests/postgres-checks.json');
 await mkdir(resolve(out,'..'),{recursive:true});await writeFile(out,JSON.stringify(evidence,null,2)+'\n');
});
