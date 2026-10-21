import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const defaultRoot=fileURLToPath(new URL('../../',import.meta.url));
const manifestPath='tools/test-env/migration-manifest.json';
const sha=/^[a-f0-9]{64}$/;
// Explicit non-executable delivery inventory policies. A new ID/tool requires a
// code review; a manifest string can never select an arbitrary executable path.
const additivePolicy=new Map([
 ['k4_suppression_consent_offers',{path:'supabase/migrations/20261019000200_suppression_consent_offers.sql',tool:'tools/test-env/k4-migrate.py'}],
 ['k5_klaviyo_profile_sync',{path:'supabase/migrations/20261019000300_klaviyo_profile_sync.sql',tool:'tools/test-env/k5-migrate.py'}],
 ['k6_message_send_gate',{path:'supabase/migrations/20261020000800_message_send_gate.sql',tool:'tools/test-env/k6-migrate.py'}],
]);
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
 const additive=Array.isArray(manifest.reviewed_additive)?manifest.reviewed_additive:[];
 if(additive.some(entry=>entry?.classification!=='reviewed_additive_delivery'))issue('ADDITIVE_DELIVERY_CONTRACT','Reviewed additive entries require their separate non-replay classification.');
 const entries=[...(foundation?[foundation]:[]),...sources,...canonical,...additive];const ids=new Set();const paths=new Set();
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
   if(entry.classification==='reviewed_additive_delivery'
    &&(entry.line_endings!=='LF'||bytes.includes(13)||raw!==entry.sha256_lf||raw!==entry.sha256_bytes_at_capture))
    issue('ADDITIVE_LF_BYTES_REQUIRED',relative);
   if(canonical!==entry.sha256_lf)issue('CHECKSUM_MISMATCH',relative);
   else verified.push(relative);
   capture.push({id:entry.id,path:relative,sha256_lf:canonical,raw_bytes_match_capture:raw===entry.sha256_bytes_at_capture});
  }catch{issue('SOURCE_UNREADABLE',relative);}
  if(entry.classification==='emergency_excluded'){
   if(positions.has(entry.id))issue('EMERGENCY_IN_REPLAY',relative);
  }else if(entry.classification==='pending_canonical_additive'){
   if(positions.has(entry.id)||entry.requires_reviewed_baseline!==true)issue('CANONICAL_BASELINE_REQUIRED',relative);
  }else if(entry.classification==='reviewed_additive_delivery'){
   const policy=additivePolicy.get(entry.id);
   if(positions.has(entry.id)||entry.requires_reviewed_baseline!==true
     ||!policy||relative!==policy.path||entry.application_tool!==policy.tool)issue('ADDITIVE_DELIVERY_CONTRACT',relative);
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
 const opsDelivery=manifest.ops_delivery;
 if(opsDelivery){
  if(opsDelivery.path!=='supabase/migrations/20261020000100_ops_panel.sql'||opsDelivery.execution_enabled!==false||opsDelivery.included_in_k3_reset!==false)issue('OPS_DELIVERY_CONTRACT','Separate held Ops delivery must not enter historical replay.');
  try{const bytes=await fs.readFile(path.join(realRoot,opsDelivery.path));if(bytes.includes(13)||createHash('sha256').update(bytes).digest('hex')!==opsDelivery.sha256_bytes)issue('OPS_DELIVERY_BYTES','Ops LF delivery bytes changed.');}catch{issue('OPS_DELIVERY_MISSING','Ops file missing.');}
 }
 // K7 is an independently reviewed delivery from current main, never a K3
 // replay step. Its exact source identity cannot be selected by manifest data.
 const k7Delivery=manifest.k7_delivery;
 const k7Path='supabase/migrations/20261020000700_clover_order_core.sql';
 const k7Sha='5f68772059d9cd1e1d7a6a290aa31ee32d10ff5a367201577c4058861aada4a8';
 if(k7Delivery){
  if(typeof k7Delivery!=='object'||Object.keys(k7Delivery).sort().join(',')!=='execution_enabled,included_in_k3_reset,path,sha256_bytes'
   ||k7Delivery.path!==k7Path||k7Delivery.sha256_bytes!==k7Sha||k7Delivery.execution_enabled!==false||k7Delivery.included_in_k3_reset!==false)
   issue('K7_DELIVERY_CONTRACT','Reviewed K7 delivery must retain its exact identity and stay outside historical replay.');
  try{const bytes=await fs.readFile(path.join(realRoot,k7Path));if(bytes.includes(13)||createHash('sha256').update(bytes).digest('hex')!==k7Sha)issue('K7_DELIVERY_BYTES','K7 reviewed LF delivery bytes changed.');}catch{issue('K7_DELIVERY_MISSING','K7 file missing.');}
 }
 // PR66 adds the independently reviewed K7 report patch at order 6. Inventory
 // registration cannot enable its execution or include it in K3 reset/replay.
 const k7OptionalDelivery=manifest.k7_optional_scope_delivery;
 const k7OptionalPath='supabase/migrations/20261020000900_clover_optional_scope_status.sql';
 const k7OptionalSha='a3778d0b933c4ce1a56dba04bcadc31b3f6d1c8f214d56af8203a88d6bcc826e';
 if(k7OptionalDelivery){
  if(typeof k7OptionalDelivery!=='object'||Object.keys(k7OptionalDelivery).sort().join(',')!=='application_order,execution_enabled,included_in_k3_reset,path,sha256_bytes'
   ||k7OptionalDelivery.path!==k7OptionalPath||k7OptionalDelivery.sha256_bytes!==k7OptionalSha
   ||k7OptionalDelivery.application_order!==6||k7OptionalDelivery.execution_enabled!==false||k7OptionalDelivery.included_in_k3_reset!==false)
   issue('K7_OPTIONAL_SCOPE_DELIVERY_CONTRACT','Reviewed K7 report patch must retain its exact identity/order and stay outside historical replay.');
  try{const bytes=await fs.readFile(path.join(realRoot,k7OptionalPath));if(bytes.includes(13)||createHash('sha256').update(bytes).digest('hex')!==k7OptionalSha)issue('K7_OPTIONAL_SCOPE_DELIVERY_BYTES','K7 report patch reviewed LF bytes changed.');}catch{issue('K7_OPTIONAL_SCOPE_DELIVERY_MISSING','K7 report patch file missing.');}
 }
 // Held K9 is inventory only: reserving order 8 after K8 cannot authorize
 // execution or insert the new engine into historical K3 reset/replay.
 const k9Delivery=manifest.k9_delivery;
 const k9Path='supabase/migrations/20261021000200_campaign_engine.sql';
 const k9Sha='a8b48363414e134f58379a03f848f4195141bd8c11047a75066d0feb66faba7d';
 if(k9Delivery){
  if(typeof k9Delivery!=='object'||Object.keys(k9Delivery).sort().join(',')!=='application_order,execution_enabled,included_in_k3_reset,path,requires_previous_order,sha256_bytes'
   ||k9Delivery.path!==k9Path||k9Delivery.sha256_bytes!==k9Sha||k9Delivery.application_order!==8
   ||k9Delivery.requires_previous_order!==7||k9Delivery.execution_enabled!==false||k9Delivery.included_in_k3_reset!==false)
   issue('K9_DELIVERY_CONTRACT','Held reviewed K9 must retain its exact identity, wait for K8 and stay outside historical replay.');
  try{const bytes=await fs.readFile(path.join(realRoot,k9Path));if(bytes.includes(13)||createHash('sha256').update(bytes).digest('hex')!==k9Sha)issue('K9_DELIVERY_BYTES','K9 reviewed LF delivery bytes changed.');}catch{issue('K9_DELIVERY_MISSING','K9 file missing.');}
 }
 const k11Delivery=manifest.k11_delivery;
 const k11Path='supabase/migrations/20261021000300_loyalty_referrals_metrics.sql';
 const k11Sha='b33ce7dfca27f354768d84c459bd29faaafb1af73c3afdcc7c3d99f5cbdda9ae';
 if(k11Delivery){
  if(typeof k11Delivery!=='object'||Object.keys(k11Delivery).sort().join(',')!=='application_order,execution_enabled,included_in_k3_reset,path,requires_previous_order,sha256_bytes'
   ||k11Delivery.path!==k11Path||k11Delivery.sha256_bytes!==k11Sha||k11Delivery.application_order!==9
   ||k11Delivery.requires_previous_order!==8||k11Delivery.execution_enabled!==false||k11Delivery.included_in_k3_reset!==false)
   issue('K11_DELIVERY_CONTRACT','Held K11 must retain reviewed bytes/order after K9 and stay outside historical replay.');
  try{const bytes=await fs.readFile(path.join(realRoot,k11Path));if(bytes.includes(13)||createHash('sha256').update(bytes).digest('hex')!==k11Sha)issue('K11_DELIVERY_BYTES','K11 reviewed LF bytes changed.');}catch{issue('K11_DELIVERY_MISSING','K11 file missing.');}
 }
 const k13EngineDelivery=manifest.k13_engine_delivery;
 const k13EnginePath='supabase/migrations/20261021000350_nazar_commission_engine.sql';
 const k13EngineSha='bb17cad3b4cbb21a8f99722c07b9d27d71ab65e34366ccd571949e844d0be509';
 if(k13EngineDelivery){
  if(typeof k13EngineDelivery!=='object'||Object.keys(k13EngineDelivery).sort().join(',')!=='application_order,execution_enabled,included_in_k3_reset,path,requires_previous_order,sha256_bytes'
   ||k13EngineDelivery.path!==k13EnginePath||k13EngineDelivery.sha256_bytes!==k13EngineSha||k13EngineDelivery.application_order!=='9b'
   ||k13EngineDelivery.requires_previous_order!==9||k13EngineDelivery.execution_enabled!==false||k13EngineDelivery.included_in_k3_reset!==false)
   issue('K13_ENGINE_DELIVERY_CONTRACT','K13 commission engine must be order 9b after K11, outside historical replay.');
  try{const bytes=await fs.readFile(path.join(realRoot,k13EnginePath));if(bytes.includes(13)||createHash('sha256').update(bytes).digest('hex')!==k13EngineSha)issue('K13_ENGINE_DELIVERY_BYTES','K13 engine reviewed LF bytes changed.');}catch{issue('K13_ENGINE_DELIVERY_MISSING','K13 engine file missing.');}
 }
 const k13Delivery=manifest.k13_delivery;
 const k13Path='supabase/migrations/20261021000400_commission_from_orders.sql';
 const k13Sha='c0717b848cd75864f9410fdcaae636bc07cdb7581ec70c34efdf57f6eb1703c1';
 if(k13Delivery){
  if(typeof k13Delivery!=='object'||Object.keys(k13Delivery).sort().join(',')!=='application_order,execution_enabled,included_in_k3_reset,path,requires_previous_order,sha256_bytes'
   ||k13Delivery.path!==k13Path||k13Delivery.sha256_bytes!==k13Sha||k13Delivery.application_order!==10
   ||k13Delivery.requires_previous_order!=='9b'||k13Delivery.execution_enabled!==false||k13Delivery.included_in_k3_reset!==false)
   issue('K13_DELIVERY_CONTRACT','K13 must retain reviewed bytes/order after the Nazar commission engine and stay outside historical replay.');
  try{const bytes=await fs.readFile(path.join(realRoot,k13Path));if(bytes.includes(13)||createHash('sha256').update(bytes).digest('hex')!==k13Sha)issue('K13_DELIVERY_BYTES','K13 reviewed LF bytes changed.');}catch{issue('K13_DELIVERY_MISSING','K13 file missing.');}
 }
 // Newly merged main deliveries remain inventory-only. Verify their canonical
 // Git/LF identity without rewriting Windows CRLF checkouts of existing SQL.
 const currentMainDeliveries=[
  {"key":"k10_coupon_delivery_receipts","order":"14a","path":"supabase/migrations/20261021000825_coupon_delivery_reconciliation.sql","sha":"f6e45de3d48f09b154534a902f2ad531d3d99c46000e253cafc4fba1110e1789"},
  {key:'k7_payment_day_delivery',order:'6b',path:'supabase/migrations/20261020001000_clover_payment_day_totals.sql',sha:'2b5b31f9539d04b08a3ca7e85baf8bb7ded828d498ad051c43c83d2f664515cc'},
  {key:'k8_delivery',order:7,path:'supabase/migrations/20261021000100_clover_webhook.sql',sha:'1d305756deba4b614c6e60198ef7c954bca9008bc944be7e4bea52f4ff29a94e'},
 ];
 const k13bDelivery=manifest.k13b_delivery;
 const k13bPath='supabase/migrations/20261021000450_commission_channel_label.sql';
 const k13bSha='1d859b4b56b02b75d9662ba976a1b4f149c53c067c6fd0497e4794cda3e33607';
 if(k13bDelivery){
  if(typeof k13bDelivery!=='object'||Object.keys(k13bDelivery).sort().join(',')!=='application_order,execution_enabled,included_in_k3_reset,path,requires_previous_order,sha256_bytes'
   ||k13bDelivery.path!==k13bPath||k13bDelivery.sha256_bytes!==k13bSha||k13bDelivery.application_order!=='10b'
   ||k13bDelivery.requires_previous_order!==10||k13bDelivery.execution_enabled!==false||k13bDelivery.included_in_k3_reset!==false)
   issue('K13B_DELIVERY_CONTRACT','K13b must follow K13 and stay outside historical replay.');
  try{const bytes=await fs.readFile(path.join(realRoot,k13bPath));if(bytes.includes(13)||createHash('sha256').update(bytes).digest('hex')!==k13bSha)issue('K13B_DELIVERY_BYTES',k13bPath);}
  catch{issue('K13B_DELIVERY_MISSING',k13bPath);}
 }
 for(const policy of currentMainDeliveries){
  const entry=manifest[policy.key];if(!entry)continue;
  if(typeof entry!=='object'||Object.keys(entry).sort().join(',')!=='application_order,execution_enabled,included_in_k3_reset,path,sha256_bytes'
   ||entry.path!==policy.path||entry.sha256_bytes!==policy.sha||entry.application_order!==policy.order
   ||entry.execution_enabled!==false||entry.included_in_k3_reset!==false)
   issue('CURRENT_MAIN_DELIVERY_CONTRACT',policy.key);
  try{const bytes=await fs.readFile(path.join(realRoot,policy.path));if(sha256Lf(bytes.toString('utf8'))!==policy.sha)issue('CURRENT_MAIN_DELIVERY_BYTES',policy.path);}
  catch{issue('CURRENT_MAIN_DELIVERY_MISSING',policy.path);}
 }
 // K10 is an inventory-only forward delivery over these exact K9 bytes. This
 // records a reviewed dependency, not a global application order or permission
 // to execute it. Neither K11 nor K15 is a prerequisite of the read-only check.
 const k10Eligibility=manifest.k10_eligibility_delivery;
 const k10Path='supabase/migrations/20261021000600_campaign_eligibility_check.sql';
 const k10Sha='33c9b6d59b024ce325a5461c52b09e374f169d45228980bd11c8f8a974c99285';
 if(k10Eligibility){
  if(typeof k10Eligibility!=='object'||Object.keys(k10Eligibility).sort().join(',')!=='execution_enabled,included_in_k3_reset,path,requires,sha256_bytes'
   ||k10Eligibility.path!==k10Path||k10Eligibility.sha256_bytes!==k10Sha
   ||k10Eligibility.execution_enabled!==false||k10Eligibility.included_in_k3_reset!==false)
   issue('K10_ELIGIBILITY_DELIVERY_CONTRACT','K10 must retain its exact non-executable identity outside K3 reset/replay, without an application order.');
  const dependency=Array.isArray(k10Eligibility.requires)&&k10Eligibility.requires.length===1?k10Eligibility.requires[0]:null;
  if(!dependency||typeof dependency!=='object'||Object.keys(dependency).sort().join(',')!=='path,sha256_bytes'
   ||dependency.path!==k9Path||dependency.sha256_bytes!==k9Sha
   ||!k9Delivery||k9Delivery.path!==k9Path||k9Delivery.sha256_bytes!==k9Sha)
   issue('K10_ELIGIBILITY_DEPENDENCY','K10 requires the exact reviewed K9 path and bytes; no substituted or additional dependency is accepted.');
  try{const bytes=await fs.readFile(path.join(realRoot,k10Path));if(bytes.includes(13)||createHash('sha256').update(bytes).digest('hex')!==k10Sha)issue('K10_ELIGIBILITY_DELIVERY_BYTES','K10 reviewed LF delivery bytes changed.');}catch{issue('K10_ELIGIBILITY_DELIVERY_MISSING','K10 eligibility file missing.');}
 }
 // K10 signup-reward preparation is held at reviewed order 14. The exact
 // reviewed K9 and read-only K10 sources are its dependencies; inventory does
 // not install it, activate a campaign/flow, or add it to K3 reset/replay.
 const k10Coupons=manifest.k10_coupon_delivery;
 const k10CouponPath='supabase/migrations/20261021000800_signup_reward_coupons.sql';
 const k10CouponSha='b0d27ed1a76763ff79ac28fec7d443b87daf425ecc7bb15b0273c49b46548626';
 if(k10Coupons){
  if(typeof k10Coupons!=='object'||Object.keys(k10Coupons).sort().join(',')!=='application_order,execution_enabled,included_in_k3_reset,path,requires,sha256_bytes'
   ||k10Coupons.path!==k10CouponPath||k10Coupons.sha256_bytes!==k10CouponSha
   ||k10Coupons.application_order!==14||k10Coupons.execution_enabled!==false||k10Coupons.included_in_k3_reset!==false)
   issue('K10_COUPON_DELIVERY_CONTRACT','Held signup-reward coupons must keep their reviewed identity/order without execution or K3 replay inclusion.');
  const dependencies=Array.isArray(k10Coupons.requires)?k10Coupons.requires:[];
  const expected=[{path:k9Path,sha256_bytes:k9Sha},{path:k10Path,sha256_bytes:k10Sha}];
  if(dependencies.length!==expected.length||dependencies.some((d,index)=>!d||typeof d!=='object'
   ||Object.keys(d).sort().join(',')!=='path,sha256_bytes'
   ||d.path!==expected[index]?.path||d.sha256_bytes!==expected[index]?.sha256_bytes)
   ||!k9Delivery||k9Delivery.path!==k9Path||k9Delivery.sha256_bytes!==k9Sha
   ||!k10Eligibility||k10Eligibility.path!==k10Path||k10Eligibility.sha256_bytes!==k10Sha)
   issue('K10_COUPON_DEPENDENCY','Signup-reward coupons require exactly the reviewed K9 and K10 eligibility sources.');
  try{const bytes=await fs.readFile(path.join(realRoot,k10CouponPath));if(bytes.includes(13)||createHash('sha256').update(bytes).digest('hex')!==k10CouponSha)issue('K10_COUPON_DELIVERY_BYTES','Signup-reward coupon reviewed LF delivery bytes changed.');}catch{issue('K10_COUPON_DELIVERY_MISSING','Signup-reward coupon file missing.');}
 }
 const declaredCanonical=[...canonical,...additive].map(entry=>entry?.path).filter(p=>typeof p==='string').concat(opsDelivery?[opsDelivery.path]:[],k7Delivery?[k7Path]:[],k7OptionalDelivery?[k7OptionalPath]:[],k9Delivery?[k9Path]:[],k11Delivery?[k11Path]:[],k13EngineDelivery?[k13EnginePath]:[],k13Delivery?[k13Path]:[],k13bDelivery?[k13bPath]:[],k10Eligibility?[k10Path]:[],k10Coupons?[k10CouponPath]:[],currentMainDeliveries.filter(p=>manifest[p.key]).map(p=>p.path));
 for(const file of actualCanonical)if(!declaredCanonical.includes(file))issue('UNINVENTORIED_CANONICAL_SQL',file);
 const held=manifest.baseline?.held_ops_path;
 if(held!=='supabase/migrations/20261018_ops_panel.sql')issue('HELD_SCOPE_INVALID','Expected held PR53 migration boundary.');
 else{try{await fs.access(path.join(realRoot,held));issue('HELD_OPS_MIGRATION_PRESENT','PR53 is held outside this baseline.');}catch{/* expected absent */}}
 // A source inventory cannot certify a completed database installation even if
 // someone deletes the declared blocker list or sets metadata to "ready".
 const blockers=[...(Array.isArray(manifest.blockers)?manifest.blockers:[]),{
  id:'INVENTORY_IS_NOT_EXECUTION_PROOF',detail:'No reviewed canonical migration replay or actual new Supabase test-project runtime validation is performed by this command.'
 }];
 return {audit:'K3 historical migration source inventory',mode:'read_only',baseline:manifest.baseline||null,
  integrity:{ok:issues.length===0,issues,verified_sources:verified.length,database_sources:actual.length,historical_sources:foundation?1:0,pending_canonical_sources:canonical.length,reviewed_additive_sources:additive.length},
  readiness:{scope:'historical_chain_not_current_reviewed_dump',ready:false,state:'BLOCKED',execution_performed:false,blockers},
  proposed_order:order.map(id=>{const e=entries.find(entry=>entry?.id===id);return {id,path:e?.path||null,executable:false};}),
  excluded:sources.filter(entry=>entry?.classification==='emergency_excluded').map(entry=>({id:entry.id,path:entry.path,reason:entry.reason})),
  pending_canonical:canonical.map(entry=>({id:entry.id,path:entry.path,requires_reviewed_baseline:true,executable:false})),
  reviewed_additive:additive.map(entry=>({id:entry.id,path:entry.path,requires_reviewed_baseline:true,executable:false,included_in_k3_reset:false,application_tool:entry.application_tool})),
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
