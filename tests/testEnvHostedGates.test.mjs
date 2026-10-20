// Synthetic private-file fixtures only. No real captures, database, browser,
// network, password, native PostgreSQL process or reset is used by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import {dirname,basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyHostedResetGates,BASELINE_SHA256} from '../tools/test-env/verify-hosted-reset-gates.mjs';

const digest=v=>createHash('sha256').update(v).digest('hex');
const tmpRoot=await realpath(fileURLToPath(new URL('../../',import.meta.url)));
const baseline=await readFile(new URL('../supabase/baselines/20261019_application_schema.sql',import.meta.url));
const recent=()=>new Date(Date.now()-60000).toISOString();
const save=async(p,v)=>{await mkdir(dirname(p),{recursive:true});await writeFile(p,typeof v==='string'||Buffer.isBuffer(v)?v:JSON.stringify(v));};
const load=async p=>JSON.parse(await readFile(p,'utf8'));

async function fixture(t){
 const root=await mkdtemp(join(tmpRoot,'nazar-hosted-gates-unit-'));
 t.after(async()=>{const target=await realpath(root);assert.equal(dirname(target),tmpRoot);assert.ok(basename(target).startsWith('nazar-hosted-gates-unit-'));await rm(target,{recursive:true});});
 const testRef='b'.repeat(20),prodRef='a'.repeat(20),productionCapture=join(root,'production-schema-private','capture');
 const sandboxCapture=join(root,'sandbox-recovery','capture');
 const productionReviewed=join(productionCapture,'reviewed'),sandboxReviewed=join(sandboxCapture,'reviewed');
 const productionLocalRestore=join(productionReviewed,'local_restore'),sandboxLocalRestore=join(sandboxReviewed,'local_restore');
 const orderText=JSON.stringify([1,2,3,4].map(id=>({id:'test-'+id,customer_email:'test'+id+'@example.invalid',customer_name:'INTERNAL TEST '+id,total_cents:20,is_test:true})));
 const staffText=JSON.stringify([{staff_ref:'sandbox-staff-1',role:null,active:true,auth_linked:true}]);
 const schema='CREATE SCHEMA core;\nCREATE TABLE public.catering_orders(id uuid);\nCREATE TABLE core.crm_staff(auth_user_id uuid);\n';
 const rawToc='1; 2615 1 SCHEMA - core postgres\n';
 async function createCapture(path,mode,ref){
  const source={capturedAtUtc:recent(),expectedCateringRows:4,expectedStaffRows:1,
   cateringRowsSha256:digest(orderText),staffAnonymousSha256:digest(staffText),allRowsReviewedSynthetic:false,
   freeFormReviewPending:true,localRestoreProof:false,schemaDumpSucceeded:true,authPlatformPreserved:true,
   markerClassificationPassed:true,scope:'read_only_source_capture_not_reset_or_restore'};
  const files={'catalog.json':JSON.stringify({read_only:'on',objects:[]}),
   'raw-schema.dump':'SYNTHETIC_OFFLINE_ARCHIVE','raw-toc.list':rawToc,'allowlist-review.json':'{}',
   'schema.sql':mode==='PRODUCTION'?baseline:schema};
  if(mode==='SANDBOX')Object.assign(files,{'catering-orders.json':orderText,'staff-anonymous.json':staffText,'recovery-source-proof.json':JSON.stringify(source)});
  for(const [name,body] of Object.entries(files))await save(join(path,name),body);
  const manifest={version:1,mode,source_project_ref:ref,captured_at:recent(),schemas:['core','public'],read_only:true,
   tls:'verify-full',schema_data_exported:false,data_exported:mode==='SANDBOX',replay_ready:false,
   syntheticRowsExported:mode==='SANDBOX'?4:0,anonymousStaffRowsExported:mode==='SANDBOX'?1:0,
   files:Object.fromEntries(Object.entries(files).map(([name,body])=>[name,digest(body)]))};
  await save(join(path,'capture-manifest.json'),manifest);await save(join(path,'source-proof.json'),manifest);
  return {manifest,source};
 }
 const prod=await createCapture(productionCapture,'PRODUCTION',prodRef);
 const sandbox=await createCapture(sandboxCapture,'SANDBOX',testRef);
 async function createReview(path,cap,manifest,isSandbox=false,source){
  const review={version:1,review_complete:true,reviewer:'Synthetic unit reviewer',capture_archive_sha256:manifest.files['raw-schema.dump'],
   security_review:Object.fromEntries(['private_core_verified','function_acl_verified','policy_set_verified','definer_search_path_verified'].map(k=>[k,true])),
   entries:[{dump_id:1,include:true,application_object:true,reason:'Synthetic application schema'}]};
  if(isSandbox)review.recovery_review=Object.fromEntries(['all_complete_order_values_reviewed_synthetic','anonymous_staff_metadata_reviewed','local_execution_no_external_io_reviewed'].map(k=>[k,true]));
  await save(join(cap,'complete-review.json'),review);await save(join(path,'reviewed-toc.list'),rawToc);
  await save(join(path,'reviewed-baseline.sql'),isSandbox?schema:baseline);
  const proof={version:1,source:isSandbox?'actual_sandbox_read_only_capture':'actual_production_schema_archive',
   status:isSandbox?'REVIEWED_SANDBOX_RECOVERY_NOT_RESTORED':'REVIEWED_SQL_RENDERED_NOT_RESTORED',
   capture_manifest_sha256:digest(await readFile(join(cap,'capture-manifest.json'))),
   review_filename:'complete-review.json',review_sha256:digest(await readFile(join(cap,'complete-review.json'))),
   reviewed_toc_sha256:digest(rawToc),baseline_sha256:digest(isSandbox?schema:baseline),selected_entries:1,remote_connection:false,
   archive_sha256:manifest.files['raw-schema.dump']};
  if(isSandbox){
   const derived={'schema.sql':schema,'catering-orders.json':orderText,'staff-anonymous.json':staffText,
    'recovery-source-proof.json':JSON.stringify({...source,allRowsReviewedSynthetic:true,freeFormReviewPending:false,localRestoreProof:false})};
   for(const [name,body] of Object.entries(derived))await save(join(path,'derived-recovery',name),body);
   proof.derived_files=Object.fromEntries(Object.entries(derived).map(([name,body])=>[name,digest(body)]));
  }
  await save(join(path,isSandbox?'sandbox-recovery-proof.json':'baseline-proof.json'),proof);
  return proof;
 }
 await createReview(productionReviewed,productionCapture,prod.manifest);
 const sandboxProof=await createReview(sandboxReviewed,sandboxCapture,sandbox.manifest,true,sandbox.source);
 const common={server_started:true,server_stopped:true,ddl_restore_succeeded:true,remote_connection:false,real_jwt_validation:false,error:null};
 await save(join(productionLocalRestore,'local-restore-report.json'),{...common,baseline_sha256:BASELINE_SHA256,baseline_bytes_preserved:true});
 await save(join(sandboxLocalRestore,'sandbox-local-restore-report.json'),{...common,baseline_sha256:sandboxProof.baseline_sha256,
  orders_sha256:digest(orderText),orders_restore_succeeded:true,readback_matches:true,source_bytes_preserved:true,
  capture_and_review_provenance_preserved:true,staff_identity_restored:false});
 await save(join(sandboxLocalRestore,'catering-orders-readback.json'),orderText);
 await save(join(sandboxLocalRestore,'readback-validation.json'),{packageIntegrityVerified:true,localReadback:{matches:true},issues:[]});
 const roles=['anon','authenticated','service_role'].map(name=>({name,inherit:true,superuser:false,bypass_rls:name==='service_role'}));
 const routines=Array.from({length:32},(_,i)=>({schema:i<7?'core':'public',name:'synthetic_fn_'+i,args:'',anon:false,authenticated:i>6,service_role:false}));
 await save(join(root,'production-effective-privileges.json'),{read_only:'on',roles,routines,core_usage:{anon:false,authenticated:false,service_role:false}});
 await save(join(productionLocalRestore,'06_private_security_inventory.json'),{exit_code:0,timed_out:false,stdout:JSON.stringify({
  core_anon_usage:false,core_authenticated_usage:false,core_service_role_usage:false,role_attributes:roles,
  routines:routines.map(({anon,authenticated,service_role,...r})=>({...r,execute_anon:anon,execute_authenticated:authenticated,execute_service_role:service_role,settings:['search_path=""']})),
  tables:Array.from({length:16},(_,i)=>({schema:'core',name:'synthetic_table_'+i,rls:true}))})});
 const ax=`https://supabase.com/dashboard/project/${testRef}\nHealthy\nNo security, performance or health issues found`;
 await save(join(root,'health-fullax.txt'),ax);
 await save(join(root,'sandbox-health-current.json'),{projectRef:testRef,observedAtUtc:recent(),healthy:true,
  restartRequired:false,readOnlyMetadataSucceededAt:recent(),authHealthStatus:null,restReadyStatus:null,
  sourceFiles:[{path:'health-fullax.txt',sha256:digest(ax)}]});
 const project='synthetic-sandbox',origin=`https://${project}.pages.dev`,retired=['11111111','22222222','33333333'],retained='44444444';
 await save(join(root,'sandbox-pages-bindings-removed.json'),{observedAt:recent(),project,environment:'Production',operator:'Talip',
  verifiedAfterReload:true,checkoutDisabled:true,removedNames:['CATERING_SANDBOX_SUPABASE_URL','SUPABASE_SECRET_KEY','CLOVER_HOSTED_CHECKOUT_PRIVATE_KEY','CLOVER_PLATFORM_API_TOKEN','CLOVER_WEBHOOK_SIGNING_SECRET'],remainingNames:[]});
 const results=retired.flatMap(id=>['/','/api/catering/checkout','/api/catering/clover-webhook'].map(route=>({origin:`https://${id}.${project}.pages.dev`,route,method:'GET',status:404,location:''})));
 for(const host of [origin,`https://${retained}.${project}.pages.dev`])for(const route of ['/api/catering/checkout','/api/catering/clover-webhook'])
  results.push({origin:host,route,method:'POST_INVALID_JSON',status:503,body:JSON.stringify({code:route.endsWith('checkout')?'checkout_unavailable':'webhook_unavailable'})});
 const when=recent();
 await save(join(root,'sandbox-retirement-runtime-check.json'),{observedAtUtc:when,results});
 const target={environment:'sandbox',dashboardHost:'sandbox.dev.clover.com',expectedTestMerchantMatched:true,
  observedAtUtc:when,webhookHost:`${project}.pages.dev`,webhookPath:'/api/catering/clover-webhook',webhookQueryPresent:false};
 await save(join(root,'clover-sandbox-webhook-target-confirmed.json'),target);
 await save(join(root,'clover-sandbox-webhook-removed.json'),{environment:'sandbox',dashboardHost:target.dashboardHost,
  expectedTestMerchantMatched:true,observedAtUtc:when,operator:'Talip',userReportedRemoval:true,uiSaveSuccessObserved:true,
  webhookEmptyAfterReload:true,saveDisabledAfterReload:true,webhookRemovalVerified:true,previousWebhookHost:target.webhookHost,
  previousWebhookPath:target.webhookPath,settingChangedByCodex:false,credentialChangedByCodex:false});
 return {config:{evidenceRoot:root,productionCapture,productionReviewed,productionLocalRestore,sandboxReviewed,sandboxLocalRestore,
  expectedTestRef:testRef,expectedProdRef:prodRef,legacyPagesOrigin:origin,retiredDeploymentIds:retired,retainedDeploymentId:retained},root};
}

