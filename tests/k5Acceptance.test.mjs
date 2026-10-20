import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
const runtime=process.env.PGLITE_MODULE;
if(!runtime)throw new Error('PGLITE_MODULE must select the isolated local database runtime');
const {PGlite}=await import(runtime);
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
const baseline=await read('../supabase/baselines/20261019_application_schema.sql');
const markers=await read('../supabase/migrations/20261019000100_test_record_markers.sql');
const k4=await read('../supabase/migrations/20261019000200_suppression_consent_offers.sql');
const k5=await read('../supabase/migrations/20261019000300_klaviyo_profile_sync.sql');
const acceptance=await read('../tools/test-env/k5-acceptance.sql');
const business=baseline.match(/CONSTRAINT businesses_id_check CHECK \(\(id = '([0-9a-f-]+)'::uuid\)\)/)[1];
const migrationSha='d28672a87149839c71e44c72116ebbf3b96b2e76c7ec42a2a79c1f7b9f4fabc2';
async function setup(t,{staff=true,marked=true,configured=true}={}){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE SCHEMA extensions;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;`);
 await db.exec(baseline.replace(/^\\(?:un)?restrict\s+\S+\r?$/gm,''));
 await db.exec(markers);await db.exec(k4);await db.exec(k5);
 await db.query("INSERT INTO core.businesses(id,name,intake_enabled,is_test) VALUES($1,'Synthetic existing business',true,$2)",[business,marked]);
 if(staff){const id=randomUUID();await db.query('INSERT INTO auth.users(id) VALUES($1)',[id]);
  await db.query("INSERT INTO core.crm_staff(auth_user_id,role) VALUES($1,'staff')",[id]);}
 if(configured)await db.query("SELECT set_config('k5.test_business_id',$1,false)",[business]);
 const existing=randomUUID();
 await db.query("INSERT INTO core.customers(id,business_id,identity_key,name,email,is_test) VALUES($1,$2,$3,'Existing synthetic fixture',$4,true)",
  [existing,business,existing,`${existing}@fixture.test`]);
 return {db,existing};
}
async function counts(db){return (await db.query(`SELECT
 (SELECT count(*)::int FROM core.businesses) AS businesses,
 (SELECT count(*)::int FROM auth.users) AS auth_users,
 (SELECT count(*)::int FROM core.crm_staff) AS staff,
 (SELECT count(*)::int FROM core.customers) AS customers,
 (SELECT count(*)::int FROM core.signups) AS signups,
 (SELECT count(*)::int FROM core.consent_events) AS consent_events,
 (SELECT count(*)::int FROM core.klaviyo_email_observations) AS observations,
 (SELECT count(*)::int FROM core.klaviyo_profile_sync_jobs) AS jobs`)).rows[0];}
function result(results){return results.find(r=>r.fields.some(f=>f.name==='acceptance'))?.rows[0]?.acceptance;}

test('hosted acceptance script is LF-only rollback SQL and preserves the exact reviewed migration bytes',()=>{
 assert.ok(!acceptance.includes('\r'));assert.match(acceptance,/^BEGIN;$/m);assert.match(acceptance,/ROLLBACK;\s*$/);
 assert.ok(!/^COMMIT;/m.test(acceptance));assert.ok(!acceptance.includes(business));
 assert.ok(!/INSERT\s+INTO\s+auth[.]|CREATE\s+(?:USER|ROLE)|ALTER\s+(?:USER|ROLE)/i.test(acceptance));
 assert.equal(createHash('sha256').update(k5).digest('hex'),migrationSha);
});

test('literal acceptance exercises actual baseline/K4/K5 and rolls back every synthetic row on repeated runs',async t=>{
 const {db,existing}=await setup(t);const before=await counts(db);
 for(let run=0;run<2;run++){
  const proof=result(await db.exec(acceptance));assert.ok(proof);
  assert.equal(proof.scope,'K5_SYNTHETIC_ROLLBACK_DB_ACCEPTANCE');
  assert.equal(proof.failed,0,JSON.stringify(proof.checks));assert.equal(proof.passed,proof.checks.length);
  assert.ok(proof.passed>=17);assert.ok(proof.checks.every(check=>check.passed===true));
  assert.deepEqual(proof.missing,[]);assert.equal(proof.provider_calls,0);assert.equal(proof.account_operations,0);
  assert.equal(proof.auth_http_claimed,false);assert.equal(proof.fixtures_rolled_back,true);
  assert.doesNotMatch(JSON.stringify(proof),/@fixture[.]test|customerId|leaseId|email|PRIVATE_RAW/);
  assert.deepEqual(await counts(db),before);
  assert.equal((await db.query('SELECT is_test FROM core.customers WHERE id=$1',[existing])).rows[0].is_test,true);
 }
});

test('missing active existing staff is reported without account creation and all other fixtures still roll back',async t=>{
 const {db}=await setup(t,{staff:false});const before=await counts(db);
 const proof=result(await db.exec(acceptance));assert.ok(proof);
 assert.deepEqual(proof.missing,['existing_active_staff']);assert.equal(proof.failed,1);
 assert.ok(proof.checks.some(check=>check.name==='existing_staff_reads_sanitized_queue'&&!check.passed));
 assert.equal(proof.account_operations,0);assert.deepEqual(await counts(db),before);
});

test('non-test business fails before fixtures or queue changes',async t=>{
 const {db}=await setup(t,{marked:false});const before=await counts(db);
 await assert.rejects(db.exec(acceptance),error=>error.message==='K5_SYNTHETIC_BUSINESS_ONLY');
 await db.exec('ROLLBACK');assert.deepEqual(await counts(db),before);
});

test('missing/invalid configured target fails closed without choosing the first business',async t=>{
 const {db}=await setup(t,{configured:false});const before=await counts(db);
 for(const setting of ['',randomUUID(),'not-a-uuid']){
  await db.query("SELECT set_config('k5.test_business_id',$1,false)",[setting]);
  await assert.rejects(db.exec(acceptance),error=>error.message==='K5_TEST_BUSINESS_REQUIRED');
  await db.exec('ROLLBACK');assert.deepEqual(await counts(db),before);
 }
});
