import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {auditMigrations,sha256Lf} from '../tools/test-env/audit-migrations.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const source=JSON.parse(await fs.readFile(new URL('../tools/test-env/migration-manifest.json',import.meta.url),'utf8'));
const clone=()=>structuredClone(source);
const codes=result=>result.integrity.issues.map(issue=>issue.code);

test('inventory verifies all 18 baseline SQL files and historical copy without claiming K3 readiness',async()=>{
 const result=await auditMigrations({root});
 assert.equal(result.integrity.ok,true,JSON.stringify(result.integrity.issues));
 assert.equal(result.integrity.database_sources,18);assert.equal(result.integrity.historical_sources,1);assert.equal(result.integrity.pending_canonical_sources,1);assert.equal(result.integrity.verified_sources,20);
 assert.equal(result.readiness.ready,false);assert.equal(result.readiness.execution_performed,false);assert.equal(result.readiness.state,'BLOCKED');
 assert.ok(result.readiness.blockers.some(b=>b.id==='NEUTRAL_BASELINE_MISSING'));
 assert.ok(result.proposed_order.every(entry=>entry.executable===false));
 assert.deepEqual(result.excluded.map(entry=>entry.id),['intake_pause']);
 assert.deepEqual(result.pending_canonical.map(entry=>entry.id),['test_record_markers']);
});

test('checksum integrity accepts CRLF conversion only and detects changed content',()=>{
 assert.equal(sha256Lf('a\r\nb\r\n'),sha256Lf('a\nb\n'));
 assert.notEqual(sha256Lf('a\nb\n'),sha256Lf('a\nb;\n'));
 assert.notEqual(sha256Lf('a\nb\n'),sha256Lf('a\n b\n'),'SQL whitespace is not silently rewritten');
});

test('altered expected checksum fails closed',async()=>{
 const manifest=clone();manifest.sources[0].sha256_lf='0'.repeat(64);
 const result=await auditMigrations({root,manifest});assert.equal(result.integrity.ok,false);assert.ok(codes(result).includes('CHECKSUM_MISMATCH'));
});

test('omitting a baseline SQL file is detected rather than producing a smaller green inventory',async()=>{
 const manifest=clone();manifest.sources=manifest.sources.filter(entry=>entry.id!=='intake_pause');
 assert.ok(codes(await auditMigrations({root,manifest})).includes('UNINVENTORIED_SQL'));
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