test('actual-content gate verifies a complete synthetic chain and returns deterministic hashes only',async t=>{
 const {config}=await fixture(t);const a=await verifyHostedResetGates(config),b=await verifyHostedResetGates(config);
 assert.equal(a.verified,true,JSON.stringify(a.issues));assert.equal(a.ready,true);assert.equal(a.resetAuthorized,false);
 assert.equal(a.freshTargetPreflightRequired,true);assert.equal(a.receiptSha256,b.receiptSha256);
 assert.ok(a.receipts.length>=40);assert.doesNotMatch(JSON.stringify(a),/example\.invalid|customer_email|auth_user_id|SYNTHETIC_OFFLINE_ARCHIVE/);
});

test('same project, wrong capture target and source byte tampering are refused',async t=>{
 const {config}=await fixture(t);
 assert.equal((await verifyHostedResetGates({...config,expectedTestRef:config.expectedProdRef})).verified,false);
 assert.equal((await verifyHostedResetGates({...config,expectedTestRef:'c'.repeat(20)})).verified,false);
 await save(join(config.productionCapture,'raw-schema.dump'),'TAMPERED');
 assert.deepEqual((await verifyHostedResetGates(config)).issues,['ARTIFACT_HASH_MISMATCH']);
});

test('current status flags cannot substitute for actual Clover removal and reload evidence',async t=>{
 const {config,root}=await fixture(t);
 await save(join(root,'k3-current-proof-state.json'),{runtimeDisconnectionVerified:true,cloverWebhookRemovalVerified:true});
 const path=join(root,'clover-sandbox-webhook-removed.json'),original=await load(path);
 for(const key of ['webhookRemovalVerified','webhookEmptyAfterReload','saveDisabledAfterReload','uiSaveSuccessObserved']){
  await save(path,{...original,[key]:false});
  assert.deepEqual((await verifyHostedResetGates(config)).issues,['CLOVER_WEBHOOK_REMOVAL_NOT_VERIFIED'],key);
 }
});

