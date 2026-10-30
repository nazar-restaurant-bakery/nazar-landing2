// A void/refund made days after an order changes only the older order. The
// scheduled pull must re-ingest it; the manual closed-day pull stays unchanged.
import test from 'node:test';import assert from 'node:assert/strict';
import {machineSignature} from '../functions/_lib/dailySchedulerAuth.ts';
import {dailyCloverHandler} from '../functions/api/internal/daily-clover-pull.ts';
import {collectOrders,orderPullConfig} from '../functions/_lib/cloverOrderPull.ts';
const secret='synthetic-machine-key-not-used-anywhere-live-123456';
const business='11111111-1111-4111-8111-111111111111',run='22222222-2222-4222-8222-222222222222',nonce='33333333-3333-4333-8333-333333333333',token='44444444-4444-4444-8444-444444444444';
const env={APP_ENV:'isolated-test',TEST_SUPABASE_URL:'https://'+'s'.repeat(20)+'.supabase.co',TEST_BUSINESS_ID:business,TEST_SUPABASE_SECRET_KEY:'sb_secret_synthetic_only',TEST_TURNSTILE_SECRET_KEY:'1x0000000000000000000000000000000AA',TEST_TURNSTILE_EXPECTED_HOSTNAME:'preview.pages.dev',VITE_TEST_SUPABASE_ANON_KEY:'sb_publishable_synthetic_only',TEST_CLOVER_MERCHANT_ID:'MERCHANT123',TEST_CLOVER_ORDERS_ACCESS_TOKEN:'synthetic-clover-token',TEST_CLOVER_ONLINE_ORDER_TYPE_IDS:'ONLINE12345',SCHEDULER_SIGNING_SECRET:secret};
const start=Date.parse('2026-11-03T05:00:00Z'),end=Date.parse('2026-11-04T05:00:00Z'),old=start-3*86400000;
// Synthetic Clover: NEW0000001 created in the window; OLD0000001 created three days
// earlier and fully refunded inside the window (only its modifiedTime moved).
function clover(seen){return async(input)=>{
 const u=new URL(input);seen.push(u);
 const filters=u.searchParams.getAll('filter'),modified=filters[0]?.startsWith('modifiedTime');
 const expand=u.searchParams.get('expand');
 const order=modified?{id:'OLD0000001',createdTime:old,modifiedTime:start+3600000}:{id:'NEW0000001',createdTime:start+1000};
 const payment=modified?{id:'PAYOLD0001',amount:10735,result:'SUCCESS'}:{id:'PAYNEW0001',amount:5000,result:'SUCCESS'};
 if(expand==='refunds')return Response.json({elements:[{id:order.id,refunds:{elements:modified?[{id:'REFOLD0001',amount:10735,payment:{id:'PAYOLD0001'}}]:[]}}]});
 if(expand==='customers')return Response.json({elements:[{id:order.id,customers:{elements:[]}}]});
 return Response.json({elements:[{...order,orderType:{id:'ONLINE12345'},lineItems:{elements:[]},payments:{elements:[payment]}}]});
};}

test('scheduled pull re-ingests an older order refunded inside the window',async()=>{
 const seen=[],ingested=[];
 const fetch=async(input,init)=>{
  const u=new URL(input);
  if(u.hostname===('s'.repeat(20)+'.supabase.co')){
   const name=u.pathname.split('/').at(-1);
   if(name==='clover_order_ingest_v1'){ingested.push(JSON.parse(init.body).p_snapshot);return Response.json({orderId:'x'});}
   return Response.json(true);
  }
  return clover(seen)(input);
 };
 const body={business_id:business,run_id:run,nonce,issued_at:Math.floor(Date.now()/1000),claim_token:token,start_ms:start,end_ms:end};
 const request=new Request('https://preview.pages.dev/api/internal/daily-clover-pull',{method:'POST',headers:{'X-Scheduler-Signature':await machineSignature('daily.clover.v1',body,secret)},body:JSON.stringify(body)});
 const response=await dailyCloverHandler(fetch)({request,env});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{code:'succeeded',upserted:2,reconciled:false});
 assert.deepEqual(ingested.map(o=>o.id).sort(),['NEW0000001','OLD0000001']);
 const refunded=ingested.find(o=>o.id==='OLD0000001');
 assert.deepEqual(refunded.refunds.map(r=>[r.id,r.amount,r.payment.id]),[['REFOLD0001',10735,'PAYOLD0001']]);
 assert.equal(refunded.refundsVerified,true);
 // Both groups use the same expansions; the modified group only covers older orders.
 const modified=seen.filter(u=>u.searchParams.getAll('filter')[0].startsWith('modifiedTime'));
 assert.deepEqual(modified.map(u=>u.searchParams.get('expand')),['orderType,lineItems,payments','refunds','customers']);
 for(const u of modified)assert.deepEqual(u.searchParams.getAll('filter'),['modifiedTime>='+start,'modifiedTime<='+(end-1),'createdTime<'+start]);
 assert.equal(seen.length,6);
});

test('manual closed-day pull keeps the created-time listing only',async()=>{
 const seen=[];const config=orderPullConfig(env,'preview.pages.dev');assert.equal(config.ready,true);
 const {orders}=await collectOrders(config,{start,end},clover(seen));
 assert.deepEqual(orders.map(o=>o.id),['NEW0000001']);
 assert.equal(seen.some(u=>u.searchParams.getAll('filter').some(f=>f.startsWith('modifiedTime'))),false);
});
