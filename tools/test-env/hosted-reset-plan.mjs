// Offline compiler only. No database driver, browser, fetch, child process or
// execution entry point exists here. SQL is usable only after independent review
// and the separately gated, target-bound masked operator workflow.
import {readFile,writeFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createFixture,validateFixture,renderSeedSql} from './synthetic-fixture.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url));
const privateRoot=fileURLToPath(new URL('../../../../20_Yonetim/Teslim_Raporlari/K3_kanit/',import.meta.url));
export const BASELINE_SHA256='f3583bb461ba8ae50dea04ae03d6c5c4dbe729aacdec1ed7dd57982b7e25d230';
export const MARKER_SHA256='bd5100fbc165d9dffee77b1199d5e346c5b2611ae665c46f42608aaaa645de90';
export const LEGACY_FUNCTIONS=Object.freeze([
 'public.confirm_catering_payment(text,text,timestamp with time zone,integer)',
 'public.confirm_site_order_payment(text,text,text,timestamp with time zone,integer)',
 'public.create_site_order_draft(uuid,text,text,text,text,text,jsonb,integer,integer)',
 'public.set_site_order_payment_session(uuid,text,text)',
 'public.staff_reschedule_site_order_group(uuid,timestamp with time zone)',
 'public.staff_site_order_overview(text)',
 'public.staff_update_site_order_group(uuid,text)',
]);
export const LEGACY_TABLES=Object.freeze(['core.crm_staff','public.catering_orders','public.site_order_events','public.site_order_groups','public.site_orders']);
const roles=['anon','authenticated','service_role'];
const ref=/^[a-z]{20}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const md5=/^[0-9a-f]{32}$/;
const q=value=>"'"+String(value).replaceAll("'","''")+"'";
const digest=value=>createHash('sha256').update(value).digest('hex');
const sorted=values=>[...values].sort();
const same=(a,b)=>JSON.stringify(sorted(a))===JSON.stringify(sorted(b));
const jsonSql=value=>`convert_from(decode(${q(Buffer.from(JSON.stringify(value),'utf8').toString('base64'))},'base64'),'UTF8')::jsonb`;
const fail=code=>{throw new Error(code)};
const ident=value=>/^[a-z_][a-z0-9_]*$/.test(value)?value:fail('UNSAFE_APPLICATION_IDENTIFIER');
const qualification=(schema,name)=>`${ident(schema)}.${ident(name)}`;

export function validateTarget(config,productionGuardRef){
 if(!config||!ref.test(config.expectedTestRef||'')||!ref.test(config.expectedProdRef||'')
   ||config.expectedProdRef!==productionGuardRef||config.expectedTestRef===productionGuardRef
   ||config.expectedTestRef===config.expectedProdRef)fail('TEST_TARGET_MUST_DIFFER_FROM_TRUSTED_PRODUCTION');
 if(!['legacy_sandbox','reviewed_baseline'].includes(config.phase))fail('EXPLICIT_RESET_PHASE_REQUIRED');
 if(!['staff','owner'].includes(config.staffRole))fail('EXPLICIT_STAFF_ROLE_REQUIRED');
 if(!uuid.test(config.testBusinessId||''))fail('CONFIGURED_TEST_BUSINESS_REQUIRED');
 return true;
}

function signature(schema,name,args){
 const types=args.trim()?args.split(',').map(argument=>{
  const match=argument.trim().match(/^(?:[a-z_][a-z0-9_]* )?(timestamp with time zone|uuid|text|boolean|jsonb|integer)(?: DEFAULT .+)?$/);
  if(!match)fail('BASELINE_ARGUMENT_CONTRACT_UNRECOGNIZED');
  return match[1];
 }):[];
 return `${qualification(schema,name)}(${types.join(',')})`;
}