test('incomplete, redirected or still-active Pages probes do not count as retirement',async t=>{
 const {config,root}=await fixture(t);const path=join(root,'sandbox-retirement-runtime-check.json');const original=await load(path);
 for(const mutate of [v=>v.results.pop(),v=>v.results[0].location='https://synthetic.invalid',v=>v.results[9].status=400]){
  const value=structuredClone(original);mutate(value);await save(path,value);
  assert.equal((await verifyHostedResetGates(config)).verified,false);
 }
});

test('healthy flag without bound source or current time is refused',async t=>{
 const {config,root}=await fixture(t);const path=join(root,'sandbox-health-current.json');const original=await load(path);
 await save(path,{...original,observedAtUtc:'2020-01-01T00:00:00Z'});
 assert.deepEqual((await verifyHostedResetGates(config)).issues,['OPERATIONAL_RECEIPT_STALE']);
 await save(path,{...original,sourceFiles:[]});
 assert.deepEqual((await verifyHostedResetGates(config)).issues,['HEALTH_SOURCE_FILES_REQUIRED']);
 await save(path,{...original,sourceFiles:[{path:'../outside.txt',sha256:'a'.repeat(64)}]});
 assert.deepEqual((await verifyHostedResetGates(config)).issues,['ARTIFACT_OUTSIDE_EVIDENCE_ROOT']);
});

