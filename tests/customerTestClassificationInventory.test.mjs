import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {auditMigrations} from '../tools/test-env/audit-migrations.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const source=JSON.parse(await readFile(new URL('../tools/test-env/migration-manifest.json',import.meta.url),'utf8'));
const key='customer_test_classification_delivery';
const codes=result=>result.integrity.issues.map(issue=>issue.code);
test('customer marker candidate has LF identity but no assigned sequence or execution approval',async()=>{
 const entry=source[key];assert.ok(entry);assert.equal(entry.application_order,null);
 assert.equal(entry.execution_enabled,false);assert.equal(entry.included_in_k3_reset,false);
 const bytes=await readFile(new URL('../'+entry.path,import.meta.url));
 assert.equal(bytes.includes(13),false);assert.notEqual(bytes[0],0xef);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),entry.sha256_bytes);
 const result=await auditMigrations({root});
 assert.equal(result.integrity.ok,true,JSON.stringify(result.integrity.issues));
 assert.equal(result.readiness.execution_performed,false);assert.equal(result.readiness.ready,false);
 assert.ok(!result.proposed_order.some(row=>row.path===entry.path));
 const missing=structuredClone(source);delete missing[key];
 assert.ok(codes(await auditMigrations({root,manifest:missing})).includes('UNINVENTORIED_CANONICAL_SQL'));
});
test('candidate inventory cannot assign a number, enable execution, change bytes/path or select a tool',async()=>{
 for(const mutate of [
  e=>{e.application_order=22;},e=>{e.execution_enabled=true;},e=>{e.included_in_k3_reset=true;},
  e=>{e.sha256_bytes='0'.repeat(64);},e=>{e.path='../unreviewed.sql';},e=>{e.application_tool='arbitrary.py';},
 ]){
  const manifest=structuredClone(source);mutate(manifest[key]);
  assert.ok(codes(await auditMigrations({root,manifest})).includes('CUSTOMER_TEST_DELIVERY_CONTRACT'));
 }
});
