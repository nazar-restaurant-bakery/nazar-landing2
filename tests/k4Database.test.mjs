import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
const runtime=process.env.PGLITE_MODULE;
if (!runtime) throw new Error('PGLITE_MODULE must explicitly select the isolated PostgreSQL test runtime');
const { PGlite }=await import(runtime);
const read=path=>readFile(new URL(path,import.meta.url),'utf8');
const baseline=await read('../supabase/baselines/20261019_application_schema.sql');
const migration=await read('../supabase/migrations/20261019000200_suppression_consent_offers.sql');
const acceptance=await read('../tools/test-env/k4-acceptance.sql');
async function fixture(t,markers){
 const db=new PGlite(); t.after(()=>db.close());
 await db.exec(`CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS; CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS; CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;
 CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE SCHEMA extensions;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;
 GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;`);
 await db.exec(baseline.replace(/^\\(?:un)?restrict\s+\S+\r?$/gm,''));
 if(markers) await db.exec(await read('../supabase/migrations/20261019000100_test_record_markers.sql'));
 await db.exec(migration);
 return db;
}
test('K4 LF migration installs on actual production baseline without test-marker dependency',async t=>{
 assert.ok(!migration.includes('\r'));assert.ok(!migration.includes('khgczybubufouraqyrcj'));
 assert.equal(createHash('sha256').update(baseline).digest('hex'),'f3583bb461ba8ae50dea04ae03d6c5c4dbe729aacdec1ed7dd57982b7e25d230');
 const db=await fixture(t,false);
 assert.equal((await db.query("SELECT to_regprocedure('public.list_offers(uuid)') IS NOT NULL AS present")).rows[0].present,true);
});
test('literal hosted acceptance suite exercises guard, approval, identity and all offers; rollback leaves no fixture',async t=>{
 const db=await fixture(t,true);
 const businessId=baseline.match(/CONSTRAINT businesses_id_check CHECK \(\(id = '([0-9a-f-]+)'::uuid\)\)/)[1];
 const staff=randomUUID();
 await db.query('INSERT INTO auth.users(id) VALUES($1)',[staff]);
 await db.query("INSERT INTO core.crm_staff(auth_user_id,role) VALUES($1,'staff')",[staff]);
 await db.query("INSERT INTO core.businesses(id,name,intake_enabled,is_test) VALUES($1,'Nazar-test',true,true)",[businessId]);
 const results=await db.exec(acceptance);
 const result=results.find(r=>r.fields.length&&r.rows[0]?.jsonb_build_object)?.rows[0].jsonb_build_object;
 assert.ok(result);assert.equal(result.failed,0);assert.ok(result.passed>=11);
 console.info(JSON.stringify(result));
 assert.equal((await db.query('SELECT count(*)::int AS count FROM core.customers')).rows[0].count,0);
 assert.equal((await db.query('SELECT count(*)::int AS count FROM core.offers')).rows[0].count,0);
});
