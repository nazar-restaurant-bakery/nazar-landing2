// K10 isolated copy of the accepted K9 native baseline. Historical fixture stays unchanged.
// Local-only PG18.6 fixture. Never reads hosted URLs, keys, password files or
// inherited PG*/database environment. Server owns a random loopback port/path.
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {createHash,randomUUID,randomInt} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
import {dirname,resolve,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const workspace=resolve(repo,'../..');
const evidence=resolve(workspace,'20_Yonetim/Teslim_Raporlari/K10_kupon_kanit');
const cleanEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>
 ['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','COMSPEC','PATHEXT'].includes(key.toUpperCase())));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const literal=value=>value===null?'NULL':"'"+String(value).replaceAll("'","''")+"'";
async function baselineFixture(){
 const bin=await realpath(process.env.K9_PG_BIN||join(process.env.USERPROFILE,'scoop/apps/postgresql/18.6-4/bin'));
 const exe=name=>join(bin,name+(process.platform==='win32'?'.exe':''));
 const nonce=randomUUID();const run=resolve(evidence,'native-'+new Date().toISOString().replaceAll(/[:.]/g,'-')+'-'+nonce.slice(0,8));
 await mkdir(run,{recursive:true});
 if(!run.startsWith(evidence+sep))throw Error('K9 evidence target rejected');
 const data=join(run,'data'),port=randomInt(56000,62000),database='k9_'+nonce.replaceAll('-','').slice(0,12);
 const config={scope:'K9_OWNED_NATIVE_SYNTHETIC_ONLY',host:'127.0.0.1',port,database,dataDirectory:data,nonce,bin,run,
  businessId:randomUUID(),secondBusinessId:randomUUID(),psqlSha256:digest(await readFile(exe('psql')))};
 const options={windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,env:{...cleanEnv(),PGCLIENTENCODING:'UTF8',
  PGCONNECT_TIMEOUT:'2',PGPASSFILE:join(run,'not-a-password-file'),PGOPTIONS:'-c statement_timeout=20000 -c lock_timeout=12000'}};
 function command(name,args,input){const result=spawnSync(exe(name),args,{...options,input,...(name==='pg_ctl'?{stdio:['ignore','ignore','ignore']}: {})});
  if(result.status!==0)throw Error(name+': '+(result.stderr||result.stdout||result.error?.message));return result.stdout||'';}
 const version=command('psql',['--version']);if(!/18\.6\b/.test(version))throw Error('K9 requires native PostgreSQL 18.6');
 const init=command('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
 await writeFile(join(run,'owner.json'),JSON.stringify(config,null,2)+'\n');
 await writeFile(join(run,'initdb.txt'),init);
 const start=command('pg_ctl',['-D',data,'-l',join(run,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1 -c max_connections=12`,'-w','start']);
 await writeFile(join(run,'startup.txt'),start);
 const args=['-X','-q','-w','-h','127.0.0.1','-p',String(port),'-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-At'];
 const history=[];
 function raw(text,{service=false,role=null,subject=null,application=''}={}){
  const prefix=(subject===null?'':`SET request.jwt.claim.sub=${literal(subject)};`)+
   (service?"SET request.jwt.claim.role='service_role';SET ROLE service_role;":role?`SET request.jwt.claim.role=${literal(role)};SET ROLE ${role};`:'');
  const result=spawnSync(exe('psql'),args,{...options,input:prefix+text,
   env:{...options.env,PGOPTIONS:options.env.PGOPTIONS+(application?' -c application_name='+application:'')}});
  history.push({ok:result.status===0,application,sqlSha256:digest(prefix+text)});
  return result;
 }
 function sql(text,opt={}){const result=raw(text,opt);if(result.status!==0)throw Error(result.stderr||result.error?.message||'K9 SQL failed');
  const last=result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);return last===undefined?null:last==='t'?true:last==='f'?false:JSON.parse(last);}
 let stopped=false;
 async function stop(){if(stopped)return;stopped=true;await writeFile(join(run,'query-audit.json'),JSON.stringify(history,null,2)+'\n');
  const result=command('pg_ctl',['-D',data,'-m','fast','-w','stop']);await writeFile(join(run,'shutdown.txt'),result);}
 try{
  command('createdb',['-h','127.0.0.1','-p',String(port),'-U','postgres','-w',database]);
  const identity=sql("SELECT json_build_object('host',host(inet_server_addr()),'port',inet_server_port(),'database',current_database(),'dataDirectory',current_setting('data_directory'),'serverVersion',current_setting('server_version'))");
  if(identity.host!==config.host||identity.port!==port||identity.database!==database||resolve(identity.dataDirectory)!==resolve(data))throw Error('K9 actual local target mismatch');
  const files=['tools/test-env/k9-local-bootstrap.sql','supabase/migrations/20261019000100_test_record_markers.sql','supabase/migrations/20261019000200_suppression_consent_offers.sql','supabase/migrations/20261019000300_klaviyo_profile_sync.sql','supabase/migrations/20261020000700_clover_order_core.sql','supabase/migrations/20261020000900_clover_optional_scope_status.sql','supabase/migrations/20261020000800_message_send_gate.sql','supabase/migrations/20261021000200_campaign_engine.sql'];
  if(!/^18\.6\b/.test(identity.serverVersion))throw Error('K9 actual server version must be18.6');
  const sourceFiles=[];for(const path of ['tests/signupRewardCouponsDb.test.mjs','tests/fixtures/signupRewardCouponsNative.mjs']){
   const bytes=await readFile(join(repo,path));sourceFiles.push({path,sha256:digest(bytes)});await mkdir(join(run,'test-source'),{recursive:true});await writeFile(join(run,'test-source',path.split('/').at(-1)),bytes);}
  const functions=oids=>sql(`SELECT COALESCE(json_agg(json_build_object('oid',p.oid::text,'schema',n.nspname,'name',p.proname,
   'arguments',pg_get_function_identity_arguments(p.oid),'argumentTypes',pg_catalog.oidvectortypes(p.proargtypes),'definition',pg_get_functiondef(p.oid),'acl',p.proacl,
   'securityDefiner',p.prosecdef,'config',p.proconfig) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),'[]'::json)
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('core','public','auth')${oids?' AND p.oid IN('+oids.join(',')+')':''}`);
  let beforeFunctions=null,existingRpcProof=null;
  const hashes=[];for(const path of files){const checkout=await readFile(join(repo,path));
   const canonicalK7Hashes={
    'supabase/migrations/20261020000700_clover_order_core.sql':'5f68772059d9cd1e1d7a6a290aa31ee32d10ff5a367201577c4058861aada4a8',
    'supabase/migrations/20261020000900_clover_optional_scope_status.sql':'a3778d0b933c4ce1a56dba04bcadc31b3f6d1c8f214d56af8203a88d6bcc826e'};
   const canonicalK7=Object.hasOwn(canonicalK7Hashes,path);
   const bytes=canonicalK7?Buffer.from(checkout.toString('utf8').replaceAll('\r\n','\n')):checkout;
   if(bytes.includes(13))throw Error('K9 SQL must have LF bytes: '+path);
   if(canonicalK7&&digest(bytes)!==canonicalK7Hashes[path])throw Error('Exact canonical historical K7 SHA required: '+path);
   hashes.push({path,sha256:digest(bytes),checkoutSha256:digest(checkout),canonicalLfOnly:canonicalK7});await mkdir(join(run,'applied-sql'),{recursive:true});
   await writeFile(join(run,'applied-sql',path.split('/').at(-1)),bytes);
   await writeFile(join(run,'applied-sql','manifest.json'),JSON.stringify(hashes,null,2)+'\n');
   const isK9=path==='supabase/migrations/20261021000200_campaign_engine.sql';
   if(isK9){beforeFunctions=functions();const dayTotals=beforeFunctions.find(f=>f.schema==='public'&&f.name==='clover_order_day_totals_v1');
    if(!dayTotals||!['refundUnverifiedCount','customerAccessDeniedCount','reconciliationConfirmed'].every(field=>dayTotals.definition.includes(field)))throw Error('K9 parity requires the exact main K7 optional-scope day totals function');
    await writeFile(join(run,'existing-functions-before.json'),JSON.stringify(beforeFunctions,null,2)+'\n');}
   const r=raw(bytes.toString('utf8'));if(r.status!==0)throw Error(path+': '+r.stderr);
   if(path==='supabase/migrations/20261019000100_test_record_markers.sql'){
    sql(`ALTER TABLE core.businesses ADD COLUMN timezone text NOT NULL DEFAULT 'America/New_York';
    CREATE TABLE core.signups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL REFERENCES core.businesses(id),customer_id uuid REFERENCES core.customers(id),name text,email text,phone text,source text NOT NULL,consent_email boolean NOT NULL DEFAULT false,consent_sms boolean NOT NULL DEFAULT false,utm jsonb NOT NULL DEFAULT '{}',meta jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),is_test boolean NOT NULL DEFAULT false);
    CREATE TABLE core.klaviyo_email_observations(customer_id uuid PRIMARY KEY REFERENCES core.customers(id),status text NOT NULL,checked_at timestamptz NOT NULL,provider_updated_at timestamptz,blocked_status text,blocked_at timestamptz);
    CREATE TABLE core.ops_metrics(id uuid);CREATE TABLE core.ops_actions(id uuid);CREATE TABLE core.ops_connections(id uuid);
    ALTER TABLE core.customers ENABLE ROW LEVEL SECURITY;ALTER TABLE core.crm_staff ENABLE ROW LEVEL SECURITY;ALTER TABLE core.offers ENABLE ROW LEVEL SECURITY;ALTER TABLE core.consent_events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE core.signups ENABLE ROW LEVEL SECURITY;ALTER TABLE core.klaviyo_email_observations ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE core.signups,core.klaviyo_email_observations FROM PUBLIC,anon,authenticated,service_role;`);
    const baseline=await readFile(join(repo,'supabase/baselines/20261019_application_schema.sql'),'utf8');
    const begin=baseline.indexOf('CREATE FUNCTION public.record_klaviyo_status_v1('),end=baseline.indexOf('END $$;',begin)+7;
    if(begin<0||end<7)throw Error('Actual baseline record_klaviyo_status_v1 required');
    sql(baseline.slice(begin,end));
   }

   if(isK9){const afterFunctions=functions(beforeFunctions.map(f=>f.oid));const beforeSha256=digest(JSON.stringify(beforeFunctions)),afterSha256=digest(JSON.stringify(afterFunctions));
    await writeFile(join(run,'existing-functions-after.json'),JSON.stringify(afterFunctions,null,2)+'\n');
    const dayTotals=beforeFunctions.find(f=>f.schema==='public'&&f.name==='clover_order_day_totals_v1');
    // This exact allowlist covers only the intentional forward authorization
    // transition. Every old function's ACL/SECURITY DEFINER/search_path remains
    // byte-for-byte compared; unrelated definition drift still fails setup.
    const intentionalDefinitions=new Set(['public.crm_staff_authorized_v1()',
     'public.clover_order_match_queue_v1(uuid)',
     'public.clover_order_day_totals_v1(uuid,timestamp with time zone,timestamp with time zone)',
     'public.clover_order_match_resolve_v1(uuid,uuid,uuid)','public.list_offers(uuid)','public.crm_restore_email_consent_v1(uuid,timestamp with time zone,text,text,text,boolean,boolean)','public.crm_profile_sync_queue_v1(uuid)']);
    const key=f=>`${f.schema}.${f.name}(${f.argumentTypes.replaceAll(', ', ',')})`;
    const changedFunctions=[],unexpectedChanges=[];
    for(const before of beforeFunctions){const after=afterFunctions.find(f=>f.oid===before.oid);
     if(!after){unexpectedChanges.push({function:key(before),reason:'missing existing function'});continue;}
     const changed=Object.keys(before).filter(property=>JSON.stringify(before[property])!==JSON.stringify(after[property]));
     if(changed.length)changedFunctions.push({function:key(before),properties:changed,intentional:intentionalDefinitions.has(key(before))&&changed.every(property=>property==='definition')});
     if(changed.some(property=>property!=='definition')||(changed.includes('definition')&&!intentionalDefinitions.has(key(before))))unexpectedChanges.push({function:key(before),properties:changed});
    }
    const missingExpected=[...intentionalDefinitions].filter(name=>!changedFunctions.some(f=>f.function===name));
    existingRpcProof={scope:'K9_EXISTING_FUNCTION_DEFINITION_ACL_PARITY',count:beforeFunctions.length,beforeSha256,afterSha256,
     requiredK7DayTotals:{name:'public.clover_order_day_totals_v1',definitionSha256:digest(dayTotals.definition),scopeFields:['refundUnverifiedCount','customerAccessDeniedCount','reconciliationConfirmed']},
     unchanged:beforeSha256===afterSha256,intentionalDefinitionAllowlist:[...intentionalDefinitions],changedFunctions,unexpectedChanges,missingExpected,
     accepted:unexpectedChanges.length===0&&missingExpected.length===0,properties:['pg_get_functiondef','proacl','prosecdef','proconfig'],fixture_subset_only:true};
    await writeFile(join(run,'existing-rpc-parity.json'),JSON.stringify(existingRpcProof,null,2)+'\n');
    if(!existingRpcProof.accepted)throw Error('K9 unexpected existing fixture RPC drift: '+JSON.stringify({unexpectedChanges,missingExpected}));}
  }
  sql(`INSERT INTO core.businesses(id,name,is_test) VALUES('${config.businessId}','Synthetic Restaurant A',true),('${config.secondBusinessId}','Synthetic Restaurant B',true)`);
  config.scopeFixture={businesses:{a:config.businessId,b:config.secondBusinessId},users:Object.fromEntries(
   ['platformOnly','platformMember','ownerA','managerA','staffA','inactiveA','staffB','legacyOnly','inactivePlatform'].map(name=>[name,randomUUID()]))};
  const users=config.scopeFixture.users;
  sql(`INSERT INTO auth.users(id) VALUES ${Object.values(users).map(id=>`('${id}')`).join(',')};
   INSERT INTO core.business_staff(business_id,staff_id,role,active) VALUES
   ('${config.businessId}','${users.platformMember}','owner',true),('${config.businessId}','${users.ownerA}','owner',true),
   ('${config.businessId}','${users.managerA}','manager',true),('${config.businessId}','${users.staffA}','staff',true),
   ('${config.businessId}','${users.inactiveA}','owner',false),('${config.secondBusinessId}','${users.staffB}','staff',true);
   INSERT INTO core.platform_operators(staff_id,active) VALUES('${users.platformOnly}',true),('${users.platformMember}',true),('${users.inactivePlatform}',false);
   INSERT INTO core.crm_staff(auth_user_id,role,active) VALUES('${users.legacyOnly}','owner',true)`);
  await writeFile(join(run,'scope-fixture.json'),JSON.stringify({...config.scopeFixture,synthetic:true,auth_login:false,hosted_identity:false},null,2)+'\n');
  await writeFile(join(run,'setup.json'),JSON.stringify({...config,postgresVersion:version.trim(),identity,files:hashes,sourceFiles,existingRpcProof,
   hosted_connection:false,hosted_migration:false,real_customer_data:false,fixture_not_hosted_multitenancy_proof:true},null,2)+'\n');
 }catch(error){await writeFile(join(run,'setup-failure.json'),JSON.stringify({error:String(error.message),hosted_connection:false,passed:false},null,2)+'\n');await stop();throw error;}
 function customer({businessId=config.businessId,status='subscribed',suppressed=status==='unsubscribed'}={}){
  const id=randomUUID();sql(`INSERT INTO core.customers(id,business_id,identity_key,name,email,email_status,email_suppressed_at,is_test) VALUES(
   '${id}','${businessId}','email:${id}@synthetic.invalid','Synthetic K9','${id}@synthetic.invalid',${literal(status)},${suppressed?'clock_timestamp()':'NULL'},true)`);return id;
 }
 function staff({businessId=config.businessId,role='staff',active=true,platform=false,legacy=false}={}){
  const id=randomUUID();sql(`INSERT INTO auth.users(id) VALUES('${id}');`+
   (businessId===null?'':`INSERT INTO core.business_staff(business_id,staff_id,role,active) VALUES('${businessId}','${id}',${literal(role)},${active?'true':'false'});`)+
   (platform?`INSERT INTO core.platform_operators(staff_id,active) VALUES('${id}',${active?'true':'false'});`:'')+
   (legacy?`INSERT INTO core.crm_staff(auth_user_id,role,active) VALUES('${id}','staff',true);`:''));return id;
 }
 const authorized=(actor,businessId,operation)=>sql(`SELECT core.staff_authorized_v1(${literal(businessId)}::uuid,${literal(operation)})`,{subject:actor??''});
 function offer({businessId=config.businessId}={}){const id=randomUUID();sql(`INSERT INTO core.offers(id,business_id,name,starts_at,ends_at,active,is_test) VALUES('${id}','${businessId}','Synthetic K9',DATE '2020-01-01',DATE '2040-01-01',true,true)`);return id;}
 function campaign(overrides={}){
  const base={id:randomUUID(),business_id:config.businessId,offer_id:null,name:'Synthetic campaign',benefit_type:'item',target_clover_item_id:'PRODUCT0001',
   benefit_code:'K9SYNTHETIC',min_amount_cents:3000,include_tax:true,include_tip:true,order_type_ids:['PICKUP0001'],starts_at:'2025-01-01T00:00:00Z',ends_at:'2030-01-01T00:00:00Z',
   tz_name:'America/New_York',eligibility:'subscribed_only',max_units_per_order:1,period:'week',max_total_units:null,status:'active',is_test:true};
  const row={...base,...overrides};row.offer_id??=offer({businessId:row.business_id});
  const val=value=>Array.isArray(value)?'ARRAY['+value.map(item=>typeof item==='number'?String(item):literal(item)).join(',')+']':typeof value==='boolean'?(value?'true':'false'):typeof value==='number'?String(value):literal(value);
  sql(`INSERT INTO core.campaigns(${Object.keys(row).join(',')}) VALUES(${Object.values(row).map(val).join(',')})`);return row.id;
 }
 function order(customerId,{businessId=config.businessId,date='2026-10-15T16:00:00Z',amount=5000,paymentStatus='SUCCESS',state='OPEN',type='PICKUP0001',
  product='PRODUCT0001',quantity=1,trace=true,tracePercent=100,paymentRaw={},raw={},online=true,matchStatus='exact'}={}){
  const id=randomUUID(),paymentId=randomUUID();const key=()=>randomUUID().replaceAll('-','').slice(0,20);
  const discounts=trace?[{id:'DISCOUNT01',name:'K9SYNTHETIC',code:'K9SYNTHETIC',percentage:tracePercent,discount:{id:'DISCOUNT01'}}]:[];
  const rawOrder={refundsVerified:true,raw:{discounts:{elements:discounts}},...raw};
  sql(`INSERT INTO core.orders(id,business_id,clover_order_id,clover_merchant_id,clover_order_type_id,online_order,created_at,clover_state,order_total_cents,customer_id,match_status,raw_response)
   VALUES('${id}','${businessId}','${key()}','MERCHANT0001',${literal(type)},${online?'true':'false'},${literal(date)},${literal(state)},${amount??'NULL'},${literal(customerId)},${literal(matchStatus)},${literal(JSON.stringify(rawOrder))}::jsonb);
   INSERT INTO core.order_items(business_id,order_id,clover_item_id,name,quantity,price_cents,raw_response) VALUES('${businessId}','${id}','${key()}','Synthetic',${quantity??'NULL'},5000,${literal(JSON.stringify({item:{id:product},discounts:{elements:discounts}}))}::jsonb);`);
  if(amount!==null)sql(`INSERT INTO core.payments(id,business_id,order_id,clover_payment_id,amount_cents,payment_status,created_at,raw_response) VALUES('${paymentId}','${businessId}','${id}','${key()}',${amount},${literal(paymentStatus)},${literal(date)},${literal(JSON.stringify({taxAmount:0,tipAmount:0,...paymentRaw}))}::jsonb)`);
  return id;
 }
 function refund(orderId,amount,extra={}){const id=randomUUID();sql(`INSERT INTO core.refunds(id,business_id,order_id,payment_id,clover_refund_id,amount_cents,created_at,raw_response)
  SELECT '${id}',o.business_id,o.id,p.id,'${randomUUID().replaceAll('-','').slice(0,20)}',${amount},clock_timestamp(),${literal(JSON.stringify({taxAmount:0,tipAmount:0,...extra}))}::jsonb||jsonb_build_object('payment',jsonb_build_object('id',p.clover_payment_id))
  FROM core.orders o JOIN core.payments p ON p.order_id=o.id WHERE o.id='${orderId}' ORDER BY p.id LIMIT 1`);return id;}
 const expression=(campaignId,orderId,{businessId=config.businessId,units=1,source='clover_trace',staffActor=null,staffNote=null}={})=>
  `public.campaign_evaluate_v1('${businessId}','${campaignId}','${orderId}',${units},${literal(source)},${literal(staffActor)},${literal(staffNote)})`;
 const evaluate=(campaignId,orderId,opt={})=>sql('SELECT '+expression(campaignId,orderId,opt),{service:true});
 function session(text,application){const child=spawn(exe('psql'),args,{env:{...options.env,PGOPTIONS:options.env.PGOPTIONS+' -c application_name='+application},windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',s=>stdout+=s);child.stderr.on('data',s=>stderr+=s);
  const timer=setTimeout(()=>child.kill(),25000);const promise=new Promise((accept,reject)=>{child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(Error(stderr||'K9 parallel session failed'));else accept({stdout,stderr,pid:child.pid});});});child.stdin.end(text);return{child,promise};}
 return{config,repo,raw,sql,customer,staff,authorized,offer,campaign,order,refund,evaluate,expression,session,literal,stop};
}

async function eligibilityFixture(){
 const h=await baselineFixture();
 try{
  const path='supabase/migrations/20261021000600_campaign_eligibility_check.sql';
  const bytes=await readFile(join(h.repo,path));
  if(bytes.includes(13))throw Error('K10 SQL must have LF bytes');
  const before=h.sql("SELECT json_build_object('definition',pg_get_functiondef('public.campaign_evaluate_v1(uuid,uuid,uuid,integer,text,uuid,text)'::regprocedure),'acl',proacl,'securityDefiner',prosecdef,'config',proconfig) FROM pg_proc WHERE oid='public.campaign_evaluate_v1(uuid,uuid,uuid,integer,text,uuid,text)'::regprocedure");
  h.sql(bytes.toString('utf8'));
  const after=h.sql("SELECT json_build_object('definition',pg_get_functiondef('public.campaign_evaluate_v1(uuid,uuid,uuid,integer,text,uuid,text)'::regprocedure),'acl',proacl,'securityDefiner',prosecdef,'config',proconfig) FROM pg_proc WHERE oid='public.campaign_evaluate_v1(uuid,uuid,uuid,integer,text,uuid,text)'::regprocedure");
  for(const key of ['acl','securityDefiner','config'])if(JSON.stringify(before[key])!==JSON.stringify(after[key]))throw Error('K10 evaluator changed '+key);
  const run=h.config.run;
  await writeFile(join(run,'forward-migration.json'),JSON.stringify({path,sha256:createHash('sha256').update(bytes).digest('hex'),baselineRun:h.config.run,hosted:false,synthetic:true,evaluatorAclSecuritySearchPathUnchanged:true,before,after},null,2)+'\n');
  h.config.k10Run=run;
  h.eligibility=(orderId,{businessId=h.config.businessId,actor=h.config.scopeFixture.users.ownerA,role='authenticated',readOnly=false}={})=>{
   const id=h.sql(`SELECT to_jsonb(clover_order_id) FROM core.orders WHERE id='${orderId}'`);
   return h.sql((readOnly?'BEGIN READ ONLY;':'')+`SELECT public.campaign_eligibility_check_v1('${businessId}',${h.literal(id)});`+(readOnly?'COMMIT;':''),{role,subject:actor});
  };
  return h;
 }catch(error){await h.stop();throw error;}
}

export async function fixture(){
 const h=await eligibilityFixture();
 try {
 const path='supabase/migrations/20261021000800_signup_reward_coupons.sql';
 const bytes=await readFile(join(h.repo,path));if(bytes.includes(13))throw Error('K10 coupons SQL requires LF');
 h.sql(bytes.toString('utf8'));
 await writeFile(join(h.config.run,'coupon-migration.json'),JSON.stringify({path,sha256:digest(bytes),hosted:false,synthetic:true},null,2)+'\n');
 const signup=(customerId,{businessId=h.config.businessId,consent=true,source='website_vip_form',createdAt='2026-10-20T12:00:00Z'}={})=>{const id=randomUUID();h.sql(`INSERT INTO core.signups(id,business_id,customer_id,email,source,consent_email,created_at,is_test) SELECT '${id}','${businessId}',id,email,${literal(source)},${consent},${literal(createdAt)},is_test FROM core.customers WHERE id='${customerId}';INSERT INTO core.consent_events(customer_id,signup_id,event_type,source,email_requested,evidence_status) VALUES('${customerId}','${id}','request',${literal(source)},${consent},'pending_review')`);return id;};
 const reward=(overrides={})=>{h.sql(`UPDATE core.campaigns SET status='stopped' WHERE campaign_kind='signup_reward' AND status='active'`);return h.campaign({campaign_kind:'signup_reward',period:'campaign',include_tax:false,include_tip:false,ends_at:null,coupon_channels:['dine_in','site_pickup','site_delivery'],coupon_order_type_map:JSON.stringify({PICKUP0001:'site_pickup',DELIVERY01:'site_delivery'}),vip_list_id:'SYNTHETIC_VIP',...overrides});};
 const confirm=(customerId,signupId,{businessId=h.config.businessId,confirmedAt='2026-10-20T12:05:00Z',evidence={},profile='synthetic-profile-'+customerId}={})=>{const hash=h.sql(`SELECT to_jsonb(encode(sha256(convert_to(lower(btrim(email)),'UTF8')),'hex')) FROM core.customers WHERE id='${customerId}'`);return h.sql(`SELECT public.coupon_record_confirmed_vip_v1('${businessId}','${customerId}','${signupId}',${literal(profile)},${literal(confirmedAt)},clock_timestamp(),${literal(JSON.stringify({source:'klaviyo',listId:'SYNTHETIC_VIP',emailSha256:hash,doubleOptIn:true,canReceiveEmailMarketing:true,consent:'SUBSCRIBED',...evidence}))}::jsonb)`,{service:true});};
 const coupon=customerId=>h.sql(`SELECT to_jsonb(c) FROM core.campaign_coupons c WHERE customer_id='${customerId}' ORDER BY issued_at DESC,id LIMIT 1`);
 const note=(overrides={})=>({version:1,receiptAt:new Date().toISOString(),text:'Synthetic staff receipt checked',channel:'dine_in',qualifyingAmountCents:3000,receiptRef:randomUUID(),...overrides});
 const redeemExpression=(code,{businessId=h.config.businessId,cloverOrderId=null,attestation=note()}={})=>`public.coupon_redeem_v1('${businessId}',${literal(code)},${literal(cloverOrderId)},${literal(JSON.stringify(attestation))}::jsonb)`;
 const redeem=(code,opt={})=>h.sql('SELECT '+redeemExpression(code,opt),{role:'authenticated',subject:opt.actor||h.config.scopeFixture.users.ownerA});
 return {...h,signup,reward,confirm,coupon,note,redeemExpression,redeem};
 }catch(error){await h.stop();throw error;}
}
