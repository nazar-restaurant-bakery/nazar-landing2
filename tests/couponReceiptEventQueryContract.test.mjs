// Official July API contract + actual receipt adapter, synthetic GET-only fetch.
import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {reconcileCouponDelivery,liveReceiptProvider} from '../functions/_lib/couponDelivery.ts';
const spec=JSON.parse(await readFile(new URL('./fixtures/klaviyoGetEvents20260715.json',import.meta.url),'utf8'));
const params=new Map(spec.parameters.map(p=>[p.name,p]));
const B='10000000-0000-4000-8000-000000000001',C='20000000-0000-4000-8000-000000000001',I='30000000-0000-4000-8000-000000000001';
const context={businessId:B,bindingId:I,accountId:'ACCOUNT',profileId:'PROFILE',flowId:'FLOW',messageId:'MESSAGE',metricId:'METRIC',dispatchedAt:'2026-10-21T16:00:00Z',activationAllowed:false};
function validate(u){for(const [k,v]of u.searchParams){const p=params.get(k);assert.ok(p,'unknown query '+k);if(p.schema.items?.enum)for(const item of v.split(','))assert.ok(p.schema.items.enum.includes(item),'unsupported field');}}
const event=()=>({id:'EVENT',attributes:{datetime:'2026-10-21T16:01:00Z',event_properties:{$flow:'FLOW',$message:'MESSAGE'}},relationships:{profile:{data:{id:'PROFILE'}},metric:{data:{id:'METRIC'}}}});
async function run(transform=x=>x){const calls=[],records=[];const store={async rpc(n,a){if(n==='coupon_delivery_context_v1')return context;assert.equal(n,'coupon_delivery_record_v1');records.push(a);return {acknowledged:true,code:'delivery_confirmed',deliveredAt:a.p_delivered_at};}};
 const provider=liveReceiptProvider('pk_synthetic_receipt_only_12345',async(input,init)=>{const u=new URL(input);calls.push({u,init});assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.headers.revision,spec.version);
  if(u.pathname==='/api/accounts/')return Response.json({data:[{id:'ACCOUNT'}]});
  if(u.pathname==='/api/metrics/METRIC/')return Response.json({data:{id:'METRIC',attributes:{name:'Received Email',integration:{name:'Klaviyo',category:'Internal'}}}});
  assert.equal(u.pathname,'/api/events/');validate(u);
  // A receipt key with Events/Metrics/Accounts Read has no Profiles Read.
  if(u.searchParams.has('include'))return Response.json({code:'synthetic_missing_profiles_read'},{status:403});
  assert.deepEqual([...u.searchParams.keys()].sort(),['fields[event]','filter','page[size]']);
  assert.equal(u.searchParams.get('fields[event]'),'datetime,event_properties,uuid');
  assert.equal(u.searchParams.get('filter'),'and(equals(metric_id,"METRIC"),equals(profile_id,"PROFILE"),greater-or-equal(datetime,2026-10-21T16:00:00.000Z))');
  return Response.json({data:[transform(event())],links:{next:null}});
 });return {result:await reconcileCouponDelivery({store,provider,businessId:B,couponId:C,accountId:'ACCOUNT',now:()=>Date.parse('2026-10-21T17:00:00Z')}),calls,records};}
test('official July ID sparse fields are valid; linked IDs exist in primary events',()=>{assert.equal(spec.version,'2026-07-15');assert.equal(spec.source_sha256,'d81ec2b3fc30d79825f29e2b682261156579716f67056f7e01d6a3c024bff464');for(const field of ['fields[profile]','fields[metric]'])assert.ok(params.get(field).schema.items.enum.includes('id'));for(const kind of ['profile','metric'])assert.equal(spec.relationships.properties[kind].properties.data.properties.id.type,'string');assert.ok(!spec.event_required.includes('relationships'));});
test('receipt exact native match works with primary linkage and no profile expansion',async()=>{const h=await run();assert.equal(h.result.status,'delivered');assert.equal(h.result.activationReady,false);assert.equal(h.calls.length,3);assert.equal(h.records.length,1);assert.match(h.records[0].p_evidence_sha256,/^[a-f0-9]{64}$/);});
for(const kind of ['profile','metric'])test('missing '+kind+' linkage fails closed without fallback',async()=>{const h=await run(e=>{delete e.relationships[kind];return e;});assert.equal(h.result.status,'pending');assert.equal(h.records.length,0);assert.equal(h.calls.length,3);});
test('missing entire optional relationship object fails closed',async()=>{const h=await run(e=>{delete e.relationships;return e;});assert.equal(h.result.status,'pending');assert.equal(h.records.length,0);assert.equal(h.calls.length,3);});
