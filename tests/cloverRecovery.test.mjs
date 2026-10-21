import test from 'node:test';import assert from 'node:assert/strict';
import {recoveryWindow,dayProofs,recover} from '../tools/test-env/clover-recovery.ts';
test('November recovery covers all thirty NY days including 25-hour DST; closed range only',()=>{
 const w=recoveryWindow('2026-11-01','2026-11-30',Date.parse('2026-12-02T13:00Z'));
 assert.equal(w.start,Date.parse('2026-11-01T04:00Z'));assert.equal(w.end,Date.parse('2026-12-01T05:00Z'));assert.equal(w.days,30);
 for(const [a,b] of [['2026-11-31','2026-11-31'],['2026-10-01','2026-11-30'],['2026-11-30','2026-11-01'],['2026-11-01','2026-12-02']])assert.throws(()=>recoveryWindow(a,b,Date.parse('2026-12-02T13:00Z')));
 assert.equal(dayProofs([],'2026-11-01','2026-11-30').length,30);
});
const config={ready:true,url:'https://'+'s'.repeat(20)+'.supabase.co',secret:'synthetic',businessId:'11111111-1111-4111-8111-111111111111',merchant:'MERCHANT123',token:'synthetic',onlineTypes:['ONLINE12345'],cloverBase:'https://apisandbox.dev.clover.com'};
test('month recovery uses shared budget, preserves K7 idempotent ingest and emits daily aggregates only',async()=>{
 let reservations=0,ingests=0;
 const order={id:'ORDER123456',createdTime:Date.parse('2026-11-01T05:30Z'),orderType:{id:'ONLINE12345'},lineItems:{elements:[]},payments:{elements:[]}};
 const fetcher=async(input,init)=>{
  const u=new URL(input);const name=u.pathname.split('/').at(-1);
  if(name==='daily_reserve_external_request'){reservations++;return Response.json(true);}
  if(name==='clover_order_ingest_v1'){ingests++;assert.equal(JSON.parse(init.body).p_business_id,config.businessId);return Response.json({});}
  if(name==='MERCHANT123')return Response.json({id:'MERCHANT123'});
  if(name==='orders')return Response.json({elements:[{...order,refunds:{elements:[]},customers:{elements:[]}}]});
  throw Error('unexpected');
 };
 for(let i=0;i<2;i++){
  const proof=await recover(config,'2026-11-01','2026-11-30','daily_reserve_external_request',fetcher,Date.parse('2026-12-02T13:00Z'));
  assert.equal(proof.sourceOrders,1);assert.equal(proof.days.length,30);assert.equal(proof.days[0].sourceCount,1);assert.equal(proof.days[1].sourceCount,0);assert.equal(proof.status,'PENDING_DATABASE_CHECK');
  assert.equal(JSON.stringify(proof).includes('ORDER123456'),false);
 }
 assert.equal(ingests,2);assert.equal(reservations,8);
});
test('quota exhaustion and wrong merchant stop before any ingest',async()=>{
 for(const denied of ['budget','merchant']){
  let ingests=0;
  await assert.rejects(recover(config,'2026-11-01','2026-11-30','daily_reserve_external_request',async input=>{
   const name=new URL(input).pathname.split('/').at(-1);
   if(name==='daily_reserve_external_request')return Response.json(denied!=='budget');
   if(name==='clover_order_ingest_v1')ingests++;
   return Response.json({id:'WRONG12345'});
  },Date.parse('2026-12-02T13:00Z')));
  assert.equal(ingests,0);
 }
});