test('review decisions and derived recovery bytes remain hash bound',async t=>{
 const {config}=await fixture(t);const path=join(config.productionCapture,'complete-review.json');
 const original=await readFile(path);await writeFile(path,Buffer.concat([original,Buffer.from(' ')]));
 assert.deepEqual((await verifyHostedResetGates(config)).issues,['ARTIFACT_HASH_MISMATCH']);
 await writeFile(path,original);
 await save(join(config.sandboxReviewed,'derived-recovery','catering-orders.json'),'[]');
 assert.deepEqual((await verifyHostedResetGates(config)).issues,['ARTIFACT_HASH_MISMATCH']);
});

test('a reported successful readback is rejected when actual restored values differ',async t=>{
 const {config}=await fixture(t);const path=join(config.sandboxLocalRestore,'catering-orders-readback.json');
 const rows=await load(path);rows[0].total_cents=21;await save(path,rows);
 assert.deepEqual((await verifyHostedResetGates(config)).issues,['RECOVERY_FULL_READBACK_INVALID']);
});

test('explicit failed local run cannot be replaced by an older successful status',async t=>{
 const {config}=await fixture(t);const path=join(config.sandboxLocalRestore,'sandbox-local-restore-report.json');
 await save(path,{...await load(path),server_stopped:false});
 assert.deepEqual((await verifyHostedResetGates(config)).issues,['LOCAL_RESTORE_NOT_SUCCESSFUL']);
});

test('effective privileges are recomputed from source and local inventory',async t=>{
 const {config}=await fixture(t);const path=join(config.productionLocalRestore,'06_private_security_inventory.json');
 const receipt=await load(path);const inventory=JSON.parse(receipt.stdout);inventory.routines[0].execute_service_role=true;
 await save(path,{...receipt,stdout:JSON.stringify(inventory)});
 assert.deepEqual((await verifyHostedResetGates(config)).issues,['EFFECTIVE_FUNCTION_PRIVILEGES_DIFFER']);
});
