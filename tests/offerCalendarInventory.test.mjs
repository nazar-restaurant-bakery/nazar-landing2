import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {auditMigrations} from '../tools/test-env/audit-migrations.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const source=JSON.parse(await fs.readFile(new URL('../tools/test-env/migration-manifest.json',import.meta.url),'utf8'));
const offer='supabase/migrations/20261021000950_offer_calendar_activation.sql';

test('offer calendar inventory is exact-pinned without reserving a production order or authorizing replay',async()=>{
 const result=await auditMigrations({root});
 assert.equal(result.integrity.ok,true,JSON.stringify(result.integrity.issues));
 assert.equal(source.offer_calendar_delivery.path,offer);
 assert.equal(source.offer_calendar_delivery.application_order,null);
 assert.equal(source.offer_calendar_delivery.sha256_bytes,'32bc4ec03223f785c308462d3ebad3f4d24a810f5614d0077b35143899931718');
 assert.equal(source.offer_calendar_delivery.execution_enabled,false);
 assert.equal(source.offer_calendar_delivery.included_in_k3_reset,false);
 assert.ok(result.proposed_order.every(e=>e.path!==offer));
 assert.ok(result.pending_canonical.every(e=>e.path!==offer));
 assert.equal(result.readiness.ready,false);
 assert.equal(result.readiness.execution_performed,false);
});

test('missing or broadened unnumbered offer inventory fails closed',async()=>{
 const missing=structuredClone(source);delete missing.offer_calendar_delivery;
 assert.ok((await auditMigrations({root,manifest:missing})).integrity.issues.some(e=>e.code==='UNINVENTORIED_CANONICAL_SQL'&&e.detail===offer));
 for(const mutation of [
  e=>{e.application_order='15b';},
  e=>{e.execution_enabled=true;},
  e=>{e.included_in_k3_reset=true;},
  e=>{e.sha256_bytes='f'.repeat(64);},
  e=>{e.path='../unreviewed.sql';},
  e=>{e.application_tool='unreviewed-executable';},
 ]){
  const manifest=structuredClone(source);mutation(manifest.offer_calendar_delivery);
  assert.ok((await auditMigrations({root,manifest})).integrity.issues.some(e=>e.code==='CURRENT_MAIN_DELIVERY_CONTRACT'));
 }
});

test('already merged order 15 through 17 sources remain non-executable reviewed inventory',async()=>{
 for(const [key,order] of [['staff_management_delivery',15],['ops_campaign_usage_delivery',16],['qr_vip_funnel_delivery',17]]){
  assert.equal(source[key].application_order,order);
  assert.equal(source[key].execution_enabled,false);
  assert.equal(source[key].included_in_k3_reset,false);
  const manifest=structuredClone(source);delete manifest[key];
  assert.ok((await auditMigrations({root,manifest})).integrity.issues.some(e=>e.code==='UNINVENTORIED_CANONICAL_SQL'&&e.detail===source[key].path));
 }
});
