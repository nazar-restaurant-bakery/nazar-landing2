/** Actual receipt adapter in workerd; all outbound terminates in a synthetic
 * interceptor. No real provider, hosted DB, event or email. Tooling is optional
 * and already installed; NODE_PATH can point to Wrangler's modules. */
import assert from 'node:assert/strict';
import {after,before,beforeEach,describe,test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PRODUCTION_BUSINESS_ID,PRODUCTION_SUPABASE_URL} from '../src/lib/deploymentEnvironment.ts';
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
let mf,temp,calls=[],scenario={};
const permitId='40000000-0000-4000-8000-000000000001',couponId='20000000-0000-4000-8000-000000000001',bindingId='30000000-0000-4000-8000-000000000001';
const key='synthetic_process_key_12345678901234567890';
const wrapper=`
import {onRequest} from './functions/api/internal/coupon-bootstrap.ts';
export default {async fetch(request){
 const env={SUPABASE_SECRET_KEY:'sb_secret_synthetic_no_network',COUPON_BOOTSTRAP_ENABLED:'true',COUPON_BOOTSTRAP_MODE:'live',COUPON_PROCESS_KEY:'${key}',COUPON_KLAVIYO_ACCOUNT_ID:'ACCOUNT',COUPON_KLAVIYO_READ_KEY:'pk_synthetic_read_123456',COUPON_KLAVIYO_EVENT_KEY:'pk_synthetic_event_123456',COUPON_KLAVIYO_RECEIPT_KEY:'pk_synthetic_receipt_123456',COUPON_QR_ORIGIN:'https://www.nazarrestaurantandbakery.com',COUPON_LIVE_APPROVAL_ID:'synthetic-approval'};
 // Normal COUPON_PROCESS_ENABLED/MODE deliberately absent.
 return onRequest({request,env});
}};`;
async function outbound(request){
 const u=new URL(request.url),name=u.pathname.split('/').at(-1);calls.push({origin:u.origin,path:u.pathname,method:request.method});
 if(u.origin===PRODUCTION_SUPABASE_URL&&u.pathname.startsWith('/rest/v1/rpc/')&&request.method==='POST'){
  const a=await request.json();
  if(name==='coupon_bootstrap_preview_v1'){assert.deepEqual(a,{p_permit_id:permitId,p_receipt_only:true});return WorkerResponse.json({allowed:true,permitId,businessId:PRODUCTION_BUSINESS_ID,accountId:'ACCOUNT',couponId,state:scenario.state||'bound'});}
  if(name==='coupon_delivery_context_v1'){assert.deepEqual(a,{p_business_id:PRODUCTION_BUSINESS_ID,p_coupon_id:couponId});return WorkerResponse.json({businessId:PRODUCTION_BUSINESS_ID,bindingId,accountId:'ACCOUNT',profileId:'PROFILE',flowId:'FLOW',messageId:'MESSAGE',metricId:'METRIC',dispatchedAt:'2026-10-21T16:00:00Z',activationAllowed:true});}
  if(name==='coupon_delivery_record_v1'){assert.equal(a.p_binding_id,bindingId);assert.match(a.p_evidence_sha256,/^[a-f0-9]{64}$/);return WorkerResponse.json({acknowledged:!scenario.receiptAckMissing,code:'delivery_confirmed',deliveredAt:a.p_delivered_at});}
  if(name==='coupon_bootstrap_record_delivery_v1'){assert.deepEqual(a,{p_permit_id:permitId});return WorkerResponse.json({acknowledged:!scenario.permitAckMissing});}
  // No fallback: dispatch/claim/permit/record-event/negative/send RPC forbidden.
  return new WorkerResponse('SYNTHETIC_UNEXPECTED_RPC',{status:418});
 }
 if(u.origin!=='https://a.klaviyo.com'||request.method!=='GET')return new WorkerResponse('SYNTHETIC_OUTBOUND_DENIED',{status:418});
 if(u.pathname==='/api/accounts/')return WorkerResponse.json({data:[{id:'ACCOUNT'}]});
 if(u.pathname==='/api/metrics/METRIC/')return WorkerResponse.json({data:{id:'METRIC',attributes:{name:'Received Email',integration:{name:'Klaviyo',category:'Internal'}}}});
 if(u.pathname==='/api/events/'){
  if(u.searchParams.has('include')||u.searchParams.has('fields[profile]')||u.searchParams.has('fields[metric]'))return new WorkerResponse('SYNTHETIC_NO_PROFILES_READ',{status:403});
  assert.deepEqual([...u.searchParams.keys()].sort(),['fields[event]','filter','page[size]']);
  if(scenario.eventStatus)return new WorkerResponse('SYNTHETIC_PROVIDER_FAILURE',{status:scenario.eventStatus});
  const e={id:'EVENT',attributes:{datetime:'2026-10-21T16:01:00Z',event_properties:{$flow:'FLOW',$message:'MESSAGE'}},relationships:{profile:{data:{id:'PROFILE'}},metric:{data:{id:'METRIC'}}}};
  if(scenario.missingLink)delete e.relationships;
  return WorkerResponse.json({data:[e],links:{next:null}});
 }
 return new WorkerResponse('SYNTHETIC_OUTBOUND_DENIED',{status:418});
}
describe('actual bootstrap receipt-only route in native workerd',{skip:toolingReason},()=>{
 before(async context=>{
  context.diagnostic(`Runtime ${JSON.stringify(versions)}; all outbound synthetic; no normal processing flags`);
  temp=await mkdtemp(join(repo,'.receipt-route-workerd-'));
  const bundle=await build({stdin:{contents:wrapper,sourcefile:'synthetic-bootstrap-receipt.ts',resolveDir:repo},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
  const scriptPath=join(temp,'worker.mjs');await writeFile(scriptPath,bundle.outputFiles[0].contents);
  mf=new Miniflare(convertV4MiniflareOptions({cf:false,telemetry:{enabled:false},modules:true,scriptPath,compatibilityDate:'2026-10-06',outboundService:outbound}));await mf.ready;
 });
 beforeEach(()=>{calls=[];scenario={};});
 after(async()=>{await mf?.dispose();if(temp){const target=await realpath(temp),child=relative(await realpath(repo),target);assert.ok(child.startsWith('.receipt-route-workerd-')&&!child.includes(sep));await rm(target,{recursive:true,force:true});}});
 async function run(){const r=await mf.dispatchFetch('https://www.nazarrestaurantandbakery.com/api/internal/coupon-bootstrap',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify({action:'reconcile',permitId})});return {r,body:await r.json()};}
 test('normal processing disabled: only native GET evidence and two receipt acknowledgements',async()=>{
  const {r,body}=await run();assert.equal(r.status,200);assert.equal(body.status,'delivered');assert.equal(body.synthetic,false);assert.equal(body.activationReady,false);
  assert.deepEqual(calls.filter(c=>c.origin===PRODUCTION_SUPABASE_URL).map(c=>c.path.split('/').at(-1)),['coupon_bootstrap_preview_v1','coupon_delivery_context_v1','coupon_delivery_record_v1','coupon_bootstrap_record_delivery_v1']);
  const provider=calls.filter(c=>c.origin==='https://a.klaviyo.com');assert.equal(provider.length,3);assert.ok(provider.every(c=>c.method==='GET'));
 });
 test('unbound preview rejects before any provider or receipt write',async()=>{scenario={state:'event_verified'};const {r,body}=await run();assert.equal(r.status,409);assert.equal(body.code,'bootstrap_not_bound');assert.equal(calls.length,1);});
 test('missing primary linkage stays pending and cannot acknowledge bootstrap delivery',async()=>{scenario={missingLink:true};const {r,body}=await run();assert.equal(r.status,200);assert.equal(body.status,'pending');assert.ok(!calls.some(c=>c.path.endsWith('coupon_delivery_record_v1')||c.path.endsWith('coupon_bootstrap_record_delivery_v1')));});
 for(const eventStatus of [403,429,500])test(`provider ${eventStatus} records no delivery and never sends`,async()=>{scenario={eventStatus};const {body}=await run();assert.equal(body.status,'pending');assert.ok(!calls.some(c=>c.path.endsWith('coupon_delivery_record_v1')||c.path.endsWith('coupon_bootstrap_record_delivery_v1')));assert.ok(calls.filter(c=>c.origin==='https://a.klaviyo.com').every(c=>c.method==='GET'));});
 test('lost receipt acknowledgement never marks bootstrap delivered',async()=>{scenario={receiptAckMissing:true};const {body}=await run();assert.equal(body.code,'delivery_record_unconfirmed');assert.ok(!calls.some(c=>c.path.endsWith('coupon_bootstrap_record_delivery_v1')));});
 test('lost bootstrap delivery acknowledgement is unknown, not success',async()=>{scenario={permitAckMissing:true};const {r,body}=await run();assert.equal(r.status,503);assert.equal(body.code,'bootstrap_delivery_record_unconfirmed');assert.equal(body.activationReady,false);});
});
