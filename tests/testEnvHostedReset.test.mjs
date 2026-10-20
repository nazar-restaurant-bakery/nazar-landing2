// Literal compiled SQL runs only in isolated in-memory PGlite fixtures. No
// hosted/native database, real capture rows, Auth identity or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createFixture} from '../tools/test-env/synthetic-fixture.mjs';
import {BASELINE_SHA256,LEGACY_FUNCTIONS,CATALOG_SQL,baselineModel,boundReviewedBaseline,validateTarget,unwrapReviewedMarker,compileHostedResetSql} from '../tools/test-env/hosted-reset-plan.mjs';

const baseline=await readFile(new URL('../supabase/baselines/20261019_application_schema.sql',import.meta.url),'utf8');
const marker=await readFile(new URL('../supabase/migrations/20261019000100_test_record_markers.sql',import.meta.url),'utf8');
const model=baselineModel(baseline);
const baseConfig={expectedTestRef:'a'.repeat(20),expectedProdRef:'b'.repeat(20),testBusinessId:model.business,staffRole:'staff',phase:'legacy_sandbox'};
const trustedProduction='b'.repeat(20);
const runtime=process.env.PGLITE_MODULE || new URL('../../../tmp/test-db-tools/node_modules/@electric-sql/pglite/dist/index.js',import.meta.url).href;
const {PGlite}=await import(runtime);
const sqlOnly=sql=>sql.replace(/^\\(?:un)?restrict\s+\S+\r?$/gm,'');

async function legacyFixture(t){
 const db=new PGlite();t.after(()=>db.close());
 const authId=randomUUID();
 await db.exec(`CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;
CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE SCHEMA storage;CREATE TABLE storage.objects(id uuid PRIMARY KEY);
CREATE SCHEMA extensions;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger LANGUAGE plpgsql AS 'BEGIN RETURN; END';
CREATE SCHEMA core;
CREATE TABLE core.crm_staff(auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id),active boolean NOT NULL DEFAULT true);
CREATE TABLE public.catering_orders(id uuid PRIMARY KEY,customer_email text NOT NULL);
CREATE TABLE public.site_orders(id uuid PRIMARY KEY);
CREATE TABLE public.site_order_groups(id uuid PRIMARY KEY,order_id uuid REFERENCES public.site_orders(id));
CREATE TABLE public.site_order_events(id bigserial PRIMARY KEY,order_id uuid REFERENCES public.site_orders(id),group_id uuid REFERENCES public.site_order_groups(id));
ALTER TABLE core.crm_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.catering_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_order_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_order_events ENABLE ROW LEVEL SECURITY;`);
 await db.query('INSERT INTO auth.users(id) VALUES($1)',[authId]);
 await db.query('INSERT INTO core.crm_staff(auth_user_id,active) VALUES($1,false)',[authId]);
 await db.query('INSERT INTO storage.objects(id) VALUES($1)',[randomUUID()]);
 for(let index=0;index<4;index++)await db.query('INSERT INTO public.catering_orders VALUES($1,$2)',[randomUUID(),`test-${index}@example.invalid`]);
 for(const fn of LEGACY_FUNCTIONS){
  const [,name,args]=fn.match(/^public\.([a-z_]+)\((.*)\)$/);
  const parameters=args?args.split(',').map((type,index)=>`arg_${index} ${type}`).join(','):'';
  await db.exec(`CREATE FUNCTION public.${name}(${parameters}) RETURNS text LANGUAGE plpgsql AS 'BEGIN RETURN NULL; END';`);
 }
 const contract=(await db.query(CATALOG_SQL)).rows[0].contract;
 const metadata={scope:'approved_sandbox_read_only_metadata_not_install_or_restore',transaction_read_only:'on',auth_identities_included:false,function_bodies_included:false,policies:[],
  functions:contract.functions.map(item=>({schema:'public',name:item.signature.slice(7).split('(')[0],identity_signature:item.signature.slice(7),definition_md5:item.definition_md5,extension:null,known_managed_public_name:false})),
  relations:contract.relations.map(item=>({schema:item.name.split('.')[0],name:item.name.split('.')[1],kind:item.kind,rls_enabled:item.rls,rls_forced:item.force_rls,extension:null,
   columns:item.columns.map(column=>({name:column.name,type:column.type,not_null:column.not_null,identity:column.identity,generated:column.generated,default_definition_md5:column.default_md5}))})),
 };
 const input={config:{...baseConfig},productionGuardRef:trustedProduction,baseline,marker,metadata,fixture:createFixture({id:model.business,name:'Nazar-test'})};
 return {db,authId,input};
}
const coreCounts=async db=>(await db.query(`SELECT (SELECT count(*)::int FROM core.businesses) businesses,(SELECT count(*)::int FROM core.customers) customers,(SELECT count(*)::int FROM core.signups) signups,(SELECT count(*)::int FROM core.catering_requests) catering_requests,(SELECT count(*)::int FROM core.offers) offers`)).rows[0];

