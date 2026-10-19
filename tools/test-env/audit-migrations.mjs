import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const defaultRoot=fileURLToPath(new URL('../../',import.meta.url));
const manifestPath='tools/test-env/migration-manifest.json';
const sha=/^[a-f0-9]{64}$/;
export const sha256Lf=text=>createHash('sha256').update(text.replace(/\r\n/g,'\n'),'utf8').digest('hex');

// Inventory only: no subprocess, database driver, network, secret environment
// lookup, SQL rewriting or SQL execution is part of this module.
export async function auditMigrations({root=defaultRoot,manifest:provided}={}){
 const issues=[];const capture=[];const verified=[];
 const issue=(code,detail)=>issues.push({code,detail});
 const realRoot=await fs.realpath(root);
 let manifest=provided;
 if(!manifest){
  try{manifest=JSON.parse(await fs.readFile(path.join(realRoot,manifestPath),'utf8'));}
  catch{issue('MANIFEST_UNREADABLE',manifestPath);}
 }
 if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))manifest={};
 if(manifest.version!==1||manifest.mode!=='read_only_inventory')issue('MANIFEST_CONTRACT','Expected v1 read-only inventory.');
 if(manifest.execution?.enabled!==false)issue('EXECUTION_FORBIDDEN','Inventory cannot enable migration execution.');
 const sources=Array.isArray(manifest.sources)?manifest.sources:[];
 const foundation=manifest.foundation;
 if(!foundation||typeof foundation!=='object'||foundation.id!=='foundation')issue('FOUNDATION_UNDECLARED','Historical foundation must remain identified separately.');
 const canonical=Array.isArray(manifest.canonical_replay?.pending_additive)?manifest.canonical_replay.pending_additive:[];
 const entries=[...(foundation?[foundation]:[]),...sources,...canonical];const ids=new Set();const paths=new Set();
 const order=Array.isArray(manifest.proposed_order)?manifest.proposed_order:[];
 const positions=new Map();
 for(const [index,id]of order.entries()){
  if(typeof id!=='string'||positions.has(id))issue('ORDER_DUPLICATE','Proposed order must contain unique source IDs.');
  positions.set(id,index);
 }
 for(const entry of entries){
  if(!entry||typeof entry!=='object'){issue('SOURCE_INVALID','Source entry is not an object.');continue;}
  if(typeof entry.id!=='string'||ids.has(entry.id))issue('SOURCE_DUPLICATE','Source IDs must be unique.');
  ids.add(entry.id);
  if(entry.executable!==false)issue('EXECUTABLE_SOURCE',String(entry.id));
  const relative=entry.path;
  if(typeof relative!=='string'||!relative||relative.includes('\\')||relative.includes('\0')
    ||path.isAbsolute(relative)||/^[a-z]:/i.test(relative)||relative.split('/').some(p=>p==='..'||p==='.'||!p)
    ||!(/^(?:database\/[^/]+\.sql|tools\/test-env\/legacy\/01_KURULUM\.sql|supabase\/migrations\/[0-9]+_[a-z0-9_]+\.sql)$/.test(relative))){
   issue('SOURCE_PATH_REJECTED',String(entry.id));continue;
  }
  if(paths.has(relative))issue('SOURCE_PATH_DUPLICATE',relative);paths.add(relative);
  if(!sha.test(entry.sha256_lf||'')||!sha.test(entry.sha256_bytes_at_capture||''))issue('CHECKSUM_INVALID',relative);
  try{
   const candidate=await fs.realpath(path.join(realRoot,relative));
   const relation=path.relative(realRoot,candidate);
   if(relation.startsWith('..'+path.sep)||relation==='..'||path.isAbsolute(relation)){issue('SOURCE_PATH_ESCAPE',relative);continue;}
   const bytes=await fs.readFile(candidate);const canonical=sha256Lf(bytes.toString('utf8'));
   const raw=createHash('sha256').update(bytes).digest('hex');
   if(canonical!==entry.sha256_lf)issue('CHECKSUM_MISMATCH',relative);
   else verified.push(relative);
   capture.push({id:entry.id,path:relative,sha256_lf:canonical,raw_bytes_match_capture:raw===entry.sha256_bytes_at_capture});
  }catch{issue('SOURCE_UNREADABLE',relative);}
  if(entry.classification==='emergency_excluded'){
   if(positions.has(entry.id))issue('EMERGENCY_IN_REPLAY',relative);
  }else if(entry.classification==='pending_canonical_additive'){
   if(positions.has(entry.id)||entry.requires_reviewed_baseline!==true)issue('CANONICAL_BASELINE_REQUIRED',relative);
  }else if(!positions.has(entry.id))issue('SOURCE_MISSING_FROM_ORDER',relative);
  if(entry.requires!==undefined&&!Array.isArray(entry.requires))issue('DEPENDENCY_INVALID',String(entry.id));
  if(positions.has(entry.id))for(const dependency of Array.isArray(entry.requires)?entry.requires:[]){
   if(!positions.has(dependency)||positions.get(dependency)>=positions.get(entry.id))issue('DEPENDENCY_ORDER',`${entry.id} requires earlier ${dependency}`);
  }
 }
 for(const id of order)if(!ids.has(id))issue('ORDER_UNKNOWN_SOURCE',String(id));
 let actual=[];
 try{actual=(await fs.readdir(path.join(realRoot,'database'))).filter(name=>name.endsWith('.sql')).map(name=>'database/'+name).sort();}
 catch{issue('DATABASE_DIRECTORY_MISSING','database/');}
 const declared=sources.map(entry=>entry?.path).filter(p=>typeof p==='string').sort();
 for(const file of actual)if(!declared.includes(file))issue('UNINVENTORIED_SQL',file);
 for(const file of declared)if(!actual.includes(file))issue('MISSING_DATABASE_SQL',file);
 let actualCanonical=[];
 try{actualCanonical=(await fs.readdir(path.join(realRoot,'supabase/migrations'))).filter(name=>name.endsWith('.sql')).map(name=>'supabase/migrations/'+name).sort();}
 catch{/* A pending canonical directory may not exist before preparation. */}
 const declaredCanonical=canonical.map(entry=>entry?.path).filter(p=>typeof p==='string');
 for(const file of actualCanonical)if(!declaredCanonical.includes(file))issue('UNINVENTORIED_CANONICAL_SQL',file);
 const held=manifest.baseline?.held_ops_path;
 if(held!=='supabase/migrations/20261018_ops_panel.sql')issue('HELD_SCOPE_INVALID','Expected held PR53 migration boundary.');
 else{try{await fs.access(path.join(realRoot,held));issue('HELD_OPS_MIGRATION_PRESENT','PR53 is held outside this baseline.');}catch{/* expected absent */}}
 // A source inventory cannot certify a completed database installation even if
 // someone deletes the declared blocker list or sets metadata to "ready".
 const blockers=[...(Array.isArray(manifest.blockers)?manifest.blockers:[]),{
  id:'INVENTORY_IS_NOT_EXECUTION_PROOF',detail:'No reviewed canonical migration replay or actual new Supabase test-project runtime validation is performed by this command.'
 }];
 return {audit:'K3 migration source inventory',mode:'read_only',baseline:manifest.baseline||null,
  integrity:{ok:issues.length===0,issues,verified_sources:verified.length,database_sources:actual.length,historical_sources:foundation?1:0,pending_canonical_sources:canonical.length},
  readiness:{ready:false,state:'BLOCKED',execution_performed:false,blockers},
  proposed_order:order.map(id=>{const e=entries.find(entry=>entry?.id===id);return {id,path:e?.path||null,executable:false};}),
  excluded:sources.filter(entry=>entry?.classification==='emergency_excluded').map(entry=>({id:entry.id,path:entry.path,reason:entry.reason})),
  pending_canonical:canonical.map(entry=>({id:entry.id,path:entry.path,requires_reviewed_baseline:true,executable:false})),
  checksums:capture};
}

const isCli=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isCli){
 const flags=process.argv.slice(2);
 if(flags.some(flag=>!['--json','--integrity-only'].includes(flag))){
  console.error('Usage: node tools/test-env/audit-migrations.mjs [--json] [--integrity-only]');process.exitCode=64;
 }else{
  try{
   const result=await auditMigrations();
   console.log(JSON.stringify(result,null,2));
   process.exitCode=result.integrity.ok&&flags.includes('--integrity-only')?0:2;
  }catch{
   console.error(JSON.stringify({audit:'K3 migration source inventory',integrity:{ok:false},readiness:{ready:false,state:'BLOCKED'},error:'AUDIT_UNAVAILABLE'}));process.exitCode=2;
  }
 }
}
