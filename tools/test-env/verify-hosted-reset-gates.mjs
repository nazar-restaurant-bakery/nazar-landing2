// Concrete, offline K3 prerequisite verification. No database, browser, network,
// password or reset operation is available from this module.
import {readFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,dirname,join,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateRecoveryPackage} from './recovery-validation.mjs';

const REPO=resolve(fileURLToPath(new URL('../..',import.meta.url)));
export const BASELINE_SHA256='f3583bb461ba8ae50dea04ae03d6c5c4dbe729aacdec1ed7dd57982b7e25d230';
const MARKERS_SHA256='bd5100fbc165d9dffee77b1199d5e346c5b2611ae665c46f42608aaaa645de90';
const HASH=/^[a-f0-9]{64}$/;
const REF=/^[a-z]{20}$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
class GateError extends Error{}
const requireGate=(condition,code)=>{if(!condition)throw new GateError(code);};
const inside=(root,path)=>path===root || path.startsWith(root+sep);
const keyFor=(root,path)=>relative(root,path).split(sep).join('/');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export async function verifyHostedResetGates(config={}){
 const hashes={},reads=new Map();
 let sandboxRef,productionRef;
 try{
  requireGate(REF.test(config.expectedTestRef||'') && REF.test(config.expectedProdRef||'')
   && config.expectedTestRef!==config.expectedProdRef,'DISTINCT_EXPECTED_PROJECT_REFS_REQUIRED');
  sandboxRef=config.expectedTestRef;productionRef=config.expectedProdRef;
  requireGate(isAbsolute(config.evidenceRoot||''),'ABSOLUTE_EVIDENCE_ROOT_REQUIRED');
  const root=resolve(config.evidenceRoot);
  // Every input and ancestor must be an ordinary private local path outside Git.
  async function safe(path,base=root,directory=false){
   requireGate(typeof path==='string' && isAbsolute(path),'ABSOLUTE_ARTIFACT_PATH_REQUIRED');
   path=resolve(path);requireGate(inside(base,path),'ARTIFACT_OUTSIDE_EVIDENCE_ROOT');
   let current=path;
   for(;;){
    const st=await lstat(current);requireGate(!st.isSymbolicLink(),'LINKED_ARTIFACT_REFUSED');
    if(current===path)requireGate(directory?st.isDirectory():st.isFile(),'NONREGULAR_ARTIFACT_REFUSED');
    if(current!==path || directory){
     try{await lstat(join(current,'.git'));throw new GateError('PRIVATE_ARTIFACT_INSIDE_GIT');}
     catch(error){if(error instanceof GateError)throw error;if(error.code!=='ENOENT')throw error;}
    }
    const parent=dirname(current);if(parent===current)break;current=parent;
   }
   return path;
  }
  await safe(root,root,true);
  async function read(path,{repo=false}={}){
   const base=repo?REPO:root;
   // Repository public sources are bounded regular files; private inputs also
   // reject Git ancestry and links through safe().
   path=resolve(path);
   if(repo){requireGate(inside(REPO,path),'REPO_SOURCE_OUTSIDE_ROOT');const st=await lstat(path);requireGate(st.isFile()&&!st.isSymbolicLink(),'REPO_SOURCE_UNSAFE');}
   else await safe(path,base);
   const st=await lstat(path);requireGate(st.size>0&&st.size<=64*1024*1024,'ARTIFACT_SIZE_INVALID');
   const bytes=await readFile(path);const hash=sha(bytes);
   const key=(repo?'repo/':'evidence/')+keyFor(base,path);
   requireGate(!reads.has(path)||reads.get(path).hash===hash,'ARTIFACT_CHANGED_DURING_VERIFICATION');
   reads.set(path,{hash,repo});hashes[key]=hash;return bytes;
  }
  const text=async path=>{const b=await read(path);const t=b.toString('utf8');requireGate(Buffer.from(t,'utf8').equals(b),'ARTIFACT_INVALID_UTF8');return t;};
  const json=async path=>JSON.parse(await text(path));
  const fixed=(name)=>join(root,name);
  const checkHash=async(path,expected)=>requireGate(HASH.test(expected||'')&&sha(await read(path))===expected,'ARTIFACT_HASH_MISMATCH');
  const observed=[];
  function date(value,code,{fresh=false}={}){
   const instant=Date.parse(value);const now=Date.now();
   requireGate(typeof value==='string'&&Number.isFinite(instant)&&instant<=now+5*60000,code);
   if(fresh)requireGate(now-instant<=24*3600000,'OPERATIONAL_RECEIPT_STALE');
   observed.push(instant);return instant;
  }
  async function capture(path,mode,ref){
   await safe(path,root,true);
   const manifestPath=join(path,'capture-manifest.json');const manifest=await json(manifestPath);
   requireGate(manifest.mode===mode&&manifest.source_project_ref===ref&&same(manifest.schemas,['core','public'])
    &&manifest.read_only===true&&manifest.tls==='verify-full'&&manifest.schema_data_exported===false
    &&manifest.replay_ready===false,'CAPTURE_TARGET_OR_SCOPE_INVALID');
   date(manifest.captured_at,'CAPTURE_TIME_INVALID');
   requireGate(same(await read(manifestPath),await read(join(path,'source-proof.json'))),'CAPTURE_SOURCE_RECEIPT_MISMATCH');
   const files=['catalog.json','raw-schema.dump','raw-toc.list','allowlist-review.json','schema.sql'];
   if(mode==='SANDBOX')files.push('catering-orders.json','staff-anonymous.json','recovery-source-proof.json');
   requireGate(same(Object.keys(manifest.files||{}).sort(),files.slice().sort()),'CAPTURE_FILE_SET_INVALID');
   for(const name of files)await checkHash(join(path,name),manifest.files[name]);
   requireGate(mode==='PRODUCTION'?manifest.data_exported===false&&manifest.syntheticRowsExported===0:
    manifest.data_exported===true&&manifest.syntheticRowsExported===4&&manifest.anonymousStaffRowsExported===1,'CAPTURE_ROW_SCOPE_INVALID');
   const catalog=await json(join(path,'catalog.json'));
   requireGate(catalog.read_only==='on'&&Array.isArray(catalog.objects),'CAPTURE_CATALOG_NOT_READ_ONLY');
   return {path,manifest,manifestHash:sha(await read(manifestPath))};
  }
  async function reviewed(cap,path,sandbox=false){
   requireGate(dirname(resolve(path))===cap.path,'REVIEW_DIRECTORY_NOT_CAPTURE_CHILD');await safe(path,root,true);
   const proof=await json(join(path,sandbox?'sandbox-recovery-proof.json':'baseline-proof.json'));
   requireGate(proof.version===1&&proof.source===(sandbox?'actual_sandbox_read_only_capture':'actual_production_schema_archive')
    &&proof.status===(sandbox?'REVIEWED_SANDBOX_RECOVERY_NOT_RESTORED':'REVIEWED_SQL_RENDERED_NOT_RESTORED')
    &&proof.capture_manifest_sha256===cap.manifestHash&&proof.remote_connection===false,'REVIEW_PROVENANCE_INVALID');
   requireGate(typeof proof.review_filename==='string'&&/^[A-Za-z0-9_.-]+\.json$/.test(proof.review_filename),'REVIEW_FILENAME_UNSAFE');
   const reviewPath=join(cap.path,proof.review_filename);await checkHash(reviewPath,proof.review_sha256);
   const review=await json(reviewPath);
   requireGate(review.version===1&&review.review_complete===true&&typeof review.reviewer==='string'&&review.reviewer.trim()
    &&review.capture_archive_sha256===cap.manifest.files['raw-schema.dump'],'EXPLICIT_ARCHIVE_REVIEW_REQUIRED');
   for(const k of ['private_core_verified','function_acl_verified','policy_set_verified','definer_search_path_verified'])
    requireGate(review.security_review?.[k]===true,'SECURITY_REVIEW_INCOMPLETE');
   if(sandbox)for(const k of ['all_complete_order_values_reviewed_synthetic','anonymous_staff_metadata_reviewed','local_execution_no_external_io_reviewed'])
    requireGate(review.recovery_review?.[k]===true,'RECOVERY_CONTENT_REVIEW_INCOMPLETE');
   const rawLines=(await text(join(cap.path,'raw-toc.list'))).split(/\r?\n/).filter(v=>v&&!v.startsWith(';'));
   const byId=new Map(rawLines.map(line=>[Number(line.match(/^(\d+); /)?.[1]),line]));
   requireGate(byId.size===rawLines.length&&Array.isArray(review.entries)&&review.entries.length===rawLines.length,'EVERY_TOC_ENTRY_REQUIRES_REVIEW');
   const decisions=new Map();
   for(const d of review.entries){
    requireGate(Number.isInteger(d.dump_id)&&byId.has(d.dump_id)&&!decisions.has(d.dump_id)&&typeof d.include==='boolean'
     &&typeof d.reason==='string'&&d.reason.trim(),'TOC_DECISION_INVALID');decisions.set(d.dump_id,d);
    if(d.include)requireGate(d.application_object===true&&!d.forced_exclusion,'PLATFORM_OR_UNREVIEWED_ENTRY_INCLUDED');
   }
   const selected=rawLines.filter(line=>decisions.get(Number(line.match(/^(\d+); /)[1])).include);
   requireGate(selected.length===proof.selected_entries&&selected.length>0,'REVIEW_SELECTION_COUNT_MISMATCH');
   const toc=join(path,'reviewed-toc.list');await checkHash(toc,proof.reviewed_toc_sha256);
   requireGate(await text(toc)===selected.join('\n')+'\n','REVIEWED_TOC_SELECTION_MISMATCH');
   await checkHash(join(path,'reviewed-baseline.sql'),proof.baseline_sha256);
   return {path,proof};
  }
  const prodCapture=await capture(resolve(config.productionCapture||''),'PRODUCTION',productionRef);
  const sandboxPath=dirname(resolve(config.sandboxReviewed||''));
  const sandboxCapture=await capture(sandboxPath,'SANDBOX',sandboxRef);
  const prod=await reviewed(prodCapture,resolve(config.productionReviewed||''));
  const sandbox=await reviewed(sandboxCapture,resolve(config.sandboxReviewed||''),true);
  requireGate(prod.proof.baseline_sha256===BASELINE_SHA256&&prod.proof.archive_sha256===prodCapture.manifest.files['raw-schema.dump'],'REVIEWED_BASELINE_PIN_MISMATCH');
  const baseline=join(REPO,'supabase/baselines/20261019_application_schema.sql');
  requireGate(sha(await read(baseline,{repo:true}))===BASELINE_SHA256,'REPO_BASELINE_PIN_MISMATCH');
  requireGate(sha(await read(join(REPO,'supabase/migrations/20261019000100_test_record_markers.sql'),{repo:true}))===MARKERS_SHA256,'MARKER_SOURCE_PIN_MISMATCH');

  const prodLocal=resolve(config.productionLocalRestore||'');
  const sandboxLocal=resolve(config.sandboxLocalRestore||'');
  requireGate(dirname(prodLocal)===prod.path&&dirname(sandboxLocal)===sandbox.path,'LOCAL_RESTORE_NOT_REVIEW_CHILD');
  const prodReport=await json(join(prodLocal,'local-restore-report.json'));
  const recoveryReport=await json(join(sandboxLocal,'sandbox-local-restore-report.json'));
  for(const r of [prodReport,recoveryReport])requireGate(r.server_started===true&&r.server_stopped===true&&r.ddl_restore_succeeded===true
   &&r.remote_connection===false&&r.real_jwt_validation===false&&r.error===null,'LOCAL_RESTORE_NOT_SUCCESSFUL');
  requireGate(prodReport.baseline_sha256===BASELINE_SHA256&&prodReport.baseline_bytes_preserved===true,'PRODUCTION_LOCAL_RESTORE_HASH_MISMATCH');
  requireGate(recoveryReport.baseline_sha256===sandbox.proof.baseline_sha256&&recoveryReport.orders_sha256===sandboxCapture.manifest.files['catering-orders.json']
   &&recoveryReport.orders_restore_succeeded===true&&recoveryReport.readback_matches===true&&recoveryReport.source_bytes_preserved===true
   &&recoveryReport.capture_and_review_provenance_preserved===true&&recoveryReport.staff_identity_restored===false,'RECOVERY_LOCAL_RESTORE_NOT_VERIFIED');
  const packagePath=join(sandbox.path,'derived-recovery');await safe(packagePath,root,true);
  for(const name of ['schema.sql','catering-orders.json','staff-anonymous.json','recovery-source-proof.json'])
   await checkHash(join(packagePath,name),sandbox.proof.derived_files?.[name]);
  requireGate(sandbox.proof.derived_files['catering-orders.json']===sandboxCapture.manifest.files['catering-orders.json']
   &&sandbox.proof.derived_files['staff-anonymous.json']===sandboxCapture.manifest.files['staff-anonymous.json'],'RECOVERY_DERIVATIVE_BYTES_CHANGED');
  const readbackText=await text(join(sandboxLocal,'catering-orders-readback.json'));
  const recomputed=await validateRecoveryPackage(packagePath,{readbackText});
  requireGate(recomputed.packageIntegrityVerified===true&&recomputed.localReadback.matches===true
   &&recomputed.counts.cateringOrders===4&&recomputed.counts.anonymousStaffMappings===1,'RECOVERY_FULL_READBACK_INVALID');
  const recorded=await json(join(sandboxLocal,'readback-validation.json'));
  requireGate(recorded.packageIntegrityVerified===true&&recorded.localReadback?.matches===true&&recorded.issues?.length===0,'RECOVERY_READBACK_RECEIPT_INVALID');

  const sourceSecurity=await json(fixed('production-effective-privileges.json'));
  const localInventory=await json(join(prodLocal,'06_private_security_inventory.json'));
  requireGate(sourceSecurity.read_only==='on'&&localInventory.exit_code===0&&localInventory.timed_out===false,'SECURITY_SOURCE_OR_LOCAL_READ_INVALID');
  const inventory=JSON.parse(localInventory.stdout);
  const normalize=(rows,local=false)=>rows.map(r=>({schema:r.schema,name:r.name,args:r.args,
   anon:r[local?'execute_anon':'anon'],authenticated:r[local?'execute_authenticated':'authenticated'],service_role:r[local?'execute_service_role':'service_role']}))
   .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  requireGate(sourceSecurity.routines?.length===32&&inventory.routines?.length===32
   &&same(normalize(sourceSecurity.routines),normalize(inventory.routines,true)),'EFFECTIVE_FUNCTION_PRIVILEGES_DIFFER');
  const roles=rows=>rows.map(({name,inherit,superuser,bypass_rls})=>({name,inherit,superuser,bypass_rls})).sort((a,b)=>a.name.localeCompare(b.name));
  requireGate(same(roles(sourceSecurity.roles),roles(inventory.role_attributes)),'ROLE_ATTRIBUTES_DIFFER');
  for(const role of ['anon','authenticated','service_role'])requireGate(sourceSecurity.core_usage?.[role]===false&&inventory['core_'+role+'_usage']===false,'CORE_USAGE_NOT_PRIVATE');
  requireGate(inventory.tables?.length===16&&inventory.tables.every(t=>t.rls===true)
   &&inventory.routines.every(r=>same(r.settings,['search_path=""'])),'BASELINE_RLS_OR_SEARCH_PATH_CHANGED');

  const health=await json(config.healthReceipt?resolve(config.healthReceipt):fixed('sandbox-health-current.json'));
  requireGate(health.projectRef===sandboxRef&&health.healthy===true&&health.restartRequired===false
   &&Number.isFinite(Date.parse(health.readOnlyMetadataSucceededAt)),'CURRENT_HEALTH_NOT_VERIFIED');
  date(health.observedAtUtc,'HEALTH_TIME_INVALID',{fresh:true});date(health.readOnlyMetadataSucceededAt,'HEALTH_READ_TIME_INVALID',{fresh:true});
  requireGate(Array.isArray(health.sourceFiles)&&health.sourceFiles.length>=1,'HEALTH_SOURCE_FILES_REQUIRED');
  let healthText=false;
  for(const source of health.sourceFiles){
   requireGate(typeof source.path==='string'&&!isAbsolute(source.path),'HEALTH_SOURCE_PATH_INVALID');
   const path=resolve(root,source.path);await checkHash(path,source.sha256);
   if(source.path.endsWith('.txt')){
    const ax=await text(path);healthText ||=ax.includes('/project/'+sandboxRef)&&/\bHealthy\b/.test(ax)&&ax.includes('No security, performance or health issues found');
   }
  }
  requireGate(healthText,'HEALTH_FULL_SOURCE_NOT_BOUND');

  const origin=config.legacyPagesOrigin;
  requireGate(typeof origin==='string'&&/^https:\/\/[a-z0-9-]+\.pages\.dev$/.test(origin),'EXPECTED_LEGACY_PAGES_ORIGIN_REQUIRED');
  const retained=config.retainedDeploymentId,retired=config.retiredDeploymentIds;
  requireGate(/^[a-f0-9]{8}$/.test(retained||'')&&Array.isArray(retired)&&retired.length===3&&new Set(retired).size===3
   &&retired.every(v=>/^[a-f0-9]{8}$/.test(v)&&v!==retained),'EXACT_RETIRED_DEPLOYMENT_IDS_REQUIRED');
  const project=new URL(origin).hostname.split('.')[0];
  const bindings=await json(fixed('sandbox-pages-bindings-removed.json'));
  requireGate(bindings.project===project&&bindings.environment==='Production'&&bindings.operator==='Talip'
   &&bindings.verifiedAfterReload===true&&bindings.checkoutDisabled===true,'PAGES_BINDINGS_NOT_REMOVED');
  const names=['CATERING_SANDBOX_SUPABASE_URL','SUPABASE_SECRET_KEY','CLOVER_HOSTED_CHECKOUT_PRIVATE_KEY','CLOVER_PLATFORM_API_TOKEN','CLOVER_WEBHOOK_SIGNING_SECRET'];
  requireGate(same([...(bindings.removedNames||[])].sort(),names.sort())&&names.every(n=>!bindings.remainingNames?.includes(n)),'PAGES_REMOVED_BINDING_SET_INVALID');
  date(bindings.observedAt,'PAGES_BINDINGS_TIME_INVALID',{fresh:true});
  const runtime=await json(fixed('sandbox-retirement-runtime-check.json'));
  const runtimeTime=date(runtime.observedAtUtc,'PAGES_RUNTIME_TIME_INVALID',{fresh:true});
  requireGate(Array.isArray(runtime.results)&&runtime.results.length===13,'PAGES_RUNTIME_PROBE_SET_INCOMPLETE');
  for(const id of retired)for(const route of ['/','/api/catering/checkout','/api/catering/clover-webhook']){
   const found=runtime.results.filter(r=>r.origin===`https://${id}.${project}.pages.dev`&&r.route===route&&r.method==='GET');
   requireGate(found.length===1&&found[0].status===404&&found[0].location==='','OLD_DEPLOYMENT_STILL_REACHABLE');
  }
  for(const host of [origin,`https://${retained}.${project}.pages.dev`])for(const route of ['/api/catering/checkout','/api/catering/clover-webhook']){
   const found=runtime.results.filter(r=>r.origin===host&&r.route===route&&r.method==='POST_INVALID_JSON');
   requireGate(found.length===1&&found[0].status===503&&same(JSON.parse(found[0].body),{code:route.endsWith('checkout')?'checkout_unavailable':'webhook_unavailable'}),'PAGES_RECEIVER_NOT_DISABLED');
  }
  const target=await json(fixed('clover-sandbox-webhook-target-confirmed.json'));
  const removed=await json(fixed('clover-sandbox-webhook-removed.json'));
  requireGate(target.environment==='sandbox'&&target.dashboardHost==='sandbox.dev.clover.com'&&target.expectedTestMerchantMatched===true
   &&target.webhookHost===new URL(origin).hostname&&target.webhookPath==='/api/catering/clover-webhook'&&target.webhookQueryPresent===false,'CLOVER_TARGET_NOT_VERIFIED');
  const removedTime=date(removed.observedAtUtc,'CLOVER_REMOVAL_TIME_INVALID',{fresh:true});
  requireGate(removedTime>=runtimeTime&&removedTime>=date(target.observedAtUtc,'CLOVER_TARGET_TIME_INVALID'), 'DISCONNECTION_EVIDENCE_ORDER_INVALID');
  requireGate(removed.environment==='sandbox'&&removed.dashboardHost===target.dashboardHost&&removed.expectedTestMerchantMatched===true
   &&removed.operator==='Talip'&&removed.userReportedRemoval===true&&removed.uiSaveSuccessObserved===true&&removed.webhookEmptyAfterReload===true
   &&removed.saveDisabledAfterReload===true&&removed.webhookRemovalVerified===true&&removed.previousWebhookHost===target.webhookHost
   &&removed.previousWebhookPath===target.webhookPath&&removed.settingChangedByCodex===false&&removed.credentialChangedByCodex===false,'CLOVER_WEBHOOK_REMOVAL_NOT_VERIFIED');
  // No current-status flag is used. Rehash all inputs to catch concurrent edits.
  for(const [path,entry] of reads)requireGate(sha(await readFile(path))===entry.hash,'ARTIFACT_CHANGED_DURING_VERIFICATION');
  const ordered=Object.fromEntries(Object.entries(hashes).sort(([a],[b])=>a.localeCompare(b)));
  const receiptSha256=sha(JSON.stringify({sandboxRef,productionRef,hashes:ordered}));
  return {ready:true,verified:true,scope:'K3_PHASES_1_4_GATES_VALIDATED',sandboxRef,productionRef,
   resetAuthorized:false,freshTargetPreflightRequired:true,issues:[],hashes:ordered,
   receipts:Object.entries(ordered).map(([path,sha256])=>({path,sha256})),receiptSha256};
 }catch(error){
  return {ready:false,verified:false,scope:'K3_PHASES_1_4_GATES_NOT_VALIDATED',resetAuthorized:false,
   issues:[error instanceof GateError?error.message:'GATE_ARTIFACT_INVALID_OR_MISSING'],hashes:{},receipts:[]};
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2);const values={};
  while(args.length){const k=args.shift(),v=args.shift();requireGate(['--spec','--config','--expected-sandbox-ref','--expected-production-ref'].includes(k)&&v&&!values[k],'CLI_ARGUMENTS_INVALID');values[k]=v;}
  const spec=values['--spec']||values['--config'];requireGate(spec&&isAbsolute(spec),'ABSOLUTE_GATE_SPEC_REQUIRED');
  const config=JSON.parse(await readFile(spec,'utf8'));
  for(const [flag,key] of [['--expected-sandbox-ref','expectedTestRef'],['--expected-production-ref','expectedProdRef']])
   if(values[flag])requireGate(values[flag]===config[key],'CLI_EXPECTED_REF_MISMATCH');
  const result=await verifyHostedResetGates(config);console.log(JSON.stringify(result));process.exitCode=result.verified?0:2;
 }catch{console.log(JSON.stringify({ready:false,verified:false,issues:['GATE_SPEC_INVALID']}));process.exitCode=2;}
}
