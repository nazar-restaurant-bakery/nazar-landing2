import test from 'node:test';import assert from 'node:assert/strict';
import {reconcileCouponDelivery,liveReceiptProvider} from '../functions/_lib/couponDelivery.ts';
const B='10000000-0000-4000-8000-000000000001',C='20000000-0000-4000-8000-000000000001',I='30000000-0000-4000-8000-000000000001';
const NOW=Date.parse('2026-10-21T17:00Z');
const context={bindingId:I,businessId:B,accountId:'ACCOUNT',profileId:'PROFILE',flowId:'FLOW',messageId:'MESSAGE',metricId:'METRIC',dispatchedAt:'2026-10-21T16:00:00Z',activationAllowed:true};
const event=()=>({id:'EVENT',attributes:{datetime:'2026-10-21T16:01:00Z',event_properties:{$flow:'FLOW',$message:'MESSAGE',Subject:'not persisted'}},relationships:{profile:{data:{id:'PROFILE'}},metric:{data:{id:'METRIC'}}}});
function fixture({c=context,events=[event()],next=null,account='ACCOUNT',metricName='Received Email',category='Internal',ack=true,mode='mock'}={}){
 const calls=[],records=[];
 const store={async rpc(name,args){calls.push(name);if(name==='coupon_delivery_context_v1')return c;assert.equal(name,'coupon_delivery_record_v1');records.push(args);return {acknowledged:ack,code:'delivery_confirmed',deliveredAt:args.p_delivered_at};}};
 const provider={mode,async get(path,query){calls.push(path);if(path==='/accounts')return {data:[{id:account}]};if(path==='/metrics/METRIC')return {data:{id:'METRIC',attributes:{name:metricName,integration:{name:'Klaviyo',category}}}};
  assert.equal(path,'/events');assert.match(query.filter,/equals\(profile_id,"PROFILE"\)/);return {data:events,links:{next}};}};
 return {calls,records,run:()=>reconcileCouponDelivery({store,provider,businessId:B,couponId:C,accountId:'ACCOUNT',now:()=>NOW})};
}
test('native Received Email binds exact account/profile/metric/flow/message/time and records only a digest',async()=>{
 const h=fixture();const r=await h.run();assert.equal(r.status,'delivered');assert.equal(r.activationReady,false);assert.equal(r.synthetic,true);assert.equal(h.records.length,1);
 const saved=JSON.stringify(h.records);assert.equal(saved.includes('Subject'),false);assert.equal(saved.includes('not persisted'),false);assert.match(h.records[0].p_evidence_sha256,/^[a-f0-9]{64}$/);
});
for(const [name,change] of [['wrong profile',e=>e.relationships.profile.data.id='FOREIGN'],['wrong metric',e=>e.relationships.metric.data.id='OTHER'],['wrong flow',e=>e.attributes.event_properties.$flow='OTHER'],['wrong message',e=>e.attributes.event_properties.$message='OTHER'],['before dispatch',e=>e.attributes.datetime='2026-10-20T16:00:00Z'],['future receipt',e=>e.attributes.datetime='2026-10-22T16:00:00Z']])test(name+' cannot resolve unknown',async()=>{const e=event();change(e);const h=fixture({events:[e]});assert.notEqual((await h.run()).status,'delivered');assert.equal(h.records.length,0);});
for(const [name,options] of [['202 is not delivery',{events:[]}],['duplicate native receipts',{events:[event(),{...event(),id:'SECOND'}]}],['incomplete pagination',{next:'https://evil.invalid/cursor'}],['wrong account',{account:'OTHER'}],['custom imitation of native metric',{category:'API'}],['opened is not received',{metricName:'Opened Email'}],['wrong business context',{c:{...context,businessId:C}}],['lost DB acknowledgement',{ack:false}]])test(name,async()=>{const h=fixture(options);assert.notEqual((await h.run()).status,'delivered');assert.equal((await h.run()).activationReady,false);});
test('verified live readback can report ready; an accepted event or a mock cannot',async()=>{const h=fixture({mode:'live'});assert.equal((await h.run()).activationReady,true);});
test('a real receipt does not report activation ready after current local gates close',async()=>{const h=fixture({mode:'live',c:{...context,activationAllowed:false}});const r=await h.run();assert.equal(r.status,'delivered');assert.equal(r.activationReady,false);});
test('receipt transport is GET only, pinned revision and fixed host; no arbitrary path or subscription call',async()=>{
 const calls=[];const p=liveReceiptProvider('pk_synthetic_read_12345',async(u,o)=>{calls.push([u,o]);return Response.json({data:[]});});
 for(const path of ['/profiles','/events/../accounts','/profile-subscription-bulk-create-jobs','https://evil.invalid'])await assert.rejects(p.get(path));
 assert.equal(calls.length,0);await p.get('/accounts');await p.get('/events',{'page[size]':'100'});
 assert.ok(calls.every(([u,o])=>new URL(u).hostname==='a.klaviyo.com'&&o.method==='GET'&&o.redirect==='manual'&&o.headers.revision==='2026-07-15'));
});
