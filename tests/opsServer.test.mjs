import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest} from '../supabase/functions/ops-collect/index.ts';
import {createCommissionPdf} from '../supabase/functions/ops-collect/commission_report.ts';
import {NAZAR_BUSINESS,NAZAR_PROJECT} from '../supabase/functions/ops-collect/contracts.ts';

const staff='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222',claim='33333333-3333-4333-8333-333333333333';
const env={SUPABASE_ANON_KEY:'SYNTHETIC_ANON',SUPABASE_SERVICE_ROLE_KEY:'SYNTHETIC_SERVICE'};
const jwt='Bearer '+ 'a'.repeat(32);
function harness(options={}) {
 const calls=[];const actions=[];const finishes=[];const uploads=[];let claims=0;let lost=false;
 const send=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
 const request=async(url,init={})=>{
  const parsed=new URL(url);calls.push({path:parsed.pathname,host:parsed.hostname,method:init.method||'GET'});
  if(parsed.pathname.startsWith('/storage/v1/object/')){uploads.push({path:parsed.pathname,bytes:init.body});return send({Key:parsed.pathname});}
  const body=init.body?JSON.parse(init.body):{};
  if(parsed.origin===NAZAR_PROJECT){
   const name=parsed.pathname.split('/').at(-1);
   if(parsed.pathname==='/auth/v1/user')return send({id:staff});
   if(name==='crm_staff_authorized_v1')return send(options.authorized!==false);
   if(name==='ops_request_action'){
    const action={id,request_key:body.p_payload.clientRequestId,action:body.p_action,requested_by:staff,requested_at:new Date().toISOString(),status:'queued',result:{},finished_at:null};
    if(options.gray)Object.assign(action,{status:'not_connected',finished_at:new Date().toISOString(),result:{code:'capability_not_connected',message:'Synthetic unavailable capability.'}});
    actions.push({...action,payload:body.p_payload});
    if(options.lostAck&&!lost){lost=true;throw new Error('Synthetic lost acknowledgement');}
    return send(action);
   }
   if(name==='ops_actions_v')return send({items:actions.map(({payload,...safe})=>safe)});
   if(name==='ops_claim_action'){claims++;if(options.replay)return send(null);const action=actions.at(-1)||{id,request_key:crypto.randomUUID(),action:'collect',requested_by:staff,requested_at:new Date().toISOString(),payload:{}};return send({...action,claim_token:claim,status:'running'});}
   if(name==='ops_internal_snapshot_v')return send({metrics:[],previous:[],scheduler:{runs_24h:0,failed_24h:0},capabilities:['collect']});
   if(name==='ops_reserve_external_request')return send(options.budget!==false);
   if(name==='ops_finish_action'){finishes.push(body);return send(true);}
   if(name==='ops_apply_offer_action')return new Response(JSON.stringify({code:'55000',message:'Do not expose this private server message'}),{status:400});
   if(name==='ops_action_claim_valid')return send(true);
   if(name==='ops_commission_report_data')return send({business_id:NAZAR_BUSINESS,period_month:'2020-01-01',qualified_sales:15000,baseline:12000,refunds:0,qicr:3000,rate:.2,commission_amount:600,computed_at:new Date().toISOString(),persisted:true,source_file:'synthetic.csv',collected_at:new Date().toISOString(),period_start:'2020-01-01',period_end:'2020-01-31'});
   if(name==='ops_commit_clover_csv')return send({business_id:NAZAR_BUSINESS,period_month:'2020-01-01',qualified_sales:15000,baseline:12000,refunds:0,qicr:3000,rate:.2,commission_amount:600,computed_at:new Date().toISOString(),persisted:true});
   throw new Error('Unexpected local RPC: '+name);
  }
  if(parsed.href==='https://www.nazarrestaurantandbakery.com/')return new Response('<html>synthetic public site</html>',{status:options.siteStatus||200});
  throw new Error('Unexpected external network target');
 };
 const invoke=async(action,payload={},overrides={})=>handleRequest(new Request('https://khgczybubufouraqyrcj.supabase.co/functions/v1/ops-collect',{method:'POST',headers:{'Content-Type':'application/json',Authorization:jwt,Origin:'https://preview.nazar-restaurant-website.pages.dev',...overrides},body:JSON.stringify({action,payload:{clientRequestId:crypto.randomUUID(),...payload}})}),env,request);
 return {calls,actions,finishes,uploads,request,invoke,get claims(){return claims;}};
}

