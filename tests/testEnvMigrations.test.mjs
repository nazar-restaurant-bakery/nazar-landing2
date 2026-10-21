import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {auditMigrations,sha256Lf} from '../tools/test-env/audit-migrations.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const source=JSON.parse(await fs.readFile(new URL('../tools/test-env/migration-manifest.json',import.meta.url),'utf8'));
const clone=()=>structuredClone(source);
const codes=result=>result.integrity.issues.map(issue=>issue.code);

test('inventory verifies all 18 baseline SQL files and historical copy without claiming K3 readiness',async()=>{
 const result=await auditMigrations({root});
 assert.equal(result.integrity.ok,true,JSON.stringify(result.integrity.issues));
 assert.equal(result.integrity.database_sources,18);assert.equal(result.integrity.historical_sources,1);assert.equal(result.integrity.pending_canonical_sources,1);assert.equal(result.integrity.reviewed_additive_sources,4);assert.equal(result.integrity.verified_sources,24);
 assert.equal(result.readiness.ready,false);assert.equal(result.readiness.execution_performed,false);assert.equal(result.readiness.state,'BLOCKED');
 assert.ok(result.readiness.blockers.some(b=>b.id==='NEUTRAL_BASELINE_MISSING'));
 assert.ok(result.proposed_order.every(entry=>entry.executable===false));
 assert.deepEqual(result.excluded.map(entry=>entry.id),['intake_pause']);
 assert.deepEqual(result.pending_canonical.map(entry=>entry.id),['test_record_markers']);
 assert.deepEqual(result.reviewed_additive.map(entry=>entry.id),['k4_suppression_consent_offers','k5_klaviyo_profile_sync','k6_message_send_gate','ops_write_gate']);
 assert.equal(result.reviewed_additive[0].included_in_k3_reset,false);
 assert.equal(result.reviewed_additive[0].application_tool,'tools/test-env/k4-migrate.py');
 assert.equal(result.reviewed_additive[1].included_in_k3_reset,false);
 assert.equal(result.reviewed_additive[1].application_tool,'tools/test-env/k5-migrate.py');
 assert.equal(result.reviewed_additive[2].included_in_k3_reset,false);
 assert.equal(result.reviewed_additive[2].application_tool,'tools/test-env/k6-migrate.py');
});

test('current-main K7 delivery is exact-pinned, non-executable and never enters K3 replay',async()=>{
 const entry=source.k7_delivery;assert.ok(entry);
 const bytes=await fs.readFile(new URL('../'+entry.path,import.meta.url));
 assert.equal(bytes.includes(13),false);
 assert.equal(sha256Lf(bytes.toString('utf8')),'5f68772059d9cd1e1d7a6a290aa31ee32d10ff5a367201577c4058861aada4a8');
 assert.equal(entry.sha256_bytes,sha256Lf(bytes.toString('utf8')));
 assert.equal(entry.execution_enabled,false);assert.equal(entry.included_in_k3_reset,false);
 const missing=clone();delete missing.k7_delivery;
 assert.ok(codes(await auditMigrations({root,manifest:missing})).includes('UNINVENTORIED_CANONICAL_SQL'));
 for(const mutate of [
  m=>{m.k7_delivery.sha256_bytes='f'.repeat(64);},
  m=>{m.k7_delivery.execution_enabled=true;},
  m=>{m.k7_delivery.included_in_k3_reset=true;},
  m=>{m.k7_delivery.path='../unreviewed.sql';},
  m=>{m.k7_delivery.application_tool='arbitrary-executable.py';},
 ]){const manifest=clone();mutate(manifest);assert.ok(codes(await auditMigrations({root,manifest})).includes('K7_DELIVERY_CONTRACT'));}
 assert.equal((await auditMigrations({root})).readiness.ready,false);
});

test('checksum integrity accepts CRLF conversion only and detects changed content',()=>{
 assert.equal(sha256Lf('a\r\nb\r\n'),sha256Lf('a\nb\n'));
 assert.notEqual(sha256Lf('a\nb\n'),sha256Lf('a\nb;\n'));
 assert.notEqual(sha256Lf('a\nb\n'),sha256Lf('a\n b\n'),'SQL whitespace is not silently rewritten');
});

