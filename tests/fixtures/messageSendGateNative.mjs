// Dedicated synthetic loopback fixture only. Never reads hosted credentials.
import {readFile,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
import {dirname,resolve,relative,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const workspace=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const evidence=resolve(workspace,'20_Yonetim/Teslim_Raporlari/K6_kanit');
const env=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','COMSPEC','PATHEXT'].includes(key.toUpperCase())));
export async function fixture(){
 if(!process.env.K6_NATIVE_CONFIG)return null;
 const configPath=await realpath(process.env.K6_NATIVE_CONFIG);
 if(!configPath.startsWith(evidence+sep))throw Error('K6 owned evidence config required');
 const config=JSON.parse(await readFile(configPath,'utf8'));
 const owner=JSON.parse(await readFile(config.ownerFile,'utf8'));
 if(config.scope!=='K6_OWNED_NATIVE_SYNTHETIC_ONLY'||config.host!=='127.0.0.1'||config.port!==55476
  ||!/^k6_native_[a-f0-9]{12}$/.test(config.database)||owner.nonce!==config.nonce
  ||owner.data_directory!==config.dataDirectory||!resolve(config.dataDirectory).startsWith(evidence+sep)
  ||!/^[a-f0-9-]{36}$/i.test(config.businessId))throw Error('K6 local target binding rejected');
 const actual=createHash('sha256').update(await readFile(config.psql)).digest('hex');
 if(actual!==config.psqlSha256)throw Error('K6 psql hash mismatch');
 const options=(service=false,application='')=>({windowsHide:true,encoding:'utf8',timeout:20000,maxBuffer:2*1024*1024,
  env:{...env(),PGCLIENTENCODING:'UTF8',PGCONNECT_TIMEOUT:'2',PGPASSFILE:join(dirname(configPath),'no-password-file'),
   PGOPTIONS:`-c statement_timeout=15000 -c lock_timeout=10000${application?' -c application_name='+application:''}`},
  prefix:service?"SET request.jwt.claim.role='service_role'; SET ROLE service_role;\n":''});
 const args=['-X','-q','-w','-h',config.host,'-p',String(config.port),'-U','postgres','-d',config.database,'-v','ON_ERROR_STOP=1','-At'];
 function run(text,{service=false,application=''}={}){
  const opt=options(service,application);const result=spawnSync(config.psql,args,{...opt,input:opt.prefix+text});
  if(result.status!==0)throw Error(result.stderr||result.error?.message||'K6 local SQL failed');
  return result.stdout.trim().split(/\r?\n/).filter(Boolean);
 }
 function sql(text,opt={}){const lines=run(text,opt);if(!lines.length)return null;const last=lines.at(-1);return last==='t'?true:last==='f'?false:JSON.parse(last);}
 const identity=sql("SELECT json_build_object('host',host(inet_server_addr()),'port',inet_server_port(),'database',current_database(),'dataDirectory',current_setting('data_directory'))");
 if(identity.host!==config.host||identity.port!==config.port||identity.database!==config.database
  ||resolve(identity.dataDirectory)!==resolve(config.dataDirectory))throw Error('K6 actual server identity mismatch');
 const literal=value=>"'"+String(value).replaceAll("'","''")+"'";
 const reserve=intent=>sql(`SELECT public.message_send_reserve_v1(${literal(intent.businessId)},${literal(intent.customerId)},${literal(intent.messageKey)},${literal(intent.messageKind)},${literal(intent.payloadSha256)})`,{service:true});
 const claim=id=>sql(`SELECT public.message_send_claim_v1(${literal(id)})`,{service:true});
 const context=(id,lease)=>sql(`SELECT public.message_send_context_v1(${literal(id)},${literal(lease)})`,{service:true});
 const finalize=(id,lease,outcome)=>sql(`SELECT public.message_send_finalize_v1(${literal(id)},${literal(lease)},${literal(outcome)})`,{service:true});
 function customer({status='subscribed',isTest=false}={}){
  if(!['subscribed','unsubscribed','not_subscribed','pending_review'].includes(status))throw Error('Synthetic status only');
  const id=randomUUID();sql(`INSERT INTO core.customers(id,business_id,identity_key,name,email,email_status,email_suppressed_at,is_test)
   VALUES('${id}','${config.businessId}','email:${id}@fixture.test','Synthetic native fixture','${id}@fixture.test','${status}',${status==='unsubscribed'?'clock_timestamp()':'NULL'},${isTest?'true':'false'});`);
  return id;
 }
 function session(text,application){
  const opt=options(false,application);const child=spawn(config.psql,args,{env:opt.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
  const timer=setTimeout(()=>child.kill(),20000);
  const promise=new Promise((accept,reject)=>{child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(Error(stderr||'K6 session failed'));else accept({stdout,stderr,pid:child.pid});});});
  child.stdin.end(text);return{child,promise};
 }
 return{config,sql,run,reserve,claim,context,finalize,customer,session,literal,options,args};
}
