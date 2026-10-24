/** Native transport/readback checks only. Every outbound request terminates in
 * the synthetic service below: no network proxy, hosted SQL, event or email.
 * Full PostgreSQL claim/race/late-binding acceptance belongs to its own suite. */
import assert from 'node:assert/strict';
import {after,before,beforeEach,describe,test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),versions={};
let Miniflare,WorkerResponse,convertV4MiniflareOptions,build,toolingReason=false;
try{
 ({Miniflare,Response:WorkerResponse,convertV4MiniflareOptions}=require('miniflare'));
 versions.miniflare=require('miniflare/package.json').version;
 versions.workerd=createRequire(require.resolve('miniflare/package.json'))('workerd/package.json').version;
 let esbuild;try{esbuild=require('esbuild');}catch{esbuild=createRequire(require.resolve('wrangler/package.json'))('esbuild');}
 build=esbuild.build;versions.esbuild=esbuild.version;
 if(!versions.miniflare.startsWith('5.')||!versions.workerd.startsWith('1.')||typeof convertV4MiniflareOptions!=='function')toolingReason='Requires Miniflare 5/workerd 1 converter API';
}catch{toolingReason='Optional Miniflare 5/workerd 1/esbuild unavailable; native suite not executed';}
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ORIGIN='https://www.nazarrestaurantandbakery.com';
const READ='pk_synthetic_read_123456',EVENT='pk_synthetic_event_123456',RECEIPT='pk_synthetic_receipt_123456';
let mf,temp,calls=[],scenario={};
const wrapper=`
import {bootstrapProvider,bootstrapStore,verifyCouponBootstrapEvent} from './functions/_lib/couponBootstrap.ts';
import {couponWelcomeProperties,handleCouponProcessRequest,COUPON_WELCOME_METRIC} from './functions/_lib/couponWelcome.ts';
import {boundedJsonText} from './functions/_lib/bootstrapReadBudget.ts';
import {onRequest as bootstrapRoute} from './functions/api/internal/coupon-bootstrap.ts';
import {onRequest as normalRoute} from './functions/api/internal/coupon-welcome.ts';
const businessId='10000000-0000-4000-8000-000000000001',couponId='20000000-0000-4000-8000-000000000001';
const eventUniqueId='30000000-0000-4000-8000-000000000001',permitId='40000000-0000-4000-8000-000000000001';
const config={mode:'live',isolated:false,url:'https://abcdefghijklmnopqrst.supabase.co',businessId,serviceKey:'sb_secret_synthetic',processKey:'synthetic_process_key_12345678901234567890',accountId:'ACCOUNT',readKey:'pk_synthetic_read_123456',eventKey:'pk_synthetic_event_123456',receiptKey:'pk_synthetic_receipt_123456',qrOrigin:'https://qr.synthetic.invalid',approvalId:'synthetic-approval'};
const job={businessId,couponId,eventUniqueId,jobId:'50000000-0000-4000-8000-000000000001',jobLeaseId:'60000000-0000-4000-8000-000000000001',customerId:'70000000-0000-4000-8000-000000000001',recipient:'synthetic@example.invalid',messageKey:'coupon-welcome:'+couponId,properties:{coupon_code:'2345-6789-ABCD-EFGH',coupon_qr_payload:'VIPCOUPON1:2345-6789-ABCD-EFGH',coupon_qr_token:'a'.repeat(32),campaign_id:'80000000-0000-4000-8000-000000000001',coupon_id:couponId,minimum_amount_cents:3000,channels:['dine_in','site_pickup','site_delivery'],expires_at:null,message_key:'coupon-welcome:'+couponId}};
const expected={...couponWelcomeProperties(job,config.qrOrigin),bootstrap_event_unique_id:eventUniqueId};
export default {async fetch(request){
 const url=new URL(request.url),op=url.searchParams.get('op');
 if(url.pathname==='/disabled-bootstrap')return bootstrapRoute({request:new Request('https://www.nazarrestaurantandbakery.com/api/internal/coupon-bootstrap',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'dispatch',permitId})}),env:{}});
 if(url.pathname==='/disabled-normal')return normalRoute({request:new Request('https://www.nazarrestaurantandbakery.com/api/internal/coupon-welcome',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'welcome',businessId,couponId})}),env:{}});
 if(url.pathname==='/inject-normal'){
  const trap={async rpc(){throw Error('UNEXPECTED_STORE_CALL');}},provider={mode:'live',async get(){throw Error('UNEXPECTED_PROVIDER_CALL');},async eventAccount(){throw Error('UNEXPECTED_PROVIDER_CALL');},async event(){throw Error('UNEXPECTED_PROVIDER_CALL');}};
  return handleCouponProcessRequest(new Request('https://www.nazarrestaurantandbakery.com/api/internal/coupon-welcome',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.processKey},body:JSON.stringify({action:'welcome',businessId,couponId,protocol:{claim:'injected'}})}),config,{store:trap,provider});
 }
 const provider=bootstrapProvider(config);
 try{
  if(url.pathname==='/verify'){
   const records=[],hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(expected))))].map(n=>n.toString(16).padStart(2,'0')).join('');
   const context={...job,allowed:true,permitId,state:'awaiting_event',attempts:1,accountId:'ACCOUNT',profileId:'PROFILE',vipListId:'LIST',qrOrigin:config.qrOrigin,expiresAt:'2026-10-24T16:30:00Z',recoverUntil:'2026-10-25T17:00:00Z',confirmedAt:'2026-10-24T15:00:00Z',dispatchedAt:'2026-10-24T16:00:00Z',reservationId:'90000000-0000-4000-8000-000000000001',payloadSha256:hash};
   const store={async rpc(name,args){if(name==='coupon_bootstrap_preview_v1')return context;if(name==='coupon_delivery_context_v1')return null;if(name==='coupon_bootstrap_record_event_v1'){records.push(args);return {acknowledged:true};}throw Error('UNEXPECTED_RPC');}};
   const result=await verifyCouponBootstrapEvent({config,store,provider,permitId,now:()=>Date.parse('2026-10-24T17:00:00Z')});
   return Response.json({result,records:records.length});
  }
  let value;
  if(op==='budgetStall'){
   let cancelled=false;
   try{await boundedJsonText(new Response(new ReadableStream({cancel(){cancelled=true;}})),{remaining:100},100,10);throw Error('EXPECTED_TIMEOUT');}
   catch(e){return Response.json({ok:e.message==='bootstrap_read_timeout',cancelled});}
  }
  else if(op==='aggregate') {for(let i=0;i<5;i++)await provider.coupon.get('/accounts');value={};}
  else if(op==='rpcBudget'){value=await bootstrapStore(config).rpc('coupon_bootstrap_preview_v1',{p_permit_id:permitId});}
  else if(op==='readAccount')value=await provider.coupon.get('/accounts');
  else if(op==='eventAccount')value=await provider.coupon.eventAccount();
  else if(op==='profile')value=await provider.coupon.get('/profiles',{filter:'equals(email,"synthetic@example.invalid")','additional-fields[profile]':'subscriptions','page[size]':'2'});
  else if(op==='inventory')value=await provider.inventory();
  else if(op==='events')value=await provider.events('PROFILE','METRIC','2026-10-24T16:00:00Z');
  else if(op==='eventNormal'||op==='eventMarker'||op==='eventInvalid'){
   const properties=op==='eventNormal'?couponWelcomeProperties(job,config.qrOrigin):{...expected};
   if(op==='eventInvalid')properties.bootstrap_event_unique_id='wrong';
   value=await provider.coupon.event({data:{type:'event',attributes:{properties,metric:{data:{type:'metric',attributes:{name:COUPON_WELCOME_METRIC}}},profile:{data:{type:'profile',attributes:{email:job.recipient}}},unique_id:eventUniqueId}}},AbortSignal.timeout(1000));
  }else throw Error('INVALID_TEST_OPERATION');
  return Response.json({ok:true,...(op?.startsWith('event')&&op!=='events'&&op!=='eventAccount'?{status:value.status}:{})});
 }catch(e){return Response.json({code:'synthetic_transport_rejected',...(['bootstrap_read_limit','bootstrap_read_timeout'].includes(e.message)?{reason:e.message}:{})},{status:503});}
}};`;
function metric(id='METRIC'){return {type:'metric',id,attributes:{name:'Nazar Coupon Welcome Authorized',integration:{name:'API',category:'API'}}};}
function normalized(){
 const id='20000000-0000-4000-8000-000000000001',unique='30000000-0000-4000-8000-000000000001';
 const properties={coupon_code:'2345-6789-ABCD-EFGH',coupon_qr_payload:'VIPCOUPON1:2345-6789-ABCD-EFGH',coupon_qr_image_url:'https://qr.synthetic.invalid/api/coupon-qr/'+ 'a'.repeat(32)+'.gif',campaign_id:'80000000-0000-4000-8000-000000000001',coupon_id:id,minimum_amount_cents:3000,channels:['dine_in','site_pickup','site_delivery'],message_key:'coupon-welcome:'+id,bootstrap_event_unique_id:unique,$event_id:unique};
 if(scenario.normalized==='wrong-id')properties.$event_id='WRONG';
 if(scenario.normalized==='missing-marker')delete properties.bootstrap_event_unique_id;
 if(scenario.normalized==='unexpected')properties.unexpected='not allowed';
 return {id:'EVENT',attributes:{datetime:'2026-10-24T16:00:01Z',uuid:'PROVIDER_GENERATED_DIFFERENT_UUID',event_properties:properties},relationships:{profile:{data:{id:'PROFILE'}},metric:{data:{id:'METRIC'}}}};
}
async function outbound(request){
 const url=new URL(request.url),record={url:request.url,path:url.pathname,method:request.method,authorization:request.headers.get('authorization'),revision:request.headers.get('revision')};
 if(request.method==='POST')record.body=await request.json();calls.push(record);
 if(url.origin==='https://abcdefghijklmnopqrst.supabase.co'&&url.pathname==='/rest/v1/rpc/coupon_bootstrap_preview_v1'&&request.method==='POST')return WorkerResponse.json({padding:'x'.repeat(128001)});
 if(url.origin!=='https://a.klaviyo.com')return new WorkerResponse('SYNTHETIC_OUTBOUND_DENIED',{status:418});
 if(scenario.path===url.pathname&&(!scenario.method||scenario.method===request.method)){
  if(scenario.status)return new WorkerResponse(scenario.status===204?null:'PRIVATE_SYNTHETIC_PROVIDER_BODY',{status:scenario.status,headers:{Location:scenario.location||'https://credential-trap.invalid/key-trap'}});
  if(scenario.body==='utf8-limit')return WorkerResponse.json({padding:'é'.repeat(500000)});
  if(scenario.body==='chunk-limit')return new WorkerResponse(new ReadableStream({start(c){c.enqueue(new Uint8Array(600000).fill(32));c.enqueue(new Uint8Array(600000).fill(32));c.close();}}),{status:200});
  if(scenario.body==='aggregate')return WorkerResponse.json({data:[{id:'ACCOUNT'}],padding:'x'.repeat(900000)});
  if(scenario.body==='exact-limit'){const empty=JSON.stringify({data:[],padding:''});return WorkerResponse.json({data:[],padding:'x'.repeat(1000000-new TextEncoder().encode(empty).length)});}
  if(scenario.body==='stall')return new WorkerResponse(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));},cancel(){}}),{status:200});
  if(scenario.malformed)return new WorkerResponse('PRIVATE_SYNTHETIC_PROVIDER_BODY',{status:200});
 }
 if(request.method==='POST'&&url.pathname==='/api/events/')return new WorkerResponse(null,{status:202});
 if(request.method!=='GET')return new WorkerResponse('DENIED',{status:418});
 if(url.pathname==='/api/accounts/')return WorkerResponse.json({data:[{id:'ACCOUNT'}]});
 if(url.pathname==='/api/metrics/'){
  let next=null,data=[metric()];
  if(scenario.next){next=scenario.next;data=[];}
  if(scenario.twoPages){const second=url.searchParams.get('page[cursor]')==='SECOND';next=second?null:'https://a.klaviyo.com/api/metrics/?page[cursor]=SECOND';data=[metric(second?'SECOND':'METRIC')];}
  return WorkerResponse.json({data,links:{next}});
 }
 if(url.pathname==='/api/profiles/'||url.pathname==='/api/lists/LIST/profiles/')return WorkerResponse.json({data:[{id:'PROFILE',attributes:{email:'synthetic@example.invalid',subscriptions:{email:{marketing:{consent:'SUBSCRIBED',can_receive_email_marketing:true,suppression:[],list_suppressions:[],double_optin:true,consent_timestamp:'2026-10-24T15:01:00Z'}}}}}]});
 if(url.pathname==='/api/events/')return WorkerResponse.json({data:[normalized()],links:{next:null}});
 return new WorkerResponse('DENIED',{status:418});
}
describe('coupon bootstrap actual workerd transport',{skip:toolingReason},()=>{
 before(async context=>{
  context.diagnostic(`Local runtime versions: ${JSON.stringify(versions)}; outbound synthetic only`);
  temp=await mkdtemp(join(repo,'.bootstrap-workerd-'));
  const bundle=await build({stdin:{contents:wrapper,sourcefile:'synthetic-bootstrap.ts',resolveDir:repo},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
  const scriptPath=join(temp,'worker.mjs');await writeFile(scriptPath,bundle.outputFiles[0].contents);
  mf=new Miniflare(convertV4MiniflareOptions({cf:false,telemetry:{enabled:false},modules:true,scriptPath,compatibilityDate:'2026-10-06',outboundService:outbound}));await mf.ready;
 });
 beforeEach(()=>{calls=[];scenario={};});
 after(async()=>{await mf?.dispose();if(temp){const target=await realpath(temp),child=relative(await realpath(repo),target);assert.ok(child.startsWith('.bootstrap-workerd-')&&!child.includes(sep));await rm(target,{recursive:true,force:true});}});
 async function run(op){const r=await mf.dispatchFetch(ORIGIN+'/?op='+op);const body=await r.json();assert.doesNotMatch(JSON.stringify(body),/PRIVATE_SYNTHETIC_PROVIDER_BODY|pk_synthetic|key-trap/);return {r,body};}
 const operations=[['readAccount','/api/accounts/',READ,'GET',1],['eventAccount','/api/accounts/',EVENT,'GET',1],['profile','/api/profiles/',READ,'GET',1],['inventory','/api/metrics/',RECEIPT,'GET',2],['events','/api/events/',RECEIPT,'GET',1],['eventNormal','/api/events/',EVENT,'POST',1],['eventMarker','/api/events/',EVENT,'POST',1]];
 for(const [op,path,key,method,count]of operations){
  test(`${op}: actual transport success uses fixed host, method, key and revision`,async()=>{
   const {r,body}=await run(op);assert.equal(r.status,200);assert.equal(body.ok,true);assert.equal(calls.length,count);
   const last=calls.at(-1);assert.equal(new URL(last.url).origin,'https://a.klaviyo.com');assert.equal(last.path,path);assert.equal(last.method,method);assert.equal(last.authorization,'Klaviyo-API-Key '+key);assert.equal(last.revision,'2026-07-15');
   if(method==='POST'){assert.equal(body.status,202);assert.equal(last.body.data.attributes.unique_id,'30000000-0000-4000-8000-000000000001');assert.equal('bootstrap_event_unique_id'in last.body.data.attributes.properties,op==='eventMarker');}
   if(op==='events'){const query=new URL(last.url).searchParams;assert.equal(query.get('include'),'metric,profile');assert.equal(query.get('fields[metric]'),'id,name,integration');assert.equal(query.get('fields[profile]'),'id');assert.equal(query.get('page[size]'),'100');}
  });
  for(const status of [301,302,303,307,308])test(`${op}: ${status} never follows or forwards key`,async()=>{
   scenario={path,method,status};const {r,body}=await run(op);assert.equal(calls.length,count);assert.ok(calls.every(c=>new URL(c.url).origin==='https://a.klaviyo.com'));
   if(method==='POST'){assert.equal(r.status,200);assert.equal(body.status,status);assert.notEqual(body.status,202);}else assert.equal(r.status,503);
  });
  if(method==='POST')for(const status of [200,201,204,400,401,403,429,500])test(`${op}: HTTP ${status} is not accepted event status`,async()=>{scenario={path,method,status};const {r,body}=await run(op);assert.equal(r.status,200);assert.equal(body.status,status);assert.notEqual(body.status,202);assert.equal(calls.length,1);});
  if(method==='POST')test(`${op}: 202 provider body is not parsed or exposed`,async()=>{scenario={path,method,status:202};const {r,body}=await run(op);assert.equal(r.status,200);assert.equal(body.status,202);assert.equal(calls.length,1);});
  if(method==='GET')for(const status of [202,204,401,403,429,500])test(`${op}: GET HTTP ${status} is rejected`,async()=>{scenario={path,status};const {r}=await run(op);assert.equal(r.status,503);assert.equal(calls.length,count);});
  if(method==='GET')test(`${op}: malformed 200 rejected without provider text`,async()=>{scenario={path,malformed:true};assert.equal((await run(op)).r.status,503);});
 }
 for(const status of [301,302,303,307,308])test(`inventory receipt-account ${status} rejects before metrics`,async()=>{scenario={path:'/api/accounts/',status};assert.equal((await run('inventory')).r.status,503);assert.equal(calls.length,1);assert.equal(calls[0].authorization,'Klaviyo-API-Key '+RECEIPT);});
 test('same-origin paginated inventory follows exactly the validated cursor',async()=>{scenario={twoPages:true};assert.equal((await run('inventory')).r.status,200);assert.equal(calls.length,3);assert.equal(new URL(calls.at(-1).url).searchParams.get('page[cursor]'),'SECOND');});
 for(const next of ['https://credential-trap.invalid/api/metrics/?page[cursor]=X','https://a.klaviyo.com/api/events/?page[cursor]=X','https://a.klaviyo.com/api/metrics/?filter=evil','https://a.klaviyo.com/api/metrics/'])test(`inventory unsafe/loop next rejected before second fetch: ${next}`,async()=>{scenario={next};assert.equal((await run('inventory')).r.status,503);assert.equal(calls.length,2);});
 test('bad bootstrap marker rejected before any outbound',async()=>{assert.equal((await run('eventInvalid')).r.status,503);assert.equal(calls.length,0);});
 test('native readback accepts generated UUID, echoed $event_id and omitted null through actual verifier',async()=>{
  const r=await mf.dispatchFetch(ORIGIN+'/verify'),body=await r.json();assert.equal(body.result.code,'bootstrap_event_verified',JSON.stringify(body));assert.equal(body.result.activationReady,false);assert.equal(body.records,1);assert.ok(calls.every(c=>c.method==='GET'&&new URL(c.url).origin==='https://a.klaviyo.com'));
 });
 for(const normalized of ['wrong-id','missing-marker','unexpected'])test(`normalized readback ${normalized} cannot record event evidence`,async()=>{scenario={normalized};const body=await(await mf.dispatchFetch(ORIGIN+'/verify')).json();assert.notEqual(body.result.code,'bootstrap_event_verified');assert.equal(body.records,0);});
 for(const path of ['/disabled-bootstrap','/disabled-normal'])test(`actual internal route ${path} defaults closed with zero outbound`,async()=>{const r=await mf.dispatchFetch(ORIGIN+path);assert.equal(r.status,503);assert.equal(calls.length,0);});
 for(const body of ['utf8-limit','chunk-limit'])test(`actual provider GET ${body} rejects at streamed byte cap`,async()=>{scenario={path:'/api/profiles/',body};const result=await run('profile');assert.equal(result.r.status,503);assert.equal(result.body.reason,'bootstrap_read_limit');assert.equal(calls.length,1);});
 test('actual provider GET accepts a valid JSON body at exactly one million bytes',async()=>{scenario={path:'/api/profiles/',body:'exact-limit'};assert.equal((await run('profile')).r.status,200);assert.equal(calls.length,1);});
 test('shared provider aggregate four-million-byte budget blocks fifth GET',async()=>{scenario={path:'/api/accounts/',body:'aggregate'};const result=await run('aggregate');assert.equal(result.r.status,503);assert.equal(result.body.reason,'bootstrap_read_limit');assert.equal(calls.length,5);});
 test('actual bootstrapStore POST JSON has independent 128K streamed read cap',async()=>{const result=await run('rpcBudget');assert.equal(result.r.status,503);assert.equal(result.body.reason,'bootstrap_read_limit');assert.equal(calls.length,1);assert.equal(new URL(calls[0].url).origin,'https://abcdefghijklmnopqrst.supabase.co');});
 test('native bounded reader cancels a stalled stream at its deadline',async()=>{const result=await run('budgetStall');assert.equal(result.r.status,200);assert.equal(result.body.ok,true);assert.equal(result.body.cancelled,true);assert.equal(calls.length,0);});
 test('actual provider stalled GET fails within request/body deadline',async()=>{scenario={path:'/api/profiles/',body:'stall'};const start=Date.now();assert.equal((await run('profile')).r.status,503);assert.ok(Date.now()-start<9000);assert.equal(calls.length,1);});
 test('normal handler cannot receive a protocol port via HTTP JSON',async()=>{const r=await mf.dispatchFetch(ORIGIN+'/inject-normal');assert.equal(r.status,400);assert.equal(calls.length,0);});
});