test('current-main K7 optional-scope patch is exact-pinned at order 6 and excluded from K3 replay',async()=>{
 const entry=source.k7_optional_scope_delivery;assert.ok(entry);
 assert.equal(entry.path,'supabase/migrations/20261020000900_clover_optional_scope_status.sql');
 const bytes=await fs.readFile(new URL('../'+entry.path,import.meta.url));
 assert.equal(bytes.includes(13),false);
 assert.equal(sha256Lf(bytes.toString('utf8')),'a3778d0b933c4ce1a56dba04bcadc31b3f6d1c8f214d56af8203a88d6bcc826e');
 assert.equal(entry.sha256_bytes,sha256Lf(bytes.toString('utf8')));
 assert.equal(entry.application_order,6);
 assert.equal(entry.execution_enabled,false);assert.equal(entry.included_in_k3_reset,false);
 const missing=clone();delete missing.k7_optional_scope_delivery;
 assert.ok(codes(await auditMigrations({root,manifest:missing})).includes('UNINVENTORIED_CANONICAL_SQL'));
 for(const mutate of [
  m=>{m.k7_optional_scope_delivery.sha256_bytes='f'.repeat(64);},
  m=>{m.k7_optional_scope_delivery.execution_enabled=true;},
  m=>{m.k7_optional_scope_delivery.included_in_k3_reset=true;},
  m=>{m.k7_optional_scope_delivery.path='../unreviewed.sql';},
  m=>{m.k7_optional_scope_delivery.application_order=5;},
  m=>{m.k7_optional_scope_delivery.application_tool='arbitrary-executable.py';},
 ]){const manifest=clone();mutate(manifest);assert.ok(codes(await auditMigrations({root,manifest})).includes('K7_OPTIONAL_SCOPE_DELIVERY_CONTRACT'));}
 const result=await auditMigrations({root});
 assert.equal(result.readiness.ready,false);assert.equal(result.readiness.execution_performed,false);
 assert.ok(result.proposed_order.every(entry=>entry.path!==source.k7_optional_scope_delivery.path));
});

test('held K9 delivery keeps exact reviewed bytes and waits for K8 without entering K3 replay',async()=>{
 const entry=source.k9_delivery;assert.ok(entry);
 assert.equal(entry.path,'supabase/migrations/20261021000200_campaign_engine.sql');
 const bytes=await fs.readFile(new URL('../'+entry.path,import.meta.url));
 assert.equal(bytes.includes(13),false);
 assert.equal(sha256Lf(bytes.toString('utf8')),entry.sha256_bytes);
 assert.equal(entry.application_order,8);assert.equal(entry.requires_previous_order,7);
 assert.equal(entry.execution_enabled,false);assert.equal(entry.included_in_k3_reset,false);
 const missing=clone();delete missing.k9_delivery;
 assert.ok(codes(await auditMigrations({root,manifest:missing})).includes('UNINVENTORIED_CANONICAL_SQL'));
 for(const mutate of [
  m=>{m.k9_delivery.sha256_bytes='f'.repeat(64);},
  m=>{m.k9_delivery.execution_enabled=true;},
  m=>{m.k9_delivery.included_in_k3_reset=true;},
  m=>{m.k9_delivery.path='../unreviewed.sql';},
  m=>{m.k9_delivery.application_order=7;},
  m=>{m.k9_delivery.requires_previous_order=6;},
  m=>{m.k9_delivery.application_tool='arbitrary-executable.py';},
 ]){const manifest=clone();mutate(manifest);assert.ok(codes(await auditMigrations({root,manifest})).includes('K9_DELIVERY_CONTRACT'));}
 assert.equal((await auditMigrations({root})).readiness.ready,false);
});

