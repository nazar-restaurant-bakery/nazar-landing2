/** Actual receipt adapter in workerd; all outbound terminates in a synthetic
 * interceptor. No real provider, hosted DB, event or email. Tooling is optional
 * and already installed; NODE_PATH can point to Wrangler's modules. */
import assert from 'node:assert/strict';
import {after,before,beforeEach,describe,test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
let Miniflare,WorkerResponse,convertV4MiniflareOptions,build,toolingReason=false;
const versions={};
try {
 ({Miniflare,Response:WorkerResponse,convertV4MiniflareOptions}=require('miniflare'));
 versions.miniflare=require('miniflare/package.json').version;
 versions.workerd=createRequire(require.resolve('miniflare/package.json'))('workerd/package.json').version;
 let esbuild;try{esbuild=require('esbuild');}catch{esbuild=createRequire(require.resolve('wrangler/package.json'))('esbuild');}
 build=esbuild.build;versions.esbuild=esbuild.version;
 if(!versions.miniflare.startsWith('5.')||!versions.workerd.startsWith('1.')||typeof convertV4MiniflareOptions!=='function')toolingReason='Requires Miniflare 5/workerd 1 converter API';
}catch{toolingReason='Optional Miniflare 5/workerd 1/esbuild unavailable; native suite not executed';}
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
let mf,temp,calls=[],scenario={},records=[];
const wrapper=`
import {liveReceiptProvider,reconcileCouponDelivery} from './functions/_lib/couponDelivery.ts';
const businessId='10000000-0000-4000-8000-000000000001',couponId='20000000-0000-4000-8000-000000000001';
const bindingId='30000000-0000-4000-8000-000000000001';
export default {async fetch(request){
 const url=new URL(request.url),records=[];
 const provider=liveReceiptProvider('pk_synthetic_read_12345');
 if(url.pathname==='/legacy-probe'){
  try{await fetch('https://a.klaviyo.com/api/accounts/',{redirect:'error'});return Response.json({rejected:false});}
  catch(e){return Response.json({rejected:true,name:e.name});}
 }
 if(url.pathname==='/direct'){
  try{return Response.json({data:await provider.get(url.searchParams.get('path')||'/accounts')});}
  catch(e){return Response.json({code:e.message},{status:503});}
 }
 const store={async rpc(name,args){
  if(name==='coupon_delivery_context_v1')return {businessId,bindingId,accountId:'ACCOUNT',profileId:'PROFILE',flowId:'FLOW',messageId:'MESSAGE',metricId:'METRIC',dispatchedAt:'2026-10-21T16:00:00Z',activationAllowed:url.searchParams.get('gate')!=='closed'};
  if(name!=='coupon_delivery_record_v1')throw Error('unexpected synthetic RPC');
  records.push(args);return {acknowledged:true,code:'delivery_confirmed',deliveredAt:args.p_delivered_at};
 }};
 const result=await reconcileCouponDelivery({store,provider,businessId,couponId,accountId:'ACCOUNT',now:()=>Date.parse('2026-10-21T17:00:00Z')});
 return Response.json({result,records});
}};`;
async function outbound(request){
 const url=new URL(request.url);
 calls.push({origin:url.origin,path:url.pathname,method:request.method,query:Object.fromEntries(url.searchParams),authorization:request.headers.get('authorization'),revision:request.headers.get('revision')});
 // No proxy/fetch fallback: even an unexpected host cannot reach the internet.
 if(url.origin!=='https://a.klaviyo.com'||request.method!=='GET')return new WorkerResponse('DENIED',{status:418});
 if(scenario.path===url.pathname){
  if(scenario.status)return new WorkerResponse('PRIVATE_SYNTHETIC_BODY',{status:scenario.status,headers:{Location:scenario.location||'https://credential-trap.invalid/private'}});
  if(scenario.malformed)return new WorkerResponse('PRIVATE_SYNTHETIC_BODY',{status:200});
 }
 if(url.pathname==='/api/accounts/')return WorkerResponse.json({data:[{id:'ACCOUNT'}]});
 if(url.pathname==='/api/metrics/METRIC/')return WorkerResponse.json({data:{id:'METRIC',attributes:{name:'Received Email',integration:{name:'Klaviyo',category:'Internal'}}}});
 if(url.pathname==='/api/events/' && (url.searchParams.has('include')||url.searchParams.has('fields[profile]')||url.searchParams.has('fields[metric]')))return new WorkerResponse('SYNTHETIC_SCOPE_MISSING_PROFILES_READ',{status:403});
 if(url.pathname==='/api/events/' && url.searchParams.get('filter')!=='and(equals(metric_id,"METRIC"),equals(profile_id,"PROFILE"),greater-or-equal(datetime,2026-10-21T16:00:00.000Z))')return new WorkerResponse('SYNTHETIC_FILTER_REJECTED',{status:400});
 if(url.pathname==='/api/events/')return WorkerResponse.json({data:[{id:'EVENT',attributes:{datetime:'2026-10-21T16:01:00Z',event_properties:{$flow:'FLOW',$message:scenario.wrongMessage?'OTHER':'MESSAGE'}},...(scenario.missingRelationships?{}:{relationships:{profile:{data:{id:'PROFILE'}},metric:{data:{id:'METRIC'}}}})}],links:{next:null}});
 return new WorkerResponse('DENIED',{status:418});
}
describe('coupon receipt native workerd regression',{skip:toolingReason},()=>{
 before(async context=>{
  context.diagnostic(`Local runtime versions: ${JSON.stringify(versions)}; all outbound intercepted`);
  temp=await mkdtemp(join(repo,'.receipt-workerd-'));
  const bundle=await build({stdin:{contents:wrapper,sourcefile:'synthetic-receipt.ts',resolveDir:repo},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
  const scriptPath=join(temp,'worker.mjs');await writeFile(scriptPath,bundle.outputFiles[0].contents);
  mf=new Miniflare(convertV4MiniflareOptions({cf:false,telemetry:{enabled:false},modules:true,scriptPath,compatibilityDate:'2026-10-06',outboundService:outbound}));await mf.ready;
 });
 beforeEach(()=>{calls=[];scenario={};records=[];});
 after(async()=>{await mf?.dispose();if(temp){const target=await realpath(temp),child=relative(await realpath(repo),target);assert.ok(child.startsWith('.receipt-workerd-')&&!child.includes(sep));await rm(target,{recursive:true,force:true});}});
 async function run(path='/reconcile'){
  const response=await mf.dispatchFetch('https://receipt.synthetic.invalid'+path),body=await response.json();records=body.records||[];return {response,body};
 }
 test('legacy redirect:error rejects before outbound in actual workerd',async()=>{
  const {body}=await run('/legacy-probe');assert.equal(body.rejected,true);assert.equal(body.name,'TypeError');assert.equal(calls.length,0);
 });
 test('200 receipt GET works and exact native match records only safe evidence',async()=>{
  const {body}=await run();assert.equal(body.result.status,'delivered');assert.equal(body.result.activationReady,true);assert.equal(records.length,1);
  assert.equal(calls.length,3);assert.ok(calls.every(c=>c.method==='GET'&&c.origin==='https://a.klaviyo.com'&&c.revision==='2026-07-15'&&c.authorization==='Klaviyo-API-Key pk_synthetic_read_12345'));
  const eventCall=calls.find(c=>c.path==='/api/events/');assert.deepEqual(Object.keys(eventCall.query).sort(),['fields[event]','filter','page[size]']);
  assert.match(records[0].p_evidence_sha256,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(body),/pk_synthetic|PRIVATE_SYNTHETIC_BODY|Subject/);
 });
 for(const [path,count] of [['/api/accounts/',1],['/api/metrics/METRIC/',2],['/api/events/',3]])for(const status of [301,302,303,307,308])test(`${path} ${status} cannot redirect credentials or confirm delivery`,async()=>{
  scenario={path,status};const {body}=await run();assert.equal(body.result.status,'pending');assert.equal(body.result.code,'delivery_reconciliation_unconfirmed');assert.equal(body.result.activationReady,false);assert.equal(records.length,0);assert.equal(calls.length,count);assert.ok(calls.every(c=>c.origin==='https://a.klaviyo.com'));assert.doesNotMatch(JSON.stringify(body),/PRIVATE_SYNTHETIC_BODY|credential-trap|pk_synthetic/);
 });
 for(const location of ['/api/events/','https://a.klaviyo.com/api/events/'])test(`same-host/relative redirect is not followed: ${location}`,async()=>{
  scenario={path:'/api/accounts/',status:302,location};const {body}=await run();assert.equal(body.result.activationReady,false);assert.equal(records.length,0);assert.equal(calls.length,1);
 });
 for(const status of [202,400,401,403,429,500])test(`HTTP ${status} is not receipt evidence`,async()=>{
  scenario={path:'/api/events/',status};const {body}=await run();assert.equal(body.result.status,'pending');assert.equal(body.result.activationReady,false);assert.equal(records.length,0);assert.equal(calls.length,3);
 });
 test('malformed 200 cannot confirm or record a receipt',async()=>{
  scenario={path:'/api/events/',malformed:true};const {body}=await run();assert.equal(body.result.status,'pending');assert.equal(records.length,0);assert.equal(body.result.activationReady,false);assert.doesNotMatch(JSON.stringify(body),/PRIVATE_SYNTHETIC_BODY/);
 });
 test('optional absent relationship linkage never records delivery',async()=>{scenario={missingRelationships:true};const {body}=await run();assert.equal(body.result.status,'pending');assert.equal(body.result.code,'delivery_receipt_waiting');assert.equal(records.length,0);assert.equal(calls.length,3);});
 test('wrong native message and closed local activation gate remain enforced',async()=>{
  scenario={wrongMessage:true};let {body}=await run();assert.equal(body.result.status,'pending');assert.equal(records.length,0);
  scenario={};({body}=await run('/reconcile?gate=closed'));assert.equal(body.result.status,'delivered');assert.equal(body.result.activationReady,false);
 });
 for(const path of ['/profiles','/events/../accounts','https://credential-trap.invalid/'])test(`invalid receipt path denied without outbound: ${path}`,async()=>{
  const {response}=await run('/direct?path='+encodeURIComponent(path));assert.equal(response.status,503);assert.equal(calls.length,0);
 });
});
