// Isolated SQL behavior and parser checks only. Never start a native PostgreSQL
// server, touch the owned cluster, read captures or call a remote service.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {compareRecoveryRows} from '../tools/test-env/recovery-validation.mjs';

const script=new URL('../tools/test-env/restore-sandbox-recovery-local.ps1',import.meta.url);
const source=await readFile(script,'utf8');
const insertTemplate=source.match(/\$insertTemplate=@'\r?\n([\s\S]*?)\r?\n'@/)?.[1];
assert.ok(insertTemplate,'Literal recovery insertion SQL is required');
const runtime=process.env.PGLITE_MODULE || new URL('../../../tmp/test-db-tools/node_modules/@electric-sql/pglite/dist/index.js',import.meta.url).href;
const {PGlite}=await import(runtime);

const rawRows='['+[1,2,3,4].map(n=>'{' +
 `"id":${n},"amount":900719925474099${n}.12345678901234567890,`+
 '"payload":{"very_large":123456789012345678901234567890,"fraction":0.00000000000000000000000001},'+
 `"label":"INTERNAL TEST ${n} — apostrophe: ' and dollar: $k3_recovery$"`+
 '}').join(',')+']';
function insertSql(text){return insertTemplate.replace('__K3_RECOVERY_BASE64__',Buffer.from(text,'utf8').toString('base64'));}
async function fixture(t,ddl='id bigint PRIMARY KEY,amount numeric,payload jsonb,label text'){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec('CREATE TABLE public.catering_orders('+ddl+');');
 return db;
}
async function readback(db){return (await db.query("SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY id),'[]'::jsonb)::text AS value FROM public.catering_orders o")).rows[0].value;}

test('sandbox local runner parses without executing a service or database',()=>{
 const shell=process.env.K3_PWSH || 'C:/Users/Talip/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
 const result=spawnSync(shell,['-NoProfile','-NonInteractive','-Command','$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:K3_PARSE_FILE,[ref]$tokens,[ref]$errors);if($errors.Count){$errors|ForEach-Object{$_.Message};exit 2};Write-Output "PARSE_OK"'],{encoding:'utf8',windowsHide:true,env:{...process.env,K3_PARSE_FILE:fileURLToPath(script)}});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PARSE_OK/);
});
test('runner validates original capture and derived package before its local service boundary',()=>{
 assert.match(source,/127\.0\.0\.1/);assert.match(source,/\$port=55473/);
 assert.ok(source.indexOf('--validate-rendered')<source.indexOf('if($ValidateOnly)'));
 assert.ok(source.indexOf('validate-recovery.mjs')<source.indexOf('if($ValidateOnly)'));
 assert.ok(source.indexOf('if($ValidateOnly)')<source.indexOf('$attemptedStart=$true'));
 assert.match(source,/existing owned local PostgreSQL cluster is required/);
 assert.match(source,/CREATE DATABASE/);assert.match(source,/k3_recovery_/);
 assert.match(source,/finally\{\s+if\(\$attemptedStart\)/);
 assert.match(source,/capture_and_review_provenance_preserved/);
 assert.match(source,/staff_identity_restored=\$false/);
 assert.doesNotMatch(source,/DROP DATABASE|dropdb|Remove-Item|supabase\s+(?:db|link|start)|https:\/\//i);
 assert.doesNotMatch(source,/INSERT\s+INTO\s+(?:core\.crm_staff|auth\.users)/i);
});
test('literal PostgreSQL recovery SQL preserves all exact decimal and nested integer values',async t=>{
 const db=await fixture(t);
 await db.exec(insertSql(rawRows));
 const value=await readback(db);
 assert.deepEqual(compareRecoveryRows(rawRows,value),{matches:true,reason:null});
 assert.match(value,/123456789012345678901234567890/);
 assert.match(value,/9007199254740991\.12345678901234567890/);
});
test('base64 payload and EXECUTE USING keep quote and statement text inert',async t=>{
 const db=await fixture(t);
 const label="'); CREATE TABLE public.unwanted(value text); -- $k3_recovery$";
 const rows=[1,2,3,4].map(id=>({id,amount:id,payload:{sql:label},label}));
 const text=JSON.stringify(rows);
 const sql=insertSql(text);
 assert.ok(!sql.includes(label));assert.match(sql,/EXECUTE format\([\s\S]*USING payload/);
 await db.exec(sql);
 assert.equal((await db.query("SELECT to_regclass('public.unwanted')::text value")).rows[0].value,null);
 assert.deepEqual(compareRecoveryRows(text,await readback(db)),{matches:true,reason:null});
});
test('missing or added source columns fail closed and no partial rows are committed',async t=>{
 const db=await fixture(t);
 for(const row of [{id:1,amount:1,label:'TEST'}, {id:1,amount:1,payload:null,label:'TEST',invented:'bad'}]){
  const text=JSON.stringify([1,2,3,4].map(id=>({...row,id})));
  await assert.rejects(db.exec(insertSql(text)),/Every original order column/);
  await db.exec('ROLLBACK;');
  assert.equal((await db.query('SELECT count(*)::int count FROM public.catering_orders')).rows[0].count,0);
 }
});
test('nonempty destination and an incorrect source count are rejected',async t=>{
 const db=await fixture(t);
 await assert.rejects(db.exec(insertSql('[]')),/Exactly four recovery rows/);
 await db.exec('ROLLBACK; INSERT INTO public.catering_orders(id) VALUES(99);');
 await assert.rejects(db.exec(insertSql(rawRows)),/Recovery destination must be empty/);
 await db.exec('ROLLBACK;');
 assert.equal((await db.query('SELECT count(*)::int count FROM public.catering_orders')).rows[0].count,1);
});
test('identity and generated columns retain the source values through full-column comparison',async t=>{
 const db=await fixture(t,'id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,amount numeric,payload jsonb,label text,total numeric GENERATED ALWAYS AS (amount*2) STORED');
 const rows=rawRows.replaceAll(/("amount":)([0-9.]+)(,)/g,(_,prefix,number,comma)=>prefix+number+comma+'"total":'+(BigInt(number.split('.')[0])*2n).toString()+'.24691357802469135780,');
 await db.exec(insertSql(rows));
 assert.deepEqual(compareRecoveryRows(rows,await readback(db)),{matches:true,reason:null});
});

test('UTC session serialization preserves strict timestamp strings without changing instants',async t=>{
 const db=await fixture(t,'id bigint PRIMARY KEY,created_at timestamptz,requested_pickup_at timestamptz');
 const rows=JSON.stringify([1,2,3,4].map(id=>({id,
  created_at:'2026-10-19T12:00:00+00:00',requested_pickup_at:'2026-10-20T15:00:00+00:00'})));
 await db.exec("SET timezone='America/New_York';");
 await db.exec(insertSql(rows));
 assert.deepEqual(compareRecoveryRows(rows,await readback(db)),{matches:false,reason:'row_value_mismatch'});
 const sameInstants=await db.query("SELECT bool_and(o.created_at=(v->>'created_at')::timestamptz AND o.requested_pickup_at=(v->>'requested_pickup_at')::timestamptz) AS same_instants FROM public.catering_orders o JOIN jsonb_array_elements($1::jsonb) v ON o.id=(v->>'id')::bigint",[rows]);
 assert.equal(sameInstants.rows[0].same_instants,true);
 await db.exec("SET timezone='UTC';");
 assert.deepEqual(compareRecoveryRows(rows,await readback(db)),{matches:true,reason:null});
});