for(const key of ['k7_payment_day_delivery','k8_delivery'])test(`merged main ${key} stays canonical, non-executable and outside historical replay`,async()=>{
 const entry=source[key];assert.ok(entry);
 const bytes=await fs.readFile(new URL('../'+entry.path,import.meta.url));
 assert.equal(sha256Lf(bytes.toString('utf8')),entry.sha256_bytes);
 assert.equal(entry.execution_enabled,false);assert.equal(entry.included_in_k3_reset,false);
 const missing=clone();delete missing[key];
 assert.ok(codes(await auditMigrations({root,manifest:missing})).includes('UNINVENTORIED_CANONICAL_SQL'));
 for(const mutate of [
  e=>{e.path='../unreviewed.sql';},e=>{e.sha256_bytes='0'.repeat(64);},
  e=>{e.application_order=99;},e=>{e.execution_enabled=true;},
  e=>{e.included_in_k3_reset=true;},e=>{e.application_tool='arbitrary-executable.py';},
 ]){const manifest=clone();mutate(manifest[key]);assert.ok(codes(await auditMigrations({root,manifest})).includes('CURRENT_MAIN_DELIVERY_CONTRACT'));}
 const result=await auditMigrations({root});
 assert.equal(result.readiness.ready,false);assert.equal(result.readiness.execution_performed,false);
 assert.ok(result.proposed_order.every(item=>item.path!==entry.path));
});

test('altered expected checksum fails closed',async()=>{
 const manifest=clone();manifest.sources[0].sha256_lf='0'.repeat(64);
 const result=await auditMigrations({root,manifest});assert.equal(result.integrity.ok,false);assert.ok(codes(result).includes('CHECKSUM_MISMATCH'));
});

test('K10 eligibility inventory pins exact bytes and only the reviewed K9 dependency without an application order',async()=>{
 const entry=source.k10_eligibility_delivery;assert.ok(entry);
 assert.equal(entry.path,'supabase/migrations/20261021000600_campaign_eligibility_check.sql');
 const bytes=await fs.readFile(path.join(root,entry.path));
 assert.equal(bytes.includes(13),false);
 assert.equal(entry.sha256_bytes,'33c9b6d59b024ce325a5461c52b09e374f169d45228980bd11c8f8a974c99285');
 assert.equal(sha256Lf(bytes.toString('utf8')),entry.sha256_bytes);
 assert.deepEqual(entry.requires,[{path:source.k9_delivery.path,sha256_bytes:source.k9_delivery.sha256_bytes}]);
 assert.equal(entry.execution_enabled,false);assert.equal(entry.included_in_k3_reset,false);
 assert.equal(Object.hasOwn(entry,'application_order'),false);
 const result=await auditMigrations({root});assert.equal(result.integrity.ok,true);
 assert.equal(result.readiness.ready,false);assert.equal(result.readiness.execution_performed,false);
 assert.ok(result.proposed_order.every(item=>item.path!==entry.path));
 const missing=clone();delete missing.k10_eligibility_delivery;
 assert.ok(codes(await auditMigrations({root,manifest:missing})).includes('UNINVENTORIED_CANONICAL_SQL'));
});

test('K10 inventory rejects altered identity, execution, replay inclusion and invented application order',async()=>{
 for(const mutate of [
  e=>{e.path='../unreviewed.sql';},e=>{e.sha256_bytes='f'.repeat(64);},
  e=>{e.execution_enabled=true;},e=>{e.included_in_k3_reset=true;},
  e=>{e.application_order=12;},e=>{e.application_tool='arbitrary-executable.py';},
 ]){const manifest=clone();mutate(manifest.k10_eligibility_delivery);
  assert.ok(codes(await auditMigrations({root,manifest})).includes('K10_ELIGIBILITY_DELIVERY_CONTRACT'));
 }
 const replay=clone();replay.proposed_order.push('k10_eligibility_delivery');
 assert.ok(codes(await auditMigrations({root,manifest:replay})).includes('ORDER_UNKNOWN_SOURCE'));
});

test('K10 inventory rejects missing, substituted and extra dependencies including K11 or K15',async()=>{
 for(const mutate of [
  m=>{m.k10_eligibility_delivery.requires=[];},
  m=>{m.k10_eligibility_delivery.requires[0].path='supabase/migrations/20261021000300_loyalty_referrals_metrics.sql';},
  m=>{m.k10_eligibility_delivery.requires[0].sha256_bytes='0'.repeat(64);},
  m=>{m.k10_eligibility_delivery.requires[0].execution_enabled=true;},
  m=>{m.k10_eligibility_delivery.requires.push({path:'supabase/migrations/20261021000500_ops_write_gate.sql',sha256_bytes:'a'.repeat(64)});},
  m=>{delete m.k9_delivery;},
  m=>{m.k9_delivery.sha256_bytes='b'.repeat(64);m.k10_eligibility_delivery.requires[0].sha256_bytes='b'.repeat(64);},
 ]){const manifest=clone();mutate(manifest);
  assert.ok(codes(await auditMigrations({root,manifest})).includes('K10_ELIGIBILITY_DEPENDENCY'));
 }
});