test('reviewed baseline and marker hashes/inventories are exact and transaction unwrapping is bounded',()=>{
 assert.equal(BASELINE_SHA256.length,64);assert.equal(model.functions.length,32);assert.equal(model.tables.length,16);assert.equal(model.views.length,2);
 const unwrapped=unwrapReviewedMarker(marker);assert.ok(unwrapped.startsWith("SET LOCAL lock_timeout='5s';"));assert.ok(!unwrapped.includes('COMMIT;'));
 assert.throws(()=>unwrapReviewedMarker(marker+'\n'),/HASH_MISMATCH/);
 assert.throws(()=>baselineModel(baseline.replace('CREATE SCHEMA core;','CREATE SCHEMA other;')),/HASH_MISMATCH/);
 const bounded=boundReviewedBaseline(baseline);
 const firstDDL=bounded.indexOf('CREATE SCHEMA core;');
 const header=bounded.slice(0,firstDDL);
 for(const setting of ["SET LOCAL lock_timeout='5s';","SET LOCAL statement_timeout='30s';","SET LOCAL idle_in_transaction_session_timeout='180s';","SET LOCAL transaction_timeout='120s';"]){
  assert.ok(header.includes(setting));assert.ok(header.indexOf(setting)>header.indexOf('SET transaction_timeout = 0;'));
 }
 assert.equal(bounded.slice(firstDDL),baseline.slice(baseline.indexOf('CREATE SCHEMA core;')),'All DDL and function-body source bytes stay identical after the insertion');
 assert.throws(()=>boundReviewedBaseline(baseline.replace('SET lock_timeout = 0;','SET lock_timeout = 10;')),/HASH_MISMATCH/);
});
test('target binding refuses production, missing role and an unrecognized reset mode',()=>{
 for(const config of [{...baseConfig,expectedTestRef:trustedProduction},{...baseConfig,expectedProdRef:'c'.repeat(20)},
  {...baseConfig,staffRole:undefined},{...baseConfig,phase:'linked'},{...baseConfig,testBusinessId:'bad'}])assert.throws(()=>validateTarget(config,trustedProduction));
});
test('exact old allowlist preserves staff/Auth/managed objects and installs nine test rows atomically',async t=>{
 const {db,authId,input}=await legacyFixture(t);
 const oldManaged=(await db.query("SELECT to_regnamespace('public')::oid public,to_regprocedure('public.rls_auto_enable()')::oid helper,to_regclass('auth.users')::oid auth")).rows[0];
 const compiled=compileHostedResetSql(input);
 assert.ok(compiled.sql.indexOf('LOCK TABLE core.crm_staff')<compiled.sql.indexOf('DO $k3_preflight$'));
 assert.ok(compiled.sql.indexOf('DO $k3_preflight$')<compiled.sql.indexOf('DROP TABLE core.crm_staff'));
 assert.ok(!compiled.sql.includes(authId),'Private identity cannot be embedded in SQL');
 assert.ok(!/DROP\s+(?:SCHEMA|TABLE|FUNCTION|VIEW)[^;]*CASCADE/i.test(compiled.sql));
 assert.ok(!/DROP SCHEMA (?:auth|storage|public|extensions)/i.test(compiled.sql));
 const results=await db.exec(sqlOnly(compiled.sql));
 const receipt=results.flatMap(result=>result.rows||[]).find(row=>row.result?.scope==='k3_hosted_application_reset')?.result;
 assert.equal(receipt.reset_completed,true);assert.equal(receipt.auth_identity_exported,false);assert.equal(receipt.staff_identity_preserved,true);
 assert.deepEqual(await coreCounts(db),compiled.seedCounts);
 assert.deepEqual((await db.query('SELECT auth_user_id,role,active FROM core.crm_staff')).rows,[{auth_user_id:authId,role:'staff',active:false}]);
 assert.deepEqual((await db.query('SELECT id FROM auth.users')).rows,[{id:authId}]);
 assert.equal((await db.query('SELECT count(*)::int count FROM storage.objects')).rows[0].count,1);
 assert.deepEqual((await db.query("SELECT to_regnamespace('public')::oid public,to_regprocedure('public.rls_auto_enable()')::oid helper,to_regclass('auth.users')::oid auth")).rows[0],oldManaged);
});
test('unknown old application object fails before any destructive statement',async t=>{
 const {db,input}=await legacyFixture(t);const compiled=compileHostedResetSql(input);
 await db.exec('CREATE TABLE public.unreviewed_object(id integer);');
 await assert.rejects(db.exec(sqlOnly(compiled.sql)),/K3_LEGACY_CATALOG_CHANGED/);
 await db.exec('ROLLBACK;');
 assert.equal((await db.query('SELECT count(*)::int count FROM public.catering_orders')).rows[0].count,4);
 assert.notEqual((await db.query("SELECT to_regclass('core.crm_staff')::text name")).rows[0].name,null);
});
test('catalog drift and new order count both reject without erasing the recovery source',async t=>{
 const {db,input}=await legacyFixture(t);const compiled=compileHostedResetSql(input);
 await db.exec('ALTER TABLE public.catering_orders ADD COLUMN unreviewed text;');
 await assert.rejects(db.exec(sqlOnly(compiled.sql)),/K3_LEGACY_CATALOG_CHANGED/);await db.exec('ROLLBACK;');
 await db.exec('ALTER TABLE public.catering_orders DROP COLUMN unreviewed;');
 await db.query('INSERT INTO public.catering_orders VALUES($1,$2)',[randomUUID(),'fifth@example.invalid']);
 await assert.rejects(db.exec(sqlOnly(compiled.sql)),/K3_LEGACY_COUNTS_CHANGED/);await db.exec('ROLLBACK;');
 assert.equal((await db.query('SELECT count(*)::int count FROM public.catering_orders')).rows[0].count,5);
});
test('unexpected inherited function access triggers rollback rather than automatic repair',async t=>{
 const {db,authId,input}=await legacyFixture(t);const compiled=compileHostedResetSql(input);
 await db.exec('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon;');
 await assert.rejects(db.exec(sqlOnly(compiled.sql)),/K3_EFFECTIVE_FUNCTION_PRIVILEGE_MISMATCH/);await db.exec('ROLLBACK;');
 assert.equal((await db.query('SELECT count(*)::int count FROM public.catering_orders')).rows[0].count,4);
 assert.deepEqual((await db.query('SELECT auth_user_id,active FROM core.crm_staff')).rows,[{auth_user_id:authId,active:false}]);
 assert.equal((await db.query("SELECT to_regclass('core.businesses')::text name")).rows[0].name,null);
});
test('repeat uses the known baseline contract and prior committed receipt, preserving managed identity',async t=>{
 const {db,authId,input}=await legacyFixture(t);
 const first=await db.exec(sqlOnly(compileHostedResetSql(input).sql));
 const previousReceipt=first.flatMap(result=>result.rows||[]).find(row=>row.result?.scope==='k3_hosted_application_reset')?.result;
 const repeated={...input,config:{...input.config,phase:'reviewed_baseline'},previousReceipt};
 const compiled=compileHostedResetSql(repeated);
 assert.equal(compiled.inventories.dropTables.length,16);assert.equal(compiled.inventories.dropFunctions.length,32);assert.equal(compiled.inventories.dropViews.length,2);
 await db.exec(sqlOnly(compiled.sql));assert.deepEqual(await coreCounts(db),compiled.seedCounts);
 assert.deepEqual((await db.query('SELECT auth_user_id,role,active FROM core.crm_staff')).rows,[{auth_user_id:authId,role:'staff',active:false}]);
 assert.throws(()=>compileHostedResetSql({...repeated,previousReceipt:null}),/PREVIOUS_SUCCESSFUL_INSTALL_RECEIPT_REQUIRED/);
});

