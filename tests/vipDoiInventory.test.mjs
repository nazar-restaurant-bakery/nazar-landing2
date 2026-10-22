import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {auditMigrations} from '../tools/test-env/audit-migrations.mjs';
const manifest=JSON.parse(await readFile(new URL('../tools/test-env/migration-manifest.json',import.meta.url),'utf8'));
test('DOI source inventory binds order19 to order18 without execution or replay',async()=>{
 const e=manifest.vip_doi_webhook_delivery;assert.equal(e.application_order,19);assert.equal(e.requires_previous_order,18);
 const r=await auditMigrations();assert.equal(r.integrity.ok,true,JSON.stringify(r.integrity.issues));assert.equal(r.readiness.ready,false);
});
test('tampered DOI inventory cannot bypass order18 or enable execution',async()=>{
 for(const [key,value] of [['requires_previous_order',17],['application_order',18],['execution_enabled',true],['included_in_k3_reset',true],['sha256_bytes','0'.repeat(64)]]){
  const m=structuredClone(manifest);m.vip_doi_webhook_delivery[key]=value;
  const r=await auditMigrations({manifest:m});assert.ok(r.integrity.issues.some(x=>x.code==='DOI_WEBHOOK_DELIVERY_CONTRACT'),key);
 }
});
