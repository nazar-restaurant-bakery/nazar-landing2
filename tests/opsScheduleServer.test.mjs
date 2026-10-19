import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest} from '../supabase/functions/ops-collect/index.ts';
import {allowedOrigin,NAZAR_PROJECT} from '../supabase/functions/ops-collect/contracts.ts';
import {collect as scheduler} from '../supabase/functions/ops-collect/scheduler.ts';

const secret='a'.repeat(64), runKey='22222222-2222-4222-8222-222222222222';
const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret))),byte=>byte.toString(16).padStart(2,'0')).join('');
const env={SUPABASE_ANON_KEY:'SYNTHETIC_ANON',SUPABASE_SERVICE_ROLE_KEY:'SYNTHETIC_SERVICE',OPS_SCHEDULE_SECRET:secret};
function harness(options={}){
 const calls=[],finishes=[];
 const send=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
 const request=async(url,init={})=>{
  const parsed=new URL(url),name=parsed.pathname.split('/').at(-1),body=init.body?JSON.parse(init.body):{};calls.push({name,host:parsed.hostname,body});
  if(parsed.origin===NAZAR_PROJECT){
   if(name==='ops_enqueue_scheduled_collect')return send(options.busy?null:{id:'11111111-1111-4111-8111-111111111111',request_key:body.p_run_key,action:options.wrongAction?'offer_set_active':'collect',requested_by:null,actor_kind:'scheduler',requested_at:new Date().toISOString(),payload:{},claim_token:'33333333-3333-4333-8333-333333333333'});
   if(name==='ops_internal_snapshot_v')return send({metrics:[],previous:[],scheduler:{runs_24h:0,failed_24h:0},capabilities:['collect']});
   if(name==='ops_schedule_status_v')return options.missingSchedule?new Response('{"code":"PGRST202"}',{status:404}):send({enabled:true,active:true,verified:options.verified===true,secret_sha256:fingerprint,runs_24h:2,failed_24h:1,last_failure_name:'collect',last_failure_at:'2026-10-19T10:00:00Z'});
   if(name==='ops_reserve_external_request')return send(options.budget!==false);
   if(name==='ops_finish_action'){finishes.push(body);return send(true);}
   throw new Error('Unexpected RPC '+name);
  }
  if(parsed.href==='https://www.nazarrestaurantandbakery.com/')return new Response('SYNTHETIC SITE',{status:200});
  throw new Error('Unexpected provider');
 };
 const invoke=(body={scheduledCollect:true,runKey},headers={},runtimeEnv=env)=>handleRequest(new Request(NAZAR_PROJECT+'/functions/v1/ops-collect',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+'b'.repeat(32),'x-nazar-ops-schedule-secret':secret,...headers},body:JSON.stringify(body)}),runtimeEnv,request);
 return{calls,finishes,invoke};
}
test('scheduler secret authorizes one collect-only service receipt without a human staff identity',async()=>{
 const h=harness();const response=await h.invoke();assert.equal(response.status,202);const body=await response.json();assert.equal(body.action.actor_kind,'scheduler');assert.equal(body.action.requested_by,null);assert.equal(body.action.request_key,runKey);
 assert.equal(h.calls.filter(c=>c.name==='ops_enqueue_scheduled_collect').length,1);assert.equal(h.finishes.length,1);assert.equal(h.finishes[0].p_status,'done');
 assert.equal(h.calls.some(c=>/user|crm_staff_authorized|ops_request_action|ops_claim_action/.test(c.name)),false);
 assert.equal(h.calls.filter(c=>c.name==='ops_reserve_external_request').length,1);assert.equal(h.calls.filter(c=>c.host==='www.nazarrestaurantandbakery.com').length,1);
 assert.equal(JSON.stringify(body).includes(secret),false);assert.equal('claim_token'in body.action,false);
});
test('missing, malformed or incorrect scheduler credentials and browser Origins perform zero RPCs',async()=>{
 for(const [headers,runtimeEnv] of [[{'x-nazar-ops-schedule-secret':''},env],[{'x-nazar-ops-schedule-secret':'c'.repeat(64)},env],[{'x-nazar-ops-schedule-secret':'short'},env],[{Origin:'https://www.nazarrestaurantandbakery.com'},env],[{}, {...env,OPS_SCHEDULE_SECRET:undefined}],[{}, {...env,OPS_SCHEDULE_SECRET:'short'}],[{}, {...env,SUPABASE_URL:'https://wrong-project.example'}]]){
  const h=harness();const response=await h.invoke(undefined,headers,runtimeEnv);assert.ok([403,503].includes(response.status));assert.equal(h.calls.length,0);assert.equal((await response.text()).includes(secret),false);
 }
 const h=harness();const response=await handleRequest(new Request(NAZAR_PROJECT+'/functions/v1/ops-collect',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+'b'.repeat(32)},body:JSON.stringify({scheduledCollect:true,runKey})}),env,async()=>{throw new Error('must not fetch');});assert.equal(response.status,403);assert.equal(h.calls.length,0);
});
test('scheduler credential cannot resume a staff action or request CSV, offer, ads, product or reports',async()=>{
 for(const action of ['collect','sync_clover_csv','retry_failed_job','offer_set_active','ads_set_status','product_set_channel','commission_report']){
  const h=harness();assert.equal((await h.invoke({action,payload:{clientRequestId:runKey}})).status,403);assert.equal(h.calls.length,0);
 }
 for(const body of [{actionId:runKey},{scheduledCollect:true,runKey,action:'offer_set_active'},{scheduledCollect:true,runKey,requested_by:runKey},{scheduledCollect:true,runKey:'invalid'}]){
  const h=harness();assert.ok([400,403].includes((await h.invoke(body)).status));assert.equal(h.calls.length,0);
 }
});
test('replayed or overlapping scheduled collection is skipped without work, and the shared cap still applies',async()=>{
 const busy=harness({busy:true});const response=await busy.invoke();assert.equal((await response.json()).code,'scheduled_skipped');assert.equal(busy.calls.length,1);assert.equal(busy.finishes.length,0);
 const cap=harness({budget:false});await cap.invoke();assert.equal(cap.calls.some(c=>c.host==='www.nazarrestaurantandbakery.com'),false);assert.equal(cap.finishes[0].p_status,'failed');assert.equal(cap.finishes[0].p_result.requestsUsed,0);
 const invalid=harness({wrongAction:true});assert.equal((await invalid.invoke()).status,503);assert.equal(invalid.finishes.length,0);assert.equal(invalid.calls.length,1);
});
test('installed SQL or HTTP dispatch alone is not a connected scheduler; terminal snapshot proof is required',async()=>{
 for(const options of [{},{missingSchedule:true}]){const h=harness(options);await h.invoke();assert.equal(h.finishes[0].p_connections.find(c=>c.source==='scheduler').status,'not_connected');}
 const h=harness({verified:true});await h.invoke();assert.equal(h.finishes[0].p_connections.find(c=>c.source==='scheduler').status,'connected');assert.equal(h.finishes[0].p_metrics.find(m=>m.source==='scheduler'&&m.metric==='runs_24h').value_num,2);
 const evidence={enabled:true,active:true,verified:true,secret_sha256:fingerprint,runs_24h:1,failed_24h:0,last_failure_name:null,last_failure_at:null};
 for(const proof of [{...evidence,enabled:false},{...evidence,active:false},{...evidence,verified:false},{...evidence,runs_24h:NaN},{...evidence,secret_sha256:null},{...evidence,secret_sha256:'b'.repeat(64)}])assert.equal((await scheduler({env},proof)).status,'not_connected');
 assert.equal((await scheduler({env:{}},evidence)).status,'not_connected');
 assert.equal((await scheduler({env:{OPS_SCHEDULE_SECRET:'b'.repeat(64)}},evidence)).status,'not_connected');
});
test('only the actual Nazar Pages project and its previews are permitted for manual CORS',()=>{
 for(const origin of ['https://nazar-restaurant-website.pages.dev','https://7bd49ea3.nazar-restaurant-website.pages.dev','https://feat-staff-ops-panel.nazar-restaurant-website.pages.dev'])assert.equal(allowedOrigin(origin,{}),true);
 for(const origin of ['https://nazar-landing2.pages.dev','https://x.nazar-restaurant-website.pages.dev.evil.example','https://other-project.pages.dev'])assert.equal(allowedOrigin(origin,{}),false);
});
