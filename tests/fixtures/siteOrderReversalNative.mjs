// Local-only PG18.6 fixture for Clover void/refund -> site order. Owns a temporary
// loopback cluster; never reads hosted URLs, keys or inherited PG* environment.
import {readFile,mkdtemp,rm,realpath} from 'node:fs/promises';
import {randomUUID,randomInt,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {dirname,resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const literal=value=>value===null||value===undefined?'NULL':"'"+String(value).replaceAll("'","''")+"'";
const cleanEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>
 ['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','COMSPEC','PATHEXT'].includes(key.toUpperCase())));
export const lf=async path=>Buffer.from((await readFile(join(repo,path))).toString('utf8').replaceAll('\r\n','\n'));
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const MIGRATION='supabase/migrations/20261030000100_site_order_clover_reversal.sql';
export const ROLLBACK='supabase/rollbacks/20261030000100_site_order_clover_reversal_down.sql';

export async function fixture({install=true}={}){
 const bin=await realpath(process.env.SITE_ORDER_PG_BIN||join(process.env.USERPROFILE||'','scoop/apps/postgresql/current/bin'));
 const exe=name=>join(bin,name+(process.platform==='win32'?'.exe':''));
 const run=await mkdtemp(join(tmpdir(),'site-order-reversal-'));
 const data=join(run,'data'),port=randomInt(56000,62000),database='reversal_'+randomUUID().replaceAll('-','').slice(0,12);
 const options={windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,env:{...cleanEnv(),PGCLIENTENCODING:'UTF8',
  PGCONNECT_TIMEOUT:'2',PGPASSFILE:join(run,'not-a-password-file'),PGOPTIONS:'-c statement_timeout=20000 -c lock_timeout=12000'}};
 const command=(name,args)=>{const r=spawnSync(exe(name),args,{...options,...(name==='pg_ctl'?{stdio:['ignore','ignore','ignore']}:{})});
  if(r.status!==0)throw Error(name+': '+(r.stderr||r.stdout||r.error?.message));return r.stdout||'';};
 if(!/18\.6\b/.test(command('psql',['--version'])))throw Error('PostgreSQL 18.6 required');
 command('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
 command('pg_ctl',['-D',data,'-l',join(run,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1 -c max_connections=12`,'-w','start']);
 const args=['-X','-q','-w','-h','127.0.0.1','-p',String(port),'-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-At'];
 function raw(text,{service=false,role=null}={}){
  const prefix=service?"SET request.jwt.claim.role='service_role';SET ROLE service_role;":role?`SET request.jwt.claim.role=${literal(role)};SET ROLE ${role};`:'';
  return spawnSync(exe('psql'),args,{...options,input:prefix+text});
 }
 function sql(text,opt={}){const r=raw(text,opt);if(r.status!==0)throw Error(r.stderr||r.error?.message||'SQL failed');
  const last=r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);return last===undefined?null:last==='t'?true:last==='f'?false:JSON.parse(last);}
 let stopped=false;
 async function stop(){if(stopped)return;stopped=true;
  try{command('pg_ctl',['-D',data,'-m','fast','-w','stop']);}finally{await rm(run,{recursive:true,force:true}).catch(()=>{});}}
 const businessId=randomUUID(),merchant='MERCHANT0001';
 try{
  command('createdb',['-h','127.0.0.1','-p',String(port),'-U','postgres','-w',database]);
  const identity=sql("SELECT json_build_object('host',host(inet_server_addr()),'port',inet_server_port(),'database',current_database())");
  if(identity.host!=='127.0.0.1'||identity.port!==port||identity.database!==database)throw Error('local target mismatch');
  for(const path of ['tools/test-env/k9-local-bootstrap.sql','supabase/migrations/20261020000700_clover_order_core.sql']){
   const r=raw((await lf(path)).toString('utf8'));if(r.status!==0)throw Error(path+': '+r.stderr);
  }
  // Facade for the K16 guard only; staff authorization is not under test here.
  sql(`CREATE FUNCTION core.staff_authorized_v1(p_business_id uuid,p_operation text) RETURNS boolean
   LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT false$$;
   REVOKE ALL ON FUNCTION core.staff_authorized_v1(uuid,text) FROM PUBLIC,anon,authenticated,service_role;`);
  for(const path of ['supabase/migrations/20261022000100_site_order_foundation.sql','supabase/migrations/20261022000300_site_order_staff_workflow.sql']){
   const r=raw((await lf(path)).toString('utf8'));if(r.status!==0)throw Error(path+': '+r.stderr);
  }
  sql(`INSERT INTO core.businesses(id,name) VALUES('${businessId}','Synthetic reversal restaurant')`);
  if(install){const r=raw((await lf(MIGRATION)).toString('utf8'));if(r.status!==0)throw Error(MIGRATION+': '+r.stderr);}
 }catch(error){await stop();throw error;}

 const key=()=>randomUUID().replaceAll('-','').slice(0,20).toUpperCase();
 const rpc=(name,params)=>sql('SELECT to_jsonb(public.'+name+'('+params.map(v=>typeof v==='object'&&v!==null?literal(JSON.stringify(v))+'::jsonb':literal(v)).join(',')+'))',{service:true});
 // A verified site order exactly as the Hosted Checkout webhook leaves it.
 function paidOrder({subtotal=10000,tax=0}={}){
  const request=randomUUID(),session='SESSION'+key();
  const orderId=rpc('site_order_create_v1',[businessId,request,sha256(request),'catering','pickup','INTERNAL TEST reversal',
   'synthetic@fixture.test',null,new Date(Date.now()+10*86400000).toISOString(),[{name:'Synthetic tray',quantity:1}],'',subtotal,tax,'catering']);
  rpc('site_order_session_set_v1',[businessId,orderId,'production',merchant,session]);
  const paymentId=key(),cloverOrderId=key();
  const state=rpc('site_order_payment_confirm_v1',[businessId,session,merchant,paymentId,subtotal+tax,new Date().toISOString(),{id:paymentId}]);
  if(state!=='paid')throw Error('synthetic order not paid: '+state);
  return {orderId,paymentId,cloverOrderId,amount:subtotal+tax};
 }
 // The same ingest RPC that the Clover app webhook and the daily pull call.
 function ingest(cloverOrderId,{payments=[],refunds=[]}){
  return rpc('clover_order_ingest_v1',[businessId,merchant,{id:cloverOrderId,merchantId:merchant,orderTypeId:'ONLINE0001',online:false,
   createdTime:Date.now()-60000,state:'locked',total:payments[0]?.amount??0,items:[],refundsVerified:true,
   payments:payments.map(p=>({createdTime:Date.now()-60000,...p})),
   refunds:refunds.map(r=>({createdTime:Date.now(),...r}))}]);
 }
 const state=orderId=>sql(`SELECT json_build_object('order',o.status,'payment',(SELECT status FROM core.site_order_payments p WHERE p.site_order_id=o.id),
  'tickets',(SELECT json_agg(status ORDER BY department) FROM core.site_order_tickets t WHERE t.site_order_id=o.id),
  'events',(SELECT json_agg(json_build_object('type',event_type,'key',event_key,'details',details) ORDER BY id) FROM core.site_order_events e
   WHERE e.site_order_id=o.id AND e.event_type NOT IN ('order_created','payment_verified')))
  FROM core.site_orders o WHERE o.id='${orderId}'`);
 const log=sourceKey=>sql(`SELECT to_jsonb(r) FROM core.site_order_clover_reversals r WHERE business_id='${businessId}' AND source_key=${literal(sourceKey)}`);
 return {raw,sql,stop,rpc,key,paidOrder,ingest,state,log,businessId,merchant};
}
