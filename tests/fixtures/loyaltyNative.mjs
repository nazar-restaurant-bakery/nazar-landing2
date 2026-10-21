// Local-only PG18.6 fixture. Never reads hosted URLs, keys, password files or
// inherited PG*/database environment. Server owns a random loopback port/path.
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {createHash,randomUUID,randomInt} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
import {dirname,resolve,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const workspace=resolve(repo,'../..');
const evidence=resolve(workspace,'20_Yonetim/Teslim_Raporlari/K11_kanit');
const cleanEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>
 ['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','COMSPEC','PATHEXT'].includes(key.toUpperCase())));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export const literal=value=>value===null?'NULL':"'"+String(value).replaceAll("'","''")+"'";
export async function fixture(){
 const bin=await realpath(process.env.K11_PG_BIN||join(process.env.USERPROFILE,'scoop/apps/postgresql/18.6-4/bin'));
 const exe=name=>join(bin,name+(process.platform==='win32'?'.exe':''));
 const nonce=randomUUID();const run=resolve(evidence,'native-'+new Date().toISOString().replaceAll(/[:.]/g,'-')+'-'+nonce.slice(0,8));
 await mkdir(run,{recursive:true});
 if(!run.startsWith(evidence+sep))throw Error('K11 evidence target rejected');
 const data=join(run,'data'),port=randomInt(56000,62000),database='k11_'+nonce.replaceAll('-','').slice(0,12);
 const config={scope:'K11_OWNED_NATIVE_SYNTHETIC_ONLY',host:'127.0.0.1',port,database,dataDirectory:data,nonce,bin,run,
  businessId:randomUUID(),secondBusinessId:randomUUID(),psqlSha256:digest(await readFile(exe('psql')))};
 const options={windowsHide:true,encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,env:{...cleanEnv(),PGCLIENTENCODING:'UTF8',
  PGCONNECT_TIMEOUT:'2',PGPASSFILE:join(run,'not-a-password-file'),PGOPTIONS:'-c statement_timeout=20000 -c lock_timeout=12000'}};
 function command(name,args,input){const result=spawnSync(exe(name),args,{...options,input});
  if(result.status!==0)throw Error(name+': '+(result.stderr||result.stdout||result.error?.message));return result.stdout;}
 const version=command('psql',['--version']);if(!/18\.6\b/.test(version))throw Error('K11 requires native PostgreSQL 18.6');
 const init=command('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
 await writeFile(join(run,'owner.json'),JSON.stringify(config,null,2)+'\n');
 await writeFile(join(run,'initdb.txt'),init);
 const start=command('pg_ctl',['-D',data,'-l',join(run,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1 -c max_connections=12`,'-w','start']);
 await writeFile(join(run,'startup.txt'),start);
 const args=['-X','-q','-w','-h','127.0.0.1','-p',String(port),'-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-At'];
 const history=[];
 function raw(text,{service=false,role=null,application=''}={}){
  const prefix=(service?"SET request.jwt.claim.role='service_role';SET ROLE service_role;":role?`SET request.jwt.claim.role='${role}';SET ROLE ${role};`:'');
  const result=spawnSync(exe('psql'),args,{...options,input:prefix+text,
   env:{...options.env,PGOPTIONS:options.env.PGOPTIONS+(application?' -c application_name='+application:'')}});
  history.push({ok:result.status===0,application,sqlSha256:digest(prefix+text)});
  return result;
 }
 function sql(text,opt={}){const result=raw(text,opt);if(result.status!==0)throw Error(result.stderr||result.error?.message||'K11 SQL failed');
  const last=result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);return last===undefined?null:last==='t'?true:last==='f'?false:JSON.parse(last);}
 let stopped=false;
 async function stop(){if(stopped)return;stopped=true;await writeFile(join(run,'query-audit.json'),JSON.stringify(history,null,2)+'\n');
  const result=command('pg_ctl',['-D',data,'-m','fast','-w','stop']);await writeFile(join(run,'shutdown.txt'),result);}
 try{
  command('createdb',['-h','127.0.0.1','-p',String(port),'-U','postgres','-w',database]);
  const identity=sql("SELECT json_build_object('host',host(inet_server_addr()),'port',inet_server_port(),'database',current_database(),'dataDirectory',current_setting('data_directory'),'serverVersion',current_setting('server_version'))");
  if(identity.host!==config.host||identity.port!==port||identity.database!==database||resolve(identity.dataDirectory)!==resolve(data))throw Error('K11 actual local target mismatch');
  const files=['tools/test-env/k11-local-bootstrap.sql','supabase/migrations/20261019000100_test_record_markers.sql','supabase/migrations/20261020000700_clover_order_core.sql','supabase/migrations/20261020000900_clover_optional_scope_status.sql','supabase/migrations/20261021000200_campaign_engine.sql','supabase/migrations/20261021000300_loyalty_referrals_metrics.sql'];
  if(!/^18\.6\b/.test(identity.serverVersion))throw Error('K11 actual server version must be18.6');
  const sourceFiles=[];for(const path of ['tests/loyaltyReferralsDb.test.mjs','tests/fixtures/loyaltyNative.mjs']){
   const bytes=await readFile(join(repo,path));sourceFiles.push({path,sha256:digest(bytes)});await mkdir(join(run,'test-source'),{recursive:true});await writeFile(join(run,'test-source',path.split('/').at(-1)),bytes);}
  const functions=oids=>sql(`SELECT COALESCE(json_agg(json_build_object('oid',p.oid::text,'schema',n.nspname,'name',p.proname,
   'arguments',pg_get_function_identity_arguments(p.oid),'definition',pg_get_functiondef(p.oid),'acl',p.proacl,
   'securityDefiner',p.prosecdef,'config',p.proconfig) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),'[]'::json)
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('core','public','auth')${oids?' AND p.oid IN('+oids.join(',')+')':''}`);
  let beforeFunctions=null,existingRpcProof=null;
  const hashes=[];for(const path of files){const checkout=await readFile(join(repo,path));
   const canonicalK7Hashes={
    'supabase/migrations/20261020000700_clover_order_core.sql':'5f68772059d9cd1e1d7a6a290aa31ee32d10ff5a367201577c4058861aada4a8',
    'supabase/migrations/20261020000900_clover_optional_scope_status.sql':'a3778d0b933c4ce1a56dba04bcadc31b3f6d1c8f214d56af8203a88d6bcc826e'};
   const canonicalK7=Object.hasOwn(canonicalK7Hashes,path);
   const bytes=canonicalK7?Buffer.from(checkout.toString('utf8').replaceAll('\r\n','\n')):checkout;
   if(bytes.includes(13))throw Error('K11 SQL must have LF bytes: '+path);
   if(canonicalK7&&digest(bytes)!==canonicalK7Hashes[path])throw Error('Exact canonical historical K7 SHA required: '+path);
   hashes.push({path,sha256:digest(bytes),checkoutSha256:digest(checkout),canonicalLfOnly:canonicalK7});await mkdir(join(run,'applied-sql'),{recursive:true});
   await writeFile(join(run,'applied-sql',path.split('/').at(-1)),bytes);
   await writeFile(join(run,'applied-sql','manifest.json'),JSON.stringify(hashes,null,2)+'\n');
   const isK11=path==='supabase/migrations/20261021000300_loyalty_referrals_metrics.sql';
   if(isK11){beforeFunctions=functions();const dayTotals=beforeFunctions.find(f=>f.schema==='public'&&f.name==='clover_order_day_totals_v1');
    if(!dayTotals||!['refundUnverifiedCount','customerAccessDeniedCount','reconciliationConfirmed'].every(field=>dayTotals.definition.includes(field)))throw Error('K11 parity requires the exact main K7 optional-scope day totals function');
    await writeFile(join(run,'existing-functions-before.json'),JSON.stringify(beforeFunctions,null,2)+'\n');}
   const r=raw(bytes.toString('utf8'));if(r.status!==0)throw Error(path+': '+r.stderr);
   if(isK11){const afterFunctions=functions(beforeFunctions.map(f=>f.oid));const beforeSha256=digest(JSON.stringify(beforeFunctions)),afterSha256=digest(JSON.stringify(afterFunctions));
    await writeFile(join(run,'existing-functions-after.json'),JSON.stringify(afterFunctions,null,2)+'\n');
    const dayTotals=beforeFunctions.find(f=>f.schema==='public'&&f.name==='clover_order_day_totals_v1');
    existingRpcProof={scope:'K11_EXISTING_FUNCTION_DEFINITION_ACL_PARITY',count:beforeFunctions.length,beforeSha256,afterSha256,
     requiredK7DayTotals:{name:'public.clover_order_day_totals_v1',definitionSha256:digest(dayTotals.definition),scopeFields:['refundUnverifiedCount','customerAccessDeniedCount','reconciliationConfirmed']},
     unchanged:beforeSha256===afterSha256,properties:['pg_get_functiondef','proacl','prosecdef','proconfig'],fixture_subset_only:true};
    await writeFile(join(run,'existing-rpc-parity.json'),JSON.stringify(existingRpcProof,null,2)+'\n');
    if(!existingRpcProof.unchanged)throw Error('K11 altered an existing fixture RPC definition or grant');}
  }
  sql(`INSERT INTO core.businesses(id,name,is_test) VALUES('${config.businessId}','Synthetic Restaurant A',true),('${config.secondBusinessId}','Synthetic Restaurant B',true)`);
  await writeFile(join(run,'setup.json'),JSON.stringify({...config,postgresVersion:version.trim(),identity,files:hashes,sourceFiles,existingRpcProof,
   hosted_connection:false,hosted_migration:false,real_customer_data:false,fixture_not_hosted_multitenancy_proof:true,k6_source_shape_only:true,k6_gate_not_executed:true},null,2)+'\n');
 }catch(error){await writeFile(join(run,'setup-failure.json'),JSON.stringify({error:String(error.message),hosted_connection:false,passed:false},null,2)+'\n');await stop();throw error;}
 function customer({businessId=config.businessId,status='subscribed',suppressed=status==='unsubscribed'}={}){
  const id=randomUUID();sql(`INSERT INTO core.customers(id,business_id,identity_key,name,email,email_status,email_suppressed_at,is_test) VALUES(
   '${id}','${businessId}','email:${id}@synthetic.invalid','Synthetic K11','${id}@synthetic.invalid',${literal(status)},${suppressed?'clock_timestamp()':'NULL'},true)`);return id;
 }
 function offer({businessId=config.businessId}={}){const id=randomUUID();sql(`INSERT INTO core.offers(id,business_id,name,starts_at,ends_at,active,is_test) VALUES('${id}','${businessId}','Synthetic K11',DATE '2020-01-01',DATE '2040-01-01',true,true)`);return id;}
 function campaign(overrides={}){
  const base={id:randomUUID(),business_id:config.businessId,offer_id:null,name:'Synthetic campaign',benefit_type:'item',target_clover_item_id:'PRODUCT0001',
   benefit_code:'K11SYNTHETIC',min_amount_cents:3000,include_tax:true,include_tip:true,order_type_ids:['PICKUP0001'],starts_at:'2025-01-01T00:00:00Z',ends_at:'2030-01-01T00:00:00Z',
   tz_name:'America/New_York',eligibility:'subscribed_only',max_units_per_order:1,period:'week',max_total_units:null,status:'active',is_test:true};
  const row={...base,...overrides};row.offer_id??=offer({businessId:row.business_id});
  const val=value=>Array.isArray(value)?'ARRAY['+value.map(item=>typeof item==='number'?String(item):literal(item)).join(',')+']':typeof value==='boolean'?(value?'true':'false'):typeof value==='number'?String(value):literal(value);
  sql(`INSERT INTO core.campaigns(${Object.keys(row).join(',')}) VALUES(${Object.values(row).map(val).join(',')})`);return row.id;
 }
 function order(customerId,{businessId=config.businessId,date='2026-10-15T16:00:00Z',amount=5000,paymentStatus='SUCCESS',state='OPEN',type='PICKUP0001',
  product='PRODUCT0001',quantity=1,trace=true,tracePercent=100,paymentRaw={},raw={},online=true,matchStatus='exact'}={}){
  const id=randomUUID(),paymentId=randomUUID();const key=()=>randomUUID().replaceAll('-','').slice(0,20);
  const discounts=trace?[{id:'DISCOUNT01',name:'K11SYNTHETIC',code:'K11SYNTHETIC',percentage:tracePercent,discount:{id:'DISCOUNT01'}}]:[];
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
  const timer=setTimeout(()=>child.kill(),25000);const promise=new Promise((accept,reject)=>{child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(Error(stderr||'K11 parallel session failed'));else accept({stdout,stderr,pid:child.pid});});});child.stdin.end(text);return{child,promise,live:()=>({stdout,stderr})};}
 return{config,repo,raw,sql,customer,offer,campaign,order,refund,evaluate,expression,session,literal,stop};
}