test('authorized manual collection claims once, persists aggregate-only results, and never sends mail',async()=>{
 const h=harness();const response=await h.invoke('collect');assert.equal(response.status,202);const body=await response.json();assert.equal(body.action.status,'running');assert.ok(body.action.request_key);assert.equal('payload'in body.action,false);assert.equal('claim_token'in body.action,false);
 assert.equal(h.claims,1);assert.equal(h.finishes.length,1);assert.equal(h.finishes[0].p_status,'done');assert.ok(h.finishes[0].p_metrics.some(m=>m.source==='site'&&m.metric==='http_status'&&m.value_num===200));
 assert.ok(h.finishes[0].p_connections.some(c=>c.source==='scheduler'&&c.status==='not_connected'));
 assert.equal(h.calls.filter(c=>c.host==='www.nazarrestaurantandbakery.com').length,1);
 assert.equal(h.calls.some(c=>/send|subscribe|campaigns/.test(c.path)),false);
});
test('unauthorized staff, foreign origins, wrong project and claim replay never collect',async()=>{
 const unauthorized=harness({authorized:false});assert.equal((await unauthorized.invoke('collect')).status,403);assert.equal(unauthorized.claims,0);
 const foreign=harness();assert.equal((await foreign.invoke('collect',{}, {Origin:'https://foreign.pages.dev'})).status,403);assert.equal(foreign.calls.length,0);
 const wrong=harness();assert.equal((await handleRequest(new Request('https://khgczybubufouraqyrcj.supabase.co/functions/v1/ops-collect',{method:'POST',headers:{'Content-Type':'application/json',Authorization:jwt},body:JSON.stringify({action:'collect',payload:{clientRequestId:crypto.randomUUID()}})}),{...env,SUPABASE_URL:'https://wrong-project.example'},wrong.request)).status,503);assert.equal(wrong.calls.length,0);
 const replay=harness({replay:true});assert.equal((await replay.invoke('collect')).status,409);assert.equal(replay.finishes.length,0);assert.equal(replay.calls.some(c=>c.host==='www.nazarrestaurantandbakery.com'),false);
});
test('lost enqueue acknowledgement recovers exact request_key with no second enqueue',async()=>{
 const h=harness({lostAck:true});assert.equal((await h.invoke('collect')).status,202);assert.equal(h.actions.length,1);assert.equal(h.claims,1);assert.equal(h.finishes.length,1);assert.ok(h.calls.some(c=>c.path.endsWith('/ops_actions_v')));
});
test('one provider failure keeps other snapshots and records partial collection; daily cap prevents external call',async()=>{
 const h=harness({siteStatus:503});await h.invoke('collect');assert.equal(h.finishes[0].p_status,'failed');assert.ok(h.finishes[0].p_metrics.some(m=>m.metric==='manual_runs_24h'));assert.equal(h.finishes[0].p_connections.find(c=>c.source==='site').status,'error');
 const capped=harness({budget:false});await capped.invoke('collect');assert.equal(capped.calls.some(c=>c.host==='www.nazarrestaurantandbakery.com'),false);assert.equal(capped.finishes[0].p_status,'failed');
 assert.equal(capped.finishes[0].p_result.requestsUsed,0);
});
test('grey empty-target intent returns terminal receipt without claim or background work',async()=>{
 for(const action of ['ads_set_status','product_set_channel','offer_set_active','retry_failed_job']){
  const h=harness({gray:true});const response=await h.invoke(action);assert.equal(response.status,200);assert.equal((await response.json()).action.status,'not_connected');assert.equal(h.claims,0);assert.equal(h.finishes.length,0);
 }
});
test('unverified offer/ads/inventory actions remain not_connected and never send provider writes',async()=>{
 for(const [action,payload]of [['offer_set_active',{offerId:id,active:true}],['ads_set_status',{source:'google_ads',campaignId:'123',status:'PAUSED'}],['product_set_channel',{productId:'TEST_PRODUCT',channel:'pickup',available:false}]]){
  const h=harness();await h.invoke(action,payload);assert.equal(h.finishes[0].p_status,'not_connected');assert.equal(h.calls.some(c=>c.host!==new URL(NAZAR_PROJECT).host),false);assert.equal(JSON.stringify(h.finishes).includes('private server message'),false);
 }
});
test('qualified full-month CSV is committed privately, raw CSV is absent from safe result',async()=>{
 const h=harness();const csv=['order_id,transaction_id,transaction_type,occurred_at,channel,net_sales_usd,export_period_start,export_period_end',...Array.from({length:20},(_,i)=>`SYNTHETIC_ORDER_${i},SYNTHETIC_TX_${i},payment,2020-01-15T12:00:00-05:00,pickup,750.00,2020-01-01,2020-01-31`)].join('\n');
 const response=await h.invoke('sync_clover_csv',{csv,fileName:'synthetic.csv',periodStart:'2020-01-01',periodEnd:'2020-01-31'});assert.equal(response.status,202);assert.ok(h.calls.some(c=>c.path.endsWith('/ops_commit_clover_csv')));assert.equal(h.finishes[0].p_result.code,'csv_imported');assert.equal(JSON.stringify(h.finishes).includes('SYNTHETIC_ORDER'),false);assert.equal(JSON.stringify(await response.json()).includes('SYNTHETIC_ORDER'),false);
});
test('background dispatch claims before ack and registers one manual background task',async()=>{
 const h=harness();const work=[];const response=await handleRequest(new Request('https://khgczybubufouraqyrcj.supabase.co/functions/v1/ops-collect',{method:'POST',headers:{'Content-Type':'application/json',Authorization:jwt},body:JSON.stringify({action:'collect',payload:{clientRequestId:crypto.randomUUID()}})}),env,h.request,promise=>work.push(promise));
 assert.equal(response.status,202);assert.equal(h.claims,1);assert.equal(work.length,1);await Promise.all(work);assert.equal(h.finishes.length,1);
});
test('full-month report uses private versioned object and known-job retry only repeats collection',async()=>{
 const report=harness();await report.invoke('commission_report',{month:'2020-01'});assert.equal(report.finishes[0].p_status,'done');assert.equal(report.uploads.length,1);assert.ok(report.uploads[0].path.startsWith(`/storage/v1/object/nazar-ops/${NAZAR_BUSINESS}/ops/commission/2020-01-`));assert.equal(report.finishes[0].p_result.downloadPath,`${NAZAR_BUSINESS}/ops/commission/2020-01-${id}.pdf`);
 const retry=harness();await retry.invoke('retry_failed_job',{actionId:id});assert.equal(retry.finishes[0].p_result.retriedActionId,id);assert.equal(retry.calls.some(c=>c.path.includes('send')),false);
});
test('single-page PDF has valid xref offsets, formula source and no second refund deduction',()=>{
 const data={business_id:NAZAR_BUSINESS,period_month:'2020-01-01',qualified_sales:15000,baseline:12000,refunds:0,qicr:3000,rate:.2,commission_amount:600,computed_at:'2020-02-01T12:00:00Z',persisted:true,source_file:'synthetic.csv',collected_at:'2020-02-01T12:00:00Z',period_start:'2020-01-01',period_end:'2020-01-31'};
 const text=new TextDecoder().decode(createCommissionPdf(data));assert.ok(text.startsWith('%PDF-1.4'));assert.match(text,/\/Count 1/);assert.match(text,/600\.00/);assert.match(text,/NOT deducted a second time/);const offset=Number(/startxref\n(\d+)/.exec(text)[1]);assert.equal(text.slice(offset,offset+4),'xref');
 assert.throws(()=>createCommissionPdf({...data,business_id:id}),/invalid_commission/);
});