test('K10 raw SQL tampering, CRLF conversion and missing file fail on a disposable inventory copy',async t=>{
 const prefix='nazar-k10-inventory-';const tempBase=path.resolve(os.tmpdir());
 const fixtureRoot=await fs.mkdtemp(path.join(tempBase,prefix));
 t.after(async()=>{
  assert.equal(path.dirname(fixtureRoot),tempBase);
  assert.ok(path.basename(fixtureRoot).startsWith(prefix));
  await fs.rm(fixtureRoot,{recursive:true,force:true});
 });
 for(const relative of ['database','tools/test-env/legacy','supabase/migrations']){
  await fs.cp(path.join(root,relative),path.join(fixtureRoot,relative),{recursive:true});
 }
 assert.equal((await auditMigrations({root:fixtureRoot,manifest:clone()})).integrity.ok,true);
 const file=path.join(fixtureRoot,source.k10_eligibility_delivery.path);
 const original=await fs.readFile(file);
 await fs.writeFile(file,Buffer.concat([original,Buffer.from('-- unreviewed tamper\n')]));
 assert.ok(codes(await auditMigrations({root:fixtureRoot,manifest:clone()})).includes('K10_ELIGIBILITY_DELIVERY_BYTES'));
 await fs.writeFile(file,original.toString('utf8').replaceAll('\n','\r\n'));
 assert.equal(sha256Lf(await fs.readFile(file,'utf8')),source.k10_eligibility_delivery.sha256_bytes,'normalization alone would accept CRLF; the delivery guard must not');
 assert.ok(codes(await auditMigrations({root:fixtureRoot,manifest:clone()})).includes('K10_ELIGIBILITY_DELIVERY_BYTES'));
 await fs.unlink(file);
 assert.ok(codes(await auditMigrations({root:fixtureRoot,manifest:clone()})).includes('K10_ELIGIBILITY_DELIVERY_MISSING'));
 assert.deepEqual(await fs.readFile(path.join(root,source.k10_eligibility_delivery.path)),original,'test must leave the actual migration untouched');
});

test('omitting a baseline SQL file is detected rather than producing a smaller green inventory',async()=>{
 const manifest=clone();manifest.sources=manifest.sources.filter(entry=>entry.id!=='intake_pause');
 assert.ok(codes(await auditMigrations({root,manifest})).includes('UNINVENTORIED_SQL'));
});

test('K10 coupons stay exact-pinned at held order 14 outside replay and reset',async()=>{
 const entry=source.k10_coupon_delivery;assert.ok(entry);
 assert.equal(entry.path,'supabase/migrations/20261021000800_signup_reward_coupons.sql');
 const bytes=await fs.readFile(path.join(root,entry.path));
 assert.equal(bytes.includes(13),false);
 assert.match(entry.sha256_bytes,/^[a-f0-9]{64}$/);
 assert.equal(sha256Lf(bytes.toString('utf8')),entry.sha256_bytes);
 assert.equal(entry.application_order,14);
 assert.equal(entry.execution_enabled,false);assert.equal(entry.included_in_k3_reset,false);
 assert.deepEqual(entry.requires,[
  {path:source.k9_delivery.path,sha256_bytes:source.k9_delivery.sha256_bytes},
  {path:source.k10_eligibility_delivery.path,sha256_bytes:source.k10_eligibility_delivery.sha256_bytes},
 ]);
 const result=await auditMigrations({root});assert.equal(result.integrity.ok,true);
 assert.equal(result.readiness.ready,false);assert.equal(result.readiness.execution_performed,false);
 assert.ok(result.proposed_order.every(item=>item.path!==entry.path));
 assert.ok(result.reviewed_additive.every(item=>item.path!==entry.path));
 const missing=clone();delete missing.k10_coupon_delivery;
 assert.ok(codes(await auditMigrations({root,manifest:missing})).includes('UNINVENTORIED_CANONICAL_SQL'));
});