export function baselineModel(baseline){
 if(digest(Buffer.from(baseline,'utf8'))!==BASELINE_SHA256)fail('REVIEWED_BASELINE_HASH_MISMATCH');
 const functions=[...baseline.matchAll(/^CREATE FUNCTION (core|public)\.([a-z_][a-z0-9_]*)\(([^\r\n]*)\) RETURNS /gm)]
  .map(match=>signature(match[1],match[2],match[3]));
 const tables=[...baseline.matchAll(/^CREATE TABLE (core\.[a-z_][a-z0-9_]*) \(/gm)].map(match=>match[1]);
 const views=[...baseline.matchAll(/^CREATE VIEW (core\.[a-z_][a-z0-9_]*) AS$/gm)].map(match=>match[1]);
 if(functions.length!==32||new Set(functions).size!==32||tables.length!==16||views.length!==2)fail('REVIEWED_BASELINE_INVENTORY_MISMATCH');
 const business=baseline.match(/CONSTRAINT businesses_id_check CHECK \(\(id = '([0-9a-f-]+)'::uuid\)\)/)?.[1];
 if(!business)fail('EXISTING_BASELINE_BUSINESS_GUARD_MISSING');
 const acl=Object.fromEntries(functions.map(item=>[item,Object.fromEntries(roles.map(role=>[role,false]))]));
 for(const match of baseline.matchAll(/^GRANT ALL ON FUNCTION (core|public)\.([a-z_][a-z0-9_]*)\(([^\r\n]*)\) TO (anon|authenticated|service_role);$/gm)){
  const key=signature(match[1],match[2],match[3]);
  if(!acl[key])fail('BASELINE_ACL_SIGNATURE_MISMATCH');
  acl[key][match[4]]=true;
 }
 return {functions:sorted(functions),tables:sorted(tables),views:sorted(views),business,acl};
}

export function unwrapReviewedMarker(marker){
 if(digest(Buffer.from(marker,'utf8'))!==MARKER_SHA256)fail('REVIEWED_MARKER_HASH_MISMATCH');
 // This is an exact reviewed byte/line contract, not a general SQL regex that
 // guesses whether arbitrary nested transaction commands can be removed.
 const prefix='-- Additive test markers. Run only after the reviewed schema baseline.\n-- No provider action, consent change or production execution is part of K3.\nBEGIN;\n';
 const suffix='COMMIT;\n';
 if(!marker.startsWith(prefix)||!marker.endsWith(suffix))fail('REVIEWED_MARKER_WRAPPER_MISMATCH');
 return marker.slice(prefix.length,-suffix.length);
}

export function boundReviewedBaseline(baseline){
 if(digest(Buffer.from(baseline,'utf8'))!==BASELINE_SHA256)fail('REVIEWED_BASELINE_HASH_MISMATCH');
 // The pinned pg_dump header resets server timeouts. Preserve the source file
 // and function bodies verbatim, inserting bounds only at this exact reviewed
 // header/first-DDL boundary, after all dump timeout resets have run.
 const boundary='\nCREATE SCHEMA core;\n';
 const index=baseline.indexOf(boundary);
 if(index<0||baseline.indexOf(boundary,index+boundary.length)!==-1)fail('REVIEWED_BASELINE_DDL_BOUNDARY_MISMATCH');
 const bounds="SET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\nSET LOCAL idle_in_transaction_session_timeout='180s';\nSET LOCAL transaction_timeout='120s';\n";
 return baseline.slice(0,index+1)+bounds+baseline.slice(index+1);
}

// Canonical metadata excludes extension-owned objects and only the explicitly
// preserved managed helper. Unknown non-extension public/core objects remain in
// the result and cause the exact inventory contract to fail before any drop.
export const CATALOG_SQL=`SELECT jsonb_build_object(
 'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('signature',n.nspname||'.'||p.proname||'('||replace(oidvectortypes(p.proargtypes),', ',',')||')','definition_md5',md5(pg_get_functiondef(p.oid))) ORDER BY n.nspname,p.proname,oidvectortypes(p.proargtypes)),'[]'::jsonb)
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('core','public') AND p.prokind IN('f','p')
 AND NOT(n.nspname='public' AND p.proname='rls_auto_enable' AND p.pronargs=0)
 AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')),
 'relations',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',n.nspname||'.'||c.relname,'kind',c.relkind::text,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,
 'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity::text,'generated',a.attgenerated::text,'default_md5',CASE WHEN ad.oid IS NULL THEN NULL ELSE md5(pg_get_expr(ad.adbin,ad.adrelid)) END) ORDER BY a.attnum),'[]'::jsonb)
 FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)) ORDER BY n.nspname,c.relname),'[]'::jsonb)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('core','public') AND c.relkind IN('r','p','v','m','S','f')
 AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e'))) AS contract`;

export function legacyContract(metadata){
 if(metadata?.scope!=='approved_sandbox_read_only_metadata_not_install_or_restore'||metadata.transaction_read_only!=='on'
   ||metadata.auth_identities_included!==false||metadata.function_bodies_included!==false)fail('READ_ONLY_SANDBOX_METADATA_REQUIRED');
 const functions=(metadata.functions||[]).filter(item=>!item.extension&&!item.known_managed_public_name).map(item=>{
  if(!md5.test(item.definition_md5||''))fail('LEGACY_FUNCTION_DEFINITION_HASH_REQUIRED');
  return {signature:`${qualification(item.schema,item.name)}(${item.identity_signature.slice(item.name.length+1,-1)})`,definition_md5:item.definition_md5};
 });
 if(!same(functions.map(item=>item.signature),LEGACY_FUNCTIONS))fail('LEGACY_FUNCTION_ALLOWLIST_MISMATCH');
 const relations=(metadata.relations||[]).filter(item=>!item.extension&&['r','p','v','m','S','f'].includes(item.kind)).map(item=>({
  name:qualification(item.schema,item.name),kind:item.kind,rls:item.rls_enabled,force_rls:item.rls_forced,
  columns:item.columns.map(column=>({name:ident(column.name),type:column.type,not_null:column.not_null,
   identity:column.identity,generated:column.generated,default_md5:column.default_definition_md5})),
 }));
 if(!same(relations.filter(item=>item.kind==='r').map(item=>item.name),LEGACY_TABLES)
   ||!same(relations.filter(item=>item.kind==='S').map(item=>item.name),['public.site_order_events_id_seq'])
   ||relations.some(item=>!['r','S'].includes(item.kind)))fail('LEGACY_RELATION_ALLOWLIST_MISMATCH');
 if((metadata.policies||[]).length)fail('UNEXPECTED_LEGACY_POLICY_REQUIRES_REVIEW');
 return {functions:functions.sort((a,b)=>a.signature<b.signature?-1:1),relations:relations.sort((a,b)=>a.name<b.name?-1:1)};
}

function sqlCatalogExpression(){return `(${CATALOG_SQL.replace(/ AS contract$/,'')})`;}
function allFunctionsSql(){return `SELECT n.nspname||'.'||p.proname||'('||replace(oidvectortypes(p.proargtypes),', ',',')||')' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('core','public') AND p.prokind IN('f','p') AND NOT(n.nspname='public' AND p.proname='rls_auto_enable' AND p.pronargs=0) AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')`;}
const managedSnapshot=`jsonb_build_object('auth_schema',to_regnamespace('auth')::oid,'storage_schema',to_regnamespace('storage')::oid,'extensions_schema',to_regnamespace('extensions')::oid,'public_schema',to_regnamespace('public')::oid,'auth_users_table',to_regclass('auth.users')::oid,'auth_ids_hash',(SELECT md5(coalesce(string_agg(id::text,',' ORDER BY id),'')) FROM auth.users),'managed_helper',to_regprocedure('public.rls_auto_enable()')::oid)`;

export function compileHostedResetSql({config,productionGuardRef,baseline,marker,metadata,fixture,previousReceipt}){
 validateTarget(config,productionGuardRef);
 const model=baselineModel(baseline);
 const boundedBaseline=boundReviewedBaseline(baseline);
 if(config.testBusinessId!==model.business)fail('CONFIGURED_BUSINESS_MUST_MATCH_EXISTING_BASELINE');
 validateFixture(fixture);
 if(fixture.businesses[0].id!==config.testBusinessId)fail('SEED_BUSINESS_CONFIGURATION_MISMATCH');
 const markerSql=unwrapReviewedMarker(marker);
 let beforeGuard;
 let oldTables,oldViews,oldFunctions;
 if(config.phase==='legacy_sandbox'){
  beforeGuard=`IF ${sqlCatalogExpression()} IS DISTINCT FROM ${jsonSql(legacyContract(metadata))} THEN RAISE EXCEPTION 'K3_LEGACY_CATALOG_CHANGED'; END IF;
 IF (SELECT count(*) FROM public.catering_orders)<>4 OR (SELECT count(*) FROM core.crm_staff)<>1
 OR (SELECT count(*) FROM public.site_orders)<>0 OR (SELECT count(*) FROM public.site_order_groups)<>0 OR (SELECT count(*) FROM public.site_order_events)<>0
 THEN RAISE EXCEPTION 'K3_LEGACY_COUNTS_CHANGED'; END IF;`;
  oldTables=LEGACY_TABLES;oldViews=[];oldFunctions=LEGACY_FUNCTIONS;
 }else{
  if(previousReceipt?.scope!=='k3_hosted_application_reset'||previousReceipt.reset_completed!==true
    ||previousReceipt.expected_test_ref!==config.expectedTestRef||!md5.test(previousReceipt.application_catalog_md5||''))fail('PREVIOUS_SUCCESSFUL_INSTALL_RECEIPT_REQUIRED');
  beforeGuard=`IF md5(${sqlCatalogExpression()}::text)<>${q(previousReceipt.application_catalog_md5)} THEN RAISE EXCEPTION 'K3_REPEATED_CATALOG_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM core.businesses WHERE NOT is_test) OR EXISTS(SELECT 1 FROM core.customers WHERE NOT is_test)
 OR EXISTS(SELECT 1 FROM core.signups WHERE NOT is_test) OR EXISTS(SELECT 1 FROM core.catering_requests WHERE NOT is_test)
 OR EXISTS(SELECT 1 FROM core.offers WHERE NOT is_test) THEN RAISE EXCEPTION 'K3_NONTEST_DATA_REFUSES_RESET'; END IF;`;
  oldTables=model.tables;oldViews=model.views;oldFunctions=model.functions;
 }
 const dropSql=[...oldViews.map(item=>`DROP VIEW ${item} RESTRICT;`),`DROP TABLE ${oldTables.join(',')} RESTRICT;`,
  ...oldFunctions.map(item=>`DROP FUNCTION ${item} RESTRICT;`),'DROP SCHEMA core RESTRICT;'].join('\n');
 const aclAssertions=Object.entries(model.acl).flatMap(([fn,permissions])=>roles.map(role=>
  `IF has_function_privilege(${q(role)},${q(fn)},'EXECUTE') IS DISTINCT FROM ${permissions[role]} THEN RAISE EXCEPTION 'K3_EFFECTIVE_FUNCTION_PRIVILEGE_MISMATCH'; END IF;`)).join('\n ');
 const expectedFunctions=`ARRAY[${model.functions.map(q).join(',')}]::text[]`;
 const expectedTables=`ARRAY[${model.tables.map(q).join(',')}]::text[]`;
 const sql=`-- K3 bounded application-only reset. Reviewed local compilation is not execution authorization.
-- Endpoint/ref/TLS identity is checked by the separate operator; a session marker is not server identity proof.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SET LOCAL timezone='UTC';
SELECT pg_advisory_xact_lock(hashtextextended('k3_application_reset',0));
LOCK TABLE ${oldTables.join(',')} IN ACCESS EXCLUSIVE MODE;
DO $k3_preflight$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'postgres' THEN RAISE EXCEPTION 'K3_POSTGRES_OPERATOR_REQUIRED'; END IF;
 IF to_regnamespace('auth') IS NULL OR to_regnamespace('storage') IS NULL OR to_regnamespace('extensions') IS NULL
 OR to_regclass('auth.users') IS NULL OR to_regprocedure('auth.uid()') IS NULL OR to_regprocedure('public.rls_auto_enable()') IS NULL
 THEN RAISE EXCEPTION 'K3_MANAGED_PLATFORM_PREREQUISITE_MISSING'; END IF;
 ${beforeGuard}
 IF (SELECT count(*) FROM core.crm_staff)<>1 OR EXISTS(SELECT 1 FROM core.crm_staff c WHERE NOT EXISTS(SELECT 1 FROM auth.users a WHERE a.id=c.auth_user_id))
 THEN RAISE EXCEPTION 'K3_PRIVATE_STAFF_LINK_REQUIRED'; END IF;
END $k3_preflight$;
CREATE TEMP TABLE k3_managed_before ON COMMIT DROP AS SELECT ${managedSnapshot} AS snapshot;
CREATE TEMP TABLE k3_staff_saved ON COMMIT DROP AS SELECT auth_user_id,active FROM core.crm_staff;
${dropSql}
-- Reviewed baseline source file stays unchanged; bounded settings are inserted
-- only at its exact pinned header/first-DDL boundary. Function bodies are unchanged.
${boundedBaseline}
-- Exact reviewed baseline ends. Marker wrapper was removed only under its pinned hash contract.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
${markerSql}
SET LOCAL app.k3_test_environment='isolated-test';
${renderSeedSql(fixture,{transactional:false})}
INSERT INTO core.crm_staff(auth_user_id,role,active) SELECT auth_user_id,${q(config.staffRole)},active FROM pg_temp.k3_staff_saved;
DO $k3_postflight$ BEGIN
 IF ${managedSnapshot} IS DISTINCT FROM (SELECT snapshot FROM pg_temp.k3_managed_before) THEN RAISE EXCEPTION 'K3_MANAGED_PLATFORM_CHANGED'; END IF;
 IF EXISTS((SELECT auth_user_id,active FROM core.crm_staff) EXCEPT (SELECT auth_user_id,active FROM pg_temp.k3_staff_saved))
 OR EXISTS((SELECT auth_user_id,active FROM pg_temp.k3_staff_saved) EXCEPT (SELECT auth_user_id,active FROM core.crm_staff))
 THEN RAISE EXCEPTION 'K3_STAFF_IDENTITY_OR_ACTIVE_CHANGED'; END IF;
 IF (SELECT array_agg(fn ORDER BY fn) FROM (${allFunctionsSql()}) f(fn)) IS DISTINCT FROM ${expectedFunctions}
 THEN RAISE EXCEPTION 'K3_NEW_FUNCTION_INVENTORY_MISMATCH'; END IF;
 IF (SELECT array_agg(n.nspname||'.'||c.relname ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='core' AND c.relkind IN('r','p')) IS DISTINCT FROM ${expectedTables}
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='core' AND c.relkind IN('r','p') AND NOT c.relrowsecurity)
 THEN RAISE EXCEPTION 'K3_NEW_TABLE_OR_RLS_MISMATCH'; END IF;
 IF has_schema_privilege('anon','core','USAGE') OR has_schema_privilege('authenticated','core','USAGE') OR has_schema_privilege('service_role','core','USAGE')
 THEN RAISE EXCEPTION 'K3_PRIVATE_CORE_USAGE_CHANGED'; END IF;
 ${aclAssertions}
 IF (SELECT count(*) FROM core.businesses)<>1 OR (SELECT count(*) FROM core.customers)<>3 OR (SELECT count(*) FROM core.signups)<>3
 OR (SELECT count(*) FROM core.catering_requests)<>1 OR (SELECT count(*) FROM core.offers)<>1
 OR EXISTS(SELECT 1 FROM core.businesses WHERE NOT is_test) OR EXISTS(SELECT 1 FROM core.customers WHERE NOT is_test)
 OR EXISTS(SELECT 1 FROM core.signups WHERE NOT is_test) OR EXISTS(SELECT 1 FROM core.catering_requests WHERE NOT is_test) OR EXISTS(SELECT 1 FROM core.offers WHERE NOT is_test)
 THEN RAISE EXCEPTION 'K3_SYNTHETIC_SEED_VERIFICATION_FAILED'; END IF;
END $k3_postflight$;
CREATE TEMP TABLE k3_result ON COMMIT PRESERVE ROWS AS SELECT jsonb_build_object(
 'scope','k3_hosted_application_reset','reset_completed',true,'expected_test_ref',${q(config.expectedTestRef)},
 'phase',${q(config.phase)},'staff_identity_preserved',true,'staff_active_preserved',true,'configured_staff_role',${q(config.staffRole)},
 'auth_identity_exported',false,'managed_platform_preserved',true,'real_auth_rest_verified',false,
 'application_catalog_md5',md5(${sqlCatalogExpression()}::text),
 'seed_counts',jsonb_build_object('businesses',1,'customers',3,'signups',3,'catering_requests',1,'offers',1)) AS result;
COMMIT;
SELECT result FROM pg_temp.k3_result;
DROP TABLE pg_temp.k3_result;
`;
 if(/DROP\s+(?:TABLE|VIEW|FUNCTION|SCHEMA)[^;]*\bCASCADE\b/i.test(sql))fail('DROP_CASCADE_FORBIDDEN');
 return {sql,sqlSha256:digest(Buffer.from(sql,'utf8')),baselineSha256:BASELINE_SHA256,markerSha256:MARKER_SHA256,
  inventories:{dropTables:[...oldTables],dropViews:[...oldViews],dropFunctions:[...oldFunctions],newTables:model.tables,newFunctions:model.functions},
  seedCounts:{businesses:1,customers:3,signups:3,catering_requests:1,offers:1}};
}

async function trustedProductionRef(){
 const source=await readFile(path.join(repo,'src/lib/deploymentEnvironment.ts'),'utf8');
 const value=source.match(/^export const PRODUCTION_SUPABASE_URL = "https:\/\/([a-z]{20})\.supabase\.co";/m)?.[1];
 if(!value)fail('TRUSTED_PRODUCTION_GUARD_UNAVAILABLE');
 return value;
}
async function safeJson(filename){
 const stat=await lstat(filename);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)fail('REGULAR_BOUNDED_PRIVATE_JSON_REQUIRED');
 return JSON.parse(await readFile(filename,'utf8'));
}
async function inputBundle(config){
 const productionGuardRef=await trustedProductionRef();validateTarget(config,productionGuardRef);
 const {verifyHostedResetGates}=await import('./verify-hosted-reset-gates.mjs');
 const gates=await verifyHostedResetGates(config);
 if(gates.verified!==true)fail('HOSTED_RESET_GATES_NOT_VERIFIED');
 const metadataPath=config.sandboxPreflightMetadata||path.join(config.evidenceRoot,'sandbox-hosted-preflight-metadata.json');
 const dataApiPath=config.dataApiEvidence||path.join(config.evidenceRoot,'sandbox-data-api-schemas.json');
 const [baseline,marker,metadata,dataApi]=await Promise.all([
  readFile(path.join(repo,'supabase/baselines/20261019_application_schema.sql'),'utf8'),
  readFile(path.join(repo,'supabase/migrations/20261019000100_test_record_markers.sql'),'utf8'),
  safeJson(metadataPath),safeJson(dataApiPath)]);
 if(dataApi.scope!=='sandbox_provider_data_api_exposed_schemas'||dataApi.projectRef!==config.expectedTestRef
  ||dataApi.coreExposed!==false||dataApi.providerVerified!==true||dataApi.settingsChanged!==false
  ||!Array.isArray(dataApi.exposedSchemas)||dataApi.exposedSchemas.includes('core')||!dataApi.exposedSchemas.includes('public'))fail('PROVIDER_CORE_API_EXCLUSION_NOT_VERIFIED');
 const inputHashes={sandbox_preflight:digest(await readFile(metadataPath)),provider_data_api:digest(await readFile(dataApiPath))};
 let previousReceipt;
 if(config.phase==='reviewed_baseline'){
  if(typeof config.previousInstallReceipt!=='string')fail('PREVIOUS_SUCCESSFUL_INSTALL_RECEIPT_REQUIRED');
  previousReceipt=await safeJson(config.previousInstallReceipt);
  inputHashes.previous_install_receipt=digest(await readFile(config.previousInstallReceipt));
 }
 return {productionGuardRef,gates,baseline,marker,metadata,previousReceipt,inputHashes};
}
async function privateOutput(filename){
 if(!path.isAbsolute(filename))fail('ABSOLUTE_PRIVATE_OUTPUT_REQUIRED');
 const parent=await realpath(path.dirname(filename));const root=await realpath(privateRoot);
 const relative=path.relative(root,parent);
 if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))fail('OUTPUT_OUTSIDE_PRIVATE_EVIDENCE');
 for(let current=parent;;current=path.dirname(current)){
  const stat=await lstat(current);if(stat.isSymbolicLink())fail('PRIVATE_LINK_PATH_REFUSED');
  try{await lstat(path.join(current,'.git'));fail('PRIVATE_OUTPUT_INSIDE_GIT');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(path.dirname(current)===current)break;
 }
 return path.join(parent,path.basename(filename));
}
export async function writeHostedResetPlan(config,output){
 output=await privateOutput(output);
 const bundle=await inputBundle(config);
 const fixture=createFixture({id:config.testBusinessId,name:'Nazar-test'});
 const compiled=compileHostedResetSql({config,...bundle,fixture});
 const sqlFilename=path.basename(output).replace(/\.json$/,'')+'.sql';
 if(!output.endsWith('.json')||sqlFilename===path.basename(output))fail('PRIVATE_PLAN_JSON_FILENAME_REQUIRED');
 const sqlPath=path.join(path.dirname(output),sqlFilename);
 const plan={version:1,scope:'k3_hosted_application_reset_plan',compiledOnly:true,executed:false,
  config,fixture,sqlFilename,sqlSha256:compiled.sqlSha256,baselineSha256:BASELINE_SHA256,markerSha256:MARKER_SHA256,
  inventories:compiled.inventories,seedCounts:compiled.seedCounts,inputHashes:bundle.inputHashes,
  gatesReceiptSha256:bundle.gates.receiptSha256,gateHashes:bundle.gates.hashes,
  staffIdentityExported:false,productionRowsCopied:false,authRestAcceptance:false};
 await writeFile(sqlPath,compiled.sql,{encoding:'utf8',flag:'wx'});
 await writeFile(output,JSON.stringify(plan,null,2)+'\n',{encoding:'utf8',flag:'wx'});
 return {ready:true,scope:'K3_HOSTED_APPLICATION_RESET_PLAN_COMPILED_NOT_EXECUTED',planPath:output,sqlPath,sqlSha256:compiled.sqlSha256};
}
export async function validateHostedResetPlan(filename){
 filename=await privateOutput(filename);
 const plan=await safeJson(filename);
 if(plan.version!==1||plan.scope!=='k3_hosted_application_reset_plan'||plan.compiledOnly!==true||plan.executed!==false
  ||typeof plan.sqlFilename!=='string'||path.basename(plan.sqlFilename)!==plan.sqlFilename||!plan.sqlFilename.endsWith('.sql'))fail('PRIVATE_COMPILED_PLAN_CONTRACT_REQUIRED');
 const bundle=await inputBundle(plan.config);
 if(plan.gatesReceiptSha256!==bundle.gates.receiptSha256||JSON.stringify(plan.gateHashes)!==JSON.stringify(bundle.gates.hashes)
  ||JSON.stringify(plan.inputHashes)!==JSON.stringify(bundle.inputHashes))fail('PLAN_EVIDENCE_CHANGED');
 const compiled=compileHostedResetSql({config:plan.config,...bundle,fixture:plan.fixture});
 const sqlPath=await privateOutput(path.join(path.dirname(filename),plan.sqlFilename));
 const stat=await lstat(sqlPath);if(!stat.isFile()||stat.isSymbolicLink())fail('REGULAR_COMPILED_SQL_REQUIRED');
 const actualSql=await readFile(sqlPath);
 if(digest(actualSql)!==compiled.sqlSha256||plan.sqlSha256!==compiled.sqlSha256
  ||plan.baselineSha256!==BASELINE_SHA256||plan.markerSha256!==MARKER_SHA256)fail('COMPILED_SQL_OR_SOURCE_HASH_MISMATCH');
 return {ready:true,scope:'K3_HOSTED_APPLICATION_RESET_PLAN_VALIDATED',expectedTestRef:plan.config.expectedTestRef,
  expectedProdRef:plan.config.expectedProdRef,staffRole:plan.config.staffRole,phase:plan.config.phase,sqlPath,sqlSha256:compiled.sqlSha256,
  planSha256:digest(await readFile(filename)),gatesReceiptSha256:bundle.gates.receiptSha256};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=process.argv.slice(2);
  if(args.length===2&&args[0]==='--validate-plan')console.log(JSON.stringify(await validateHostedResetPlan(path.resolve(args[1]))));
  else if(args.length===4&&args[0]==='--config'&&args[2]==='--output')console.log(JSON.stringify(await writeHostedResetPlan(await safeJson(path.resolve(args[1])),path.resolve(args[3]))));
  else fail('USAGE_CONFIG_OUTPUT_OR_VALIDATE_PLAN_REQUIRED');
 }catch(error){
  const code=/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'HOSTED_PLAN_FAILED_NO_PRIVATE_CONTENT_PRINTED';
  console.log(JSON.stringify({ready:false,scope:'K3_HOSTED_APPLICATION_RESET_MANUAL_BARRIER',issues:[code],executed:false}));process.exitCode=2;
 }
}
