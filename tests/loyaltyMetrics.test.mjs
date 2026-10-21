import test from 'node:test';
import assert from 'node:assert/strict';
import { loyaltyMonth, loyaltyRequestParams, loyaltyScopeMatches, validLoyaltyMetrics } from '../src/lib/loyaltyMetrics.ts';

const scope = { businessId:'11111111-1111-4111-8111-111111111111', identity:'synthetic-staff',month:'2026-10-01',includeTests:false };
const fixture = () => ({ version:1,business_id:scope.businessId,month:scope.month,timezone:'America/New_York',include_tests:false,generated_at:'2026-10-20T16:00:00Z',
  customer_counts:{known:true,new:1,repeat:1,reason:null},campaigns:{known:true,items:[{campaign_id:'22222222-2222-4222-8222-222222222222',name:'Synthetic campaign',applied:2,
  repeat_30d:{known:true,numerator:1,denominator:2,rate:.5,reason:null}}],reason:null},messages:{known:true,sent:0,reason:null},attribution:{known:false,orders:null,reason:'explicit_attribution_missing'} });

test('Observed new/repeat overlap, sourced sent zero and unknown attribution stay distinct', () => {
  assert.equal(validLoyaltyMetrics(fixture(),scope),true);
  for (const orders of [0,'0',undefined]) assert.equal(validLoyaltyMetrics({...fixture(),attribution:{known:false,orders,reason:'explicit_attribution_missing'}},scope),false);
});
test('Missing sources must be null with a reason, never fabricated zero or missing arrays', () => {
  const data=fixture();data.customer_counts={known:false,new:null,repeat:null,reason:'no_observed_orders'};
  data.campaigns={known:false,items:[],reason:'no_observed_orders'};data.messages={known:false,sent:null,reason:'message_source_missing'};
  assert.equal(validLoyaltyMetrics(data,scope),true);
  for(const customer_counts of [{known:false,new:0,repeat:0,reason:'no_observed_orders'},{known:false,new:null,repeat:null,reason:null}]) assert.equal(validLoyaltyMetrics({...data,customer_counts},scope),false);
  assert.equal(validLoyaltyMetrics({...data,campaigns:{known:false,items:null,reason:'no_observed_orders'}},scope),false);
});
test('Returned business, calendar month and test-filter must match the request exactly', () => {
  for(const patch of [{business_id:'33333333-3333-4333-8333-333333333333'},{month:'2026-09-01'},{include_tests:true},{version:2}]) assert.equal(validLoyaltyMetrics({...fixture(),...patch},scope),false);
});
test('Identity/month/filter changes invalidate a previous read without accepting stale data', () => {
  assert.equal(loyaltyScopeMatches(scope,{...scope}),true);
  for(const patch of [{identity:'another-staff'},{businessId:'other'},{month:'2026-11-01'},{includeTests:true}]) assert.equal(loyaltyScopeMatches(scope,{...scope,...patch}),false);
});
test('Only the read RPC parameters are emitted; identity is not sent or used as a tenant selector', () => {
  assert.deepEqual(loyaltyRequestParams(scope),{p_business_id:scope.businessId,p_month:'2026-10-01',p_include_tests:false});
  assert.equal(loyaltyRequestParams({...scope,includeTests:true}).p_include_tests,true);
});
test('The reporting month follows tenant timezone including NY DST month boundaries', () => {
  assert.equal(loyaltyMonth(new Date('2026-11-01T03:59:00Z')),'2026-10-01');
  assert.equal(loyaltyMonth(new Date('2026-11-01T04:00:00Z')),'2026-11-01');
  assert.equal(loyaltyMonth(new Date('2026-11-01T00:00:00Z'),'Asia/Tokyo'),'2026-11-01');
});
test('Incomplete 30 day cohorts stay unknown and rates cannot invent a denominator', () => {
  const data=fixture();const entry=data.campaigns.items[0];
  entry.repeat_30d={known:false,numerator:null,denominator:null,rate:null,reason:'cohort_not_mature'};
  assert.equal(validLoyaltyMetrics(data,scope),true);
  for(const repeat_30d of [{known:true,numerator:0,denominator:0,rate:0,reason:null},{known:true,numerator:1,denominator:2,rate:50,reason:null},{known:true,numerator:3,denominator:2,rate:1.5,reason:null},{known:true,numerator:1,denominator:2,rate:.2,reason:null}]) assert.equal(validLoyaltyMetrics({...data,campaigns:{...data.campaigns,items:[{...entry,repeat_30d}]}},scope),false);
});
test('Malformed values, duplicate campaigns and error text never become trusted metric data', () => {
  const data=fixture();
  for(const patch of [{generated_at:'invalid'},{timezone:'invalid'},{customer_counts:{known:true,new:'1',repeat:1,reason:null}},{messages:{known:true,sent:NaN,reason:null}},{attribution:{known:false,orders:null,reason:'private customer@example.invalid'}}]) assert.equal(validLoyaltyMetrics({...data,...patch},scope),false);
  assert.equal(validLoyaltyMetrics({...data,campaigns:{...data.campaigns,items:[data.campaigns.items[0],data.campaigns.items[0]]}},scope),false);
});


test('Usage breakdown must sum to total; cohort denominator cannot include staff attestations',()=>{
 const data=fixture(),item=data.campaigns.items[0];Object.assign(item,{order_linked:2,staff_attested:0});assert.equal(validLoyaltyMetrics(data,scope),true);
 for(const patch of [{order_linked:1},{staff_attested:1},{order_linked:-1},{order_linked:'2'},{staff_attested:undefined}])assert.equal(validLoyaltyMetrics({...data,campaigns:{...data.campaigns,items:[{...item,...patch}]}},scope),false);
 const old=fixture();assert.equal(validLoyaltyMetrics(old,scope),true);
});