test('K10 coupon inventory rejects execution, replay inclusion, identity and order changes',async()=>{
 for(const mutate of [
  e=>{e.path='../unreviewed.sql';},e=>{e.sha256_bytes='f'.repeat(64);},
  e=>{e.execution_enabled=true;},e=>{e.included_in_k3_reset=true;},
  e=>{e.application_order=13;},e=>{delete e.application_order;},
  e=>{e.application_tool='arbitrary-executable.py';},
 ]){const manifest=clone();mutate(manifest.k10_coupon_delivery);
  assert.ok(codes(await auditMigrations({root,manifest})).includes('K10_COUPON_DELIVERY_CONTRACT'));
 }
 const replay=clone();replay.proposed_order.push('k10_coupon_delivery');
 assert.ok(codes(await auditMigrations({root,manifest:replay})).includes('ORDER_UNKNOWN_SOURCE'));
});

test('K10 coupon dependency pins cannot omit, substitute or invent prerequisite deliveries',async()=>{
 for(const mutate of [
  m=>{m.k10_coupon_delivery.requires=[];},
  m=>{m.k10_coupon_delivery.requires.pop();},
  m=>{m.k10_coupon_delivery.requires[0].sha256_bytes='0'.repeat(64);},
  m=>{m.k10_coupon_delivery.requires[1].path='supabase/migrations/20261021000700_daily_scheduler.sql';},
  m=>{m.k10_coupon_delivery.requires[1].execution_enabled=true;},
  m=>{m.k10_coupon_delivery.requires.push({path:'supabase/migrations/20261021000500_ops_write_gate.sql',sha256_bytes:'a'.repeat(64)});},
  m=>{delete m.k9_delivery;},m=>{delete m.k10_eligibility_delivery;},
  m=>{m.k9_delivery.sha256_bytes='b'.repeat(64);m.k10_coupon_delivery.requires[0].sha256_bytes='b'.repeat(64);},
  m=>{m.k10_eligibility_delivery.sha256_bytes='b'.repeat(64);m.k10_coupon_delivery.requires[1].sha256_bytes='b'.repeat(64);},
 ]){const manifest=clone();mutate(manifest);
  assert.ok(codes(await auditMigrations({root,manifest})).includes('K10_COUPON_DEPENDENCY'));
 }
});

test('K10 coupon altered SQL, CRLF and missing delivery fail on an isolated inventory copy',async t=>{
 const prefix='nazar-coupon-inventory-';const tempBase=path.resolve(os.tmpdir());
 const fixtureRoot=await fs.mkdtemp(path.join(tempBase,prefix));
 t.after(async()=>{
  assert.equal(path.dirname(fixtureRoot),tempBase);
  assert.ok(path.basename(fixtureRoot).startsWith(prefix));
  await fs.rm(fixtureRoot,{recursive:true,force:true});
 });
 for(const relative of ['database','tools/test-env/legacy','supabase/migrations']){
  await fs.cp(path.join(root,relative),path.join(fixtureRoot,relative),{recursive:true});
 }
 assert.equal((await auditMigrations({root:fixtureRoot,manifest:clone()})).integrity.ok,true);
 const file=path.join(fixtureRoot,source.k10_coupon_delivery.path);
 const original=await fs.readFile(file);
 await fs.writeFile(file,Buffer.concat([original,Buffer.from('-- unreviewed coupon tamper\n')]));
 assert.ok(codes(await auditMigrations({root:fixtureRoot,manifest:clone()})).includes('K10_COUPON_DELIVERY_BYTES'));
 await fs.writeFile(file,original.toString('utf8').replaceAll('\n','\r\n'));
 assert.equal(sha256Lf(await fs.readFile(file,'utf8')),source.k10_coupon_delivery.sha256_bytes);
 assert.ok(codes(await auditMigrations({root:fixtureRoot,manifest:clone()})).includes('K10_COUPON_DELIVERY_BYTES'));
 await fs.unlink(file);
 assert.ok(codes(await auditMigrations({root:fixtureRoot,manifest:clone()})).includes('K10_COUPON_DELIVERY_MISSING'));
 assert.deepEqual(await fs.readFile(path.join(root,source.k10_coupon_delivery.path)),original);
});