test('server timeout settings are bounded at the first baseline DDL, not only after restore',async t=>{
 const {db,input}=await legacyFixture(t);
 await db.exec(`CREATE TABLE storage.ddl_timeout_observation(tag text,lock_timeout text,statement_timeout text,idle_timeout text,transaction_timeout text);
CREATE FUNCTION extensions.observe_ddl_timeout() RETURNS event_trigger LANGUAGE plpgsql AS $capture$
BEGIN
 IF TG_TAG='CREATE SCHEMA' AND to_regnamespace('core') IS NULL THEN
  INSERT INTO storage.ddl_timeout_observation VALUES(TG_TAG,current_setting('lock_timeout'),current_setting('statement_timeout'),current_setting('idle_in_transaction_session_timeout'),current_setting('transaction_timeout'));
 END IF;
END $capture$;
CREATE EVENT TRIGGER observe_k3_first_ddl ON ddl_command_start WHEN TAG IN('CREATE SCHEMA') EXECUTE FUNCTION extensions.observe_ddl_timeout();`);
 await db.exec(sqlOnly(compileHostedResetSql(input).sql));
 assert.deepEqual((await db.query('SELECT * FROM storage.ddl_timeout_observation')).rows,[{
  tag:'CREATE SCHEMA',lock_timeout:'5s',statement_timeout:'30s',idle_timeout:'3min',transaction_timeout:'2min',
 }]);
});
