// Execute only literal catalog checks against an in-memory synthetic database.
// No native PostgreSQL service, captured SQL, credentials or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source=await readFile(new URL('../tools/test-env/restore-reviewed-local.ps1',import.meta.url),'utf8');
const rolesSql=source.match(/\$roleQuery=@'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
const inventorySql=source.match(/\$inventory=@'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
assert.ok(rolesSql && inventorySql,'Literal role and privilege checks are required');
const runtime=process.env.PGLITE_MODULE || new URL('../../../tmp/test-db-tools/node_modules/@electric-sql/pglite/dist/index.js',import.meta.url).href;
const {PGlite}=await import(runtime);
const roleFixture=`CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;`;

test('local role gate rejects unexpected inherited privileges without repairing roles',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(roleFixture);
 const roleCheck=async()=>(await db.query(rolesSql)).rows[0].json_build_object;
 assert.equal((await roleCheck()).valid,true);
 for(const [wrong,restore] of [
  ['ALTER ROLE authenticated BYPASSRLS','ALTER ROLE authenticated NOBYPASSRLS'],
  ['ALTER ROLE anon SUPERUSER','ALTER ROLE anon NOSUPERUSER'],
  ['ALTER ROLE service_role NOBYPASSRLS','ALTER ROLE service_role BYPASSRLS'],
  ['ALTER ROLE authenticated NOINHERIT','ALTER ROLE authenticated INHERIT'],
  ['ALTER ROLE anon LOGIN','ALTER ROLE anon NOLOGIN'],
 ]){
  await db.exec(wrong);
  assert.equal((await roleCheck()).valid,false,wrong);
  await db.exec(restore);
 }
 await db.exec('DROP ROLE anon');
 assert.equal((await roleCheck()).valid,false,'A missing standard role cannot pass');
});

test('inventory records effective default and explicit EXECUTE privileges by stable signature',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(roleFixture+`
CREATE SCHEMA core;
CREATE FUNCTION public.default_rpc(value integer) RETURNS integer LANGUAGE sql AS 'SELECT value';
CREATE FUNCTION public.staff_rpc(value text) RETURNS text LANGUAGE sql AS 'SELECT value';
REVOKE ALL ON FUNCTION public.staff_rpc(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.staff_rpc(text) TO authenticated;
CREATE FUNCTION core.private_rpc() RETURNS integer LANGUAGE sql AS 'SELECT 1';
REVOKE ALL ON FUNCTION core.private_rpc() FROM PUBLIC;`);
 const result=(await db.query(inventorySql)).rows[0].json_build_object;
 assert.equal(result.core_anon_usage,false);
 assert.equal(result.core_authenticated_usage,false);
 assert.equal(result.core_service_role_usage,false);
 assert.deepEqual(result.role_attributes.map(v=>v.name),['anon','authenticated','service_role']);
 assert.equal(result.role_attributes.find(v=>v.name==='service_role').bypass_rls,true);
 const defaultRpc=result.routines.find(v=>v.name==='default_rpc');
 assert.equal(defaultRpc.schema,'public');
 assert.equal(defaultRpc.args,'value integer');
 assert.equal(defaultRpc.acl,null,'NULL ACL still has effective PUBLIC EXECUTE');
 assert.equal(defaultRpc.execute_anon,true);
 assert.equal(defaultRpc.execute_authenticated,true);
 assert.equal(defaultRpc.execute_service_role,true);
 const staff=result.routines.find(v=>v.name==='staff_rpc');
 assert.equal(staff.execute_anon,false);
 assert.equal(staff.execute_authenticated,true);
 assert.equal(staff.execute_service_role,false);
 const privateRpc=result.routines.find(v=>v.name==='private_rpc');
 assert.equal(privateRpc.schema,'core');
 assert.equal(privateRpc.execute_anon,false);
 assert.equal(privateRpc.execute_authenticated,false);
 assert.equal(privateRpc.execute_service_role,false);
});