test('K4 additive delivery must be inventoried separately and cannot become a K3 replay step',async()=>{
 const missing=clone();missing.reviewed_additive=[];
 assert.ok(codes(await auditMigrations({root,manifest:missing})).includes('UNINVENTORIED_CANONICAL_SQL'));
 const replay=clone();replay.proposed_order.push('k4_suppression_consent_offers');
 assert.ok(codes(await auditMigrations({root,manifest:replay})).includes('ADDITIVE_DELIVERY_CONTRACT'));
 const executable=clone();executable.reviewed_additive[0].executable=true;
 assert.ok(codes(await auditMigrations({root,manifest:executable})).includes('EXECUTABLE_SOURCE'));
});

test('K4 additive has an exact LF-only byte contract while legacy checksums still normalize CRLF',async()=>{
 const file=await fs.readFile(new URL('../supabase/migrations/20261019000200_suppression_consent_offers.sql',import.meta.url));
 assert.equal(file.includes(13),false);
 assert.equal(sha256Lf(file.toString('utf8')),source.reviewed_additive[0].sha256_lf);
 const wrong=clone();wrong.reviewed_additive[0].line_endings='CRLF';
 assert.ok(codes(await auditMigrations({root,manifest:wrong})).includes('ADDITIVE_LF_BYTES_REQUIRED'));
 const altered=clone();altered.reviewed_additive[0].sha256_bytes_at_capture='0'.repeat(64);
 assert.ok(codes(await auditMigrations({root,manifest:altered})).includes('ADDITIVE_LF_BYTES_REQUIRED'));
});

test('K5 preparation stays inventoried, LF-pinned and separate from K3 replay or K4 execution',async()=>{
 const entry=source.reviewed_additive.find(e=>e.id==='k5_klaviyo_profile_sync');assert.ok(entry);
 const file=await fs.readFile(new URL('../'+entry.path,import.meta.url));
 assert.equal(file.includes(13),false);assert.equal(sha256Lf(file.toString('utf8')),entry.sha256_lf);
 assert.equal(entry.sha256_lf,entry.sha256_bytes_at_capture);
 const missing=clone();missing.reviewed_additive=missing.reviewed_additive.filter(e=>e.id!==entry.id);
 assert.ok(codes(await auditMigrations({root,manifest:missing})).includes('UNINVENTORIED_CANONICAL_SQL'));
 for(const mutate of [
  m=>m.proposed_order.push(entry.id),
  m=>{m.reviewed_additive[1].application_tool='tools/test-env/k4-migrate.py';},
  m=>{m.reviewed_additive[1].application_tool='../arbitrary-execution.py';},
  m=>{m.reviewed_additive[1].requires_reviewed_baseline=false;},
 ]){const manifest=clone();mutate(manifest);assert.ok(codes(await auditMigrations({root,manifest})).includes('ADDITIVE_DELIVERY_CONTRACT'));}
 const executable=clone();executable.reviewed_additive[1].executable=true;
 assert.ok(codes(await auditMigrations({root,manifest:executable})).includes('EXECUTABLE_SOURCE'));
 for(const mutate of [m=>{m.reviewed_additive[1].line_endings='CRLF';},m=>{m.reviewed_additive[1].sha256_bytes_at_capture='0'.repeat(64);}]){
  const manifest=clone();mutate(manifest);assert.ok(codes(await auditMigrations({root,manifest})).includes('ADDITIVE_LF_BYTES_REQUIRED'));
 }
 const k4Tool=clone();k4Tool.reviewed_additive[0].application_tool='tools/test-env/k5-migrate.py';
 assert.ok(codes(await auditMigrations({root,manifest:k4Tool})).includes('ADDITIVE_DELIVERY_CONTRACT'));
});

test('emergency pause cannot become a normal replay step',async()=>{
 const manifest=clone();manifest.proposed_order.push('intake_pause');
 assert.ok(codes(await auditMigrations({root,manifest})).includes('EMERGENCY_IN_REPLAY'));
});

test('decision notifications must follow their queue dependency',async()=>{
 const manifest=clone();const index=manifest.proposed_order.indexOf('decision_notifications');
 manifest.proposed_order.splice(index,1);manifest.proposed_order.splice(1,0,'decision_notifications');
 assert.ok(codes(await auditMigrations({root,manifest})).includes('DEPENDENCY_ORDER'));
});

