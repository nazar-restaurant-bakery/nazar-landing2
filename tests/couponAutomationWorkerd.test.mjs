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
const B='10000000-0000-4000-8000-000000000001',R='20000000-0000-4000-8000-000000000001',TOKEN='30000000-0000-4000-8000-000000000001',C='40000000-0000-4000-8000-000000000001',A='50000000-0000-4000-8000-000000000001';
const NOW=Date.parse('2026-10-26T22:00:00Z'),secret='synthetic_machine_secret_12345678901234567890',key='synthetic_process_key_12345678901234567890';
let mf,temp,calls=[],scenario={},state;
const wrapper=`
import {couponAutomationHandler} from './functions/_lib/couponAutomation.ts';
import {couponAutomationSignature} from './functions/_lib/couponAutomationAuth.ts';
const now=${NOW},secret='${secret}';
export default {async fetch(request){
 const u=new URL(request.url);let b={version:1,businessId:'${B}',runId:u.searchParams.get('run')||'${R}',issuedAt:now/1000};
 if(u.pathname==='/old')b.issuedAt-=61;if(u.pathname==='/future')b.issuedAt+=61;
 const sig=await couponAutomationSignature(b,secret);
 if(u.pathname==='/tampered')b.runId='60000000-0000-4000-8000-000000000001';
 if(u.pathname==='/other-business'){b.businessId='70000000-0000-4000-8000-000000000001';}
 const env={COUPON_AUTOMATION_ENABLED:u.pathname==='/disabled'?'false':'true',COUPON_AUTOMATION_BUSINESS_ID:'${B}',COUPON_AUTOMATION_ORIGIN:'https://site.synthetic.invalid',COUPON_AUTOMATION_SIGNING_SECRET:secret,COUPON_PROCESS_KEY:'${key}',SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic_only_123456'};
 if(u.pathname==='/bad-config')env.COUPON_AUTOMATION_ORIGIN='https://site.synthetic.invalid/redirect';
 const headers={'Content-Type':'application/json','X-Coupon-Automation-Signature':u.pathname==='/bad-signature'?'a'.repeat(64):u.pathname==='/other-business'?await couponAutomationSignature(b,secret):sig};if(u.pathname==='/origin')headers.Origin='https://browser.synthetic.invalid';
 return couponAutomationHandler(fetch,()=>now)(new Request('https://edge.synthetic.invalid/',{method:'POST',headers,body:JSON.stringify(b)}),env);
}};`;
async function outbound(request){
 const u=new URL(request.url),b=await request.json();calls.push({origin:u.origin,path:u.pathname,method:request.method,body:b,auth:request.headers.get('Authorization')});
 if(u.origin==='https://abcdefghijklmnopqrst.supabase.co'&&request.method==='POST'){
  const op=u.pathname.split('/').at(-1);assert.equal(request.headers.get('apikey'),'sb_secret_synthetic_only_123456');
  if(op==='coupon_automation_start_v1'){
   if(scenario.startStatus)return new WorkerResponse('PRIVATE_SYNTHETIC_ERROR',{status:scenario.startStatus});
   if(state.runs.has(b.p_run_id))return WorkerResponse.json({allowed:false,code:'replay'});
   if(state.active)return WorkerResponse.json({allowed:false,code:'busy'});state.runs.add(b.p_run_id);state.active=true;
   return WorkerResponse.json({allowed:true,code:'claimed',runToken:TOKEN,dispatchLimit:1,receiptLimit:scenario.receipt?1:0,expiresAt:scenario.badExpiry?'bad':new Date(NOW+180000).toISOString()});
  }
  assert.equal(b.p_run_token,TOKEN);assert.equal(b.p_business_id,B);
  if(op==='coupon_automation_next_v1'){
   if(scenario.paused)return WorkerResponse.json({allowed:false,code:'paused'});
   if(b.p_kind==='receipt'){
    if(!scenario.receipt||state.poll)return WorkerResponse.json({allowed:false,code:'queue_empty'});state.poll=true;return WorkerResponse.json({allowed:true,code:'poll_recorded',attemptId:A,couponId:C});
   }
   if(state.attempt)return WorkerResponse.json({allowed:false,code:'queue_empty'});state.attempt=true;
   if(scenario.markerLost)return new WorkerResponse('PRIVATE_MARKER_RESPONSE_LOST',{status:503});
   return WorkerResponse.json({allowed:true,code:'attempt_recorded',attemptId:A,couponId:C});
  }
  if(op==='coupon_automation_record_v1'){state.records.push(b);if(scenario.recordLost)return new WorkerResponse('PRIVATE_RECORD_RESPONSE',{status:503});return WorkerResponse.json({acknowledged:true});}
  if(op==='coupon_automation_finish_v1'){state.finishes++;state.active=false;if(scenario.finishLost)return new WorkerResponse('PRIVATE_FINISH_RESPONSE',{status:503});return WorkerResponse.json({acknowledged:true});}
  return new WorkerResponse('UNEXPECTED_RPC',{status:418});
 }
 if(u.origin==='https://site.synthetic.invalid'&&u.pathname==='/api/internal/coupon-welcome'&&request.method==='POST'){
  assert.equal(request.headers.get('Authorization'),'Bearer '+key);assert.deepEqual(Object.keys(b).sort(),['action','businessId','couponId']);assert.equal(b.businessId,B);assert.equal(b.couponId,C);
  if(b.action==='welcome'){assert.equal(state.attempt,true);state.dispatches++;}
  else{assert.equal(b.action,'reconcile');assert.equal(state.poll,true);state.reads++;}
  if(scenario.machineStatus)return new WorkerResponse('PRIVATE_MACHINE_BODY',{status:scenario.machineStatus,headers:{Location:'https://credential-trap.invalid/'}});
  if(scenario.large)return new WorkerResponse('x'.repeat(16001));
  if(scenario.malformed)return new WorkerResponse('PRIVATE_MALFORMED');
  const result=b.action==='welcome'?{status:'provider_accepted',code:'pending_delivery_receipt_reconciliation',synthetic:false,activationReady:false}:{status:scenario.pending?'pending':'delivered',code:scenario.pending?'delivery_receipt_waiting':'delivery_confirmed',synthetic:false,activationReady:!scenario.pending};
  if(scenario.synthetic)result.synthetic=true;return WorkerResponse.json(result);
 }
 // No proxy/fallback. Any provider, bootstrap, profile, subscription or arbitrary host is denied.
 return new WorkerResponse('OUTBOUND_DENIED',{status:418});
}
describe('default-off normal consumer native workerd',{skip:toolingReason},()=>{
 before(async c=>{c.diagnostic(`Native ${JSON.stringify(versions)}; all outbound synthetic`);temp=await mkdtemp(join(repo,'.automation-workerd-'));const bundle=await build({stdin:{contents:wrapper,sourcefile:'synthetic-consumer.ts',resolveDir:repo},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});const scriptPath=join(temp,'worker.mjs');await writeFile(scriptPath,bundle.outputFiles[0].contents);mf=new Miniflare(convertV4MiniflareOptions({cf:false,telemetry:{enabled:false},modules:true,scriptPath,compatibilityDate:'2026-10-06',outboundService:outbound}));await mf.ready;});
 beforeEach(()=>{calls=[];scenario={};state={runs:new Set(),active:false,attempt:false,poll:false,records:[],finishes:0,dispatches:0,reads:0};});
 after(async()=>{await mf?.dispose();if(temp){const target=await realpath(temp),child=relative(await realpath(repo),target);assert.ok(child.startsWith('.automation-workerd-')&&!child.includes(sep));await rm(target,{recursive:true,force:true});}});
 async function run(path='/run'){const r=await mf.dispatchFetch('https://consumer.synthetic.invalid'+path);return {r,body:await r.json()};}
 test('default off makes zero DB/machine requests',async()=>{const {r,body}=await run('/disabled');assert.equal(r.status,503);assert.equal(body.code,'automation_disabled');assert.equal(calls.length,0);});
 for(const path of ['/tampered','/old','/future','/other-business','/origin','/bad-signature'])test(path+' fails before any outbound',async()=>{const {r}=await run(path);assert.equal(r.status,403);assert.equal(calls.length,0);});
 test('untrusted configured path rejected before DB',async()=>{const {r}=await run('/bad-config');assert.equal(r.status,503);assert.equal(calls.length,0);});
 test('one durable marker -> one exact welcome, safe counts only',async()=>{const {r,body}=await run();assert.equal(r.status,200);assert.equal(body.accepted,1);assert.equal(state.dispatches,1);assert.equal(state.finishes,1);assert.equal(state.records[0].p_outcome,'provider_accepted');assert.doesNotMatch(JSON.stringify(body),/synthetic_process|sb_secret|PROFILE|PRIVATE|runToken|couponId/);});
 test('same run replay and next run after response uncertainty cannot dispatch same coupon',async()=>{scenario={machineStatus:503};await run();await run();await run('/run?run=80000000-0000-4000-8000-000000000001');assert.equal(state.dispatches,1);assert.equal(state.records[0].p_outcome,'unknown');});
 test('marker response lost prevents machine; future run cannot reuse marked coupon',async()=>{scenario={markerLost:true};const {r}=await run();assert.equal(r.status,503);assert.equal(state.dispatches,0);scenario={};await run('/run?run=80000000-0000-4000-8000-000000000001');assert.equal(state.dispatches,0);});
 test('receipt uses same bounded machine path, no sender/profile/event payload',async()=>{scenario={receipt:true};const {body}=await run();assert.equal(body.delivered,1);assert.equal(body.accepted,1);assert.equal(state.reads,1);assert.equal(state.dispatches,1);assert.ok(calls.every(c=>!c.path.includes('bootstrap')&&!c.path.includes('/api/events')&&!c.path.includes('subscriptions')));});
 test('pending receipt does not become delivered or trigger resend',async()=>{scenario={receipt:true,pending:true};const {body}=await run();assert.equal(body.pending,1);assert.equal(body.delivered,0);assert.equal(state.reads,1);assert.equal(state.records[0].p_outcome,'pending');});
 for(const machineStatus of [301,302,307,403,429,500,503])test('machine '+machineStatus+' never follows/retries or exposes body',async()=>{scenario={machineStatus};const {body}=await run();assert.equal(state.dispatches,1);assert.equal(body.unconfirmed,1);assert.equal(state.records[0].p_outcome,'unknown');assert.ok(calls.every(c=>c.origin!=='https://credential-trap.invalid'));assert.doesNotMatch(JSON.stringify(body),/PRIVATE|synthetic_process/);});
 for(const option of ['large','malformed','synthetic'])test(option+' machine response remains unconfirmed without retry',async()=>{scenario={[option]:true};const {body}=await run();assert.equal(body.unconfirmed,1);assert.equal(state.dispatches,1);});
 test('record acknowledgement loss never repeats machine HTTP',async()=>{scenario={recordLost:true};const {r}=await run();assert.equal(r.status,503);assert.equal(state.dispatches,1);assert.equal(state.finishes,1);});
 test('finish acknowledgement loss is not automatically retried',async()=>{scenario={finishLost:true};const {r}=await run();assert.equal(r.status,503);assert.equal(state.finishes,1);assert.equal(state.dispatches,1);});
 test('paused lease produces no machine call',async()=>{scenario={paused:true};const {r,body}=await run();assert.equal(r.status,200);assert.equal(body.accepted,0);assert.equal(state.dispatches,0);});
 test('malformed run expiry stops before next or machine',async()=>{scenario={badExpiry:true};const {r}=await run();assert.equal(r.status,503);assert.equal(state.dispatches,0);});
 test('concurrent ticks still produce only one durable dispatch',async()=>{await Promise.all([run(),run('/run?run=80000000-0000-4000-8000-000000000001')]);assert.equal(state.dispatches,1);});
});