test('duplicate steps and unknown dependencies are rejected',async()=>{
 const manifest=clone();manifest.proposed_order.push('decision_queue');manifest.sources[0].requires.push('missing_source');
 const result=await auditMigrations({root,manifest});assert.ok(codes(result).includes('ORDER_DUPLICATE'));assert.ok(codes(result).includes('DEPENDENCY_ORDER'));
});

test('unsafe paths and executable metadata cannot authorize source execution',async()=>{
 for(const unsafe of ['../outside.sql','C:/outside.sql','database/../outside.sql','database\\outside.sql']){
  const manifest=clone();manifest.sources[0].path=unsafe;manifest.sources[0].executable=true;
  const result=await auditMigrations({root,manifest});assert.ok(codes(result).includes('SOURCE_PATH_REJECTED'));assert.ok(codes(result).includes('EXECUTABLE_SOURCE'));assert.equal(result.readiness.ready,false);
 }
});

test('editing blocker metadata to ready still cannot turn a source inventory into execution proof',async()=>{
 const manifest=clone();manifest.blockers=[];manifest.execution.neutral_baseline='ready';manifest.execution.full_supabase_validation='passed';
 const result=await auditMigrations({root,manifest});assert.equal(result.readiness.ready,false);
 assert.ok(result.readiness.blockers.some(b=>b.id==='INVENTORY_IS_NOT_EXECUTION_PROOF'));
});

test('CLI reports blocked readiness by default; integrity-only success remains explicitly blocked',()=>{
 const script=fileURLToPath(new URL('../tools/test-env/audit-migrations.mjs',import.meta.url));
 const blocked=spawnSync(process.execPath,[script,'--json'],{cwd:root,encoding:'utf8',timeout:15000});
 assert.equal(blocked.status,2,blocked.stderr);assert.equal(JSON.parse(blocked.stdout).readiness.ready,false);
 const inventory=spawnSync(process.execPath,[script,'--integrity-only','--json'],{cwd:root,encoding:'utf8',timeout:15000});
 assert.equal(inventory.status,0,inventory.stderr);const result=JSON.parse(inventory.stdout);assert.equal(result.integrity.ok,true);assert.equal(result.readiness.ready,false);
 const unsupported=spawnSync(process.execPath,[script,'--apply'],{cwd:root,encoding:'utf8',timeout:15000});
 assert.equal(unsupported.status,64);assert.match(unsupported.stderr,/Usage/);
});

test('held K11 is exact-pinned at order 9 after K9 and cannot authorize replay',async()=>{
 const entry=source.k11_delivery;assert.ok(entry);
 assert.equal(entry.path,'supabase/migrations/20261021000300_loyalty_referrals_metrics.sql');
 const bytes=await fs.readFile(new URL('../'+entry.path,import.meta.url));
 assert.equal(bytes.includes(13),false);assert.equal(sha256Lf(bytes.toString('utf8')),entry.sha256_bytes);
 assert.equal(entry.application_order,9);assert.equal(entry.requires_previous_order,8);
 assert.equal(entry.execution_enabled,false);assert.equal(entry.included_in_k3_reset,false);
 const missing=clone();delete missing.k11_delivery;
 assert.ok(codes(await auditMigrations({root,manifest:missing})).includes('UNINVENTORIED_CANONICAL_SQL'));
 for(const mutate of [
  m=>{m.k11_delivery.sha256_bytes='f'.repeat(64);},
  m=>{m.k11_delivery.execution_enabled=true;},
  m=>{m.k11_delivery.included_in_k3_reset=true;},
  m=>{m.k11_delivery.path='../unreviewed.sql';},
  m=>{m.k11_delivery.application_order=8;},
  m=>{m.k11_delivery.requires_previous_order=7;},
  m=>{m.k11_delivery.application_tool='arbitrary-executable.py';},
 ]){const manifest=clone();mutate(manifest);assert.ok(codes(await auditMigrations({root,manifest})).includes('K11_DELIVERY_CONTRACT'));}
 const result=await auditMigrations({root});
 assert.equal(result.readiness.ready,false);assert.equal(result.readiness.execution_performed,false);
 assert.ok(result.proposed_order.every(row=>row.path!==entry.path));
});
