import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {captureUtm,getUtmOrNull} from '../src/lib/utm.ts';
import {trackVipSignupSubmitted,trackVipConfirmationStarted} from '../src/lib/analytics.ts';
import {qrCardEventParams} from '../src/lib/qrCard.ts';
import {collectWithQr} from '../supabase/functions/ops-collect/ga4.ts';
import {validQrFunnel} from '../src/lib/qrVipFunnel.ts';
afterEach(()=>{delete globalThis.window;delete globalThis.document;});
test('P-card context survives internal navigation and both GA4 VIP stages get only fixed non-PII QR labels',()=>{
 const storage=new Map(),calls=[];globalThis.window={location:{hostname:'www.nazarrestaurantandbakery.com',pathname:'/vip',search:'?utm_source=qr&utm_medium=offline&utm_campaign=qr_paket&email=private@example.invalid'},sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},gtag:(...args)=>calls.push(args)};globalThis.document={referrer:''};
 captureUtm();window.location.search='';window.location.pathname='/menu';assert.equal(getUtmOrNull().utm_campaign,'qr_paket');
 trackVipSignupSubmitted('private-request-id');trackVipSignupSubmitted('private-request-id');trackVipConfirmationStarted('private-request-id');
 assert.equal(calls.length,2);for(const c of calls)assert.deepEqual(c[2],{form_name:'vip',qr_source:'qr',qr_medium:'offline',qr_campaign:'qr_paket'});
 assert.doesNotMatch(JSON.stringify(calls),/private|email|request-id/);
});
test('Unknown, untagged, T design and arbitrary PII UTM values are never claimed as printed P traffic',()=>{for(const v of [null,{}, {utm_source:'qr_card',utm_medium:'offline',utm_campaign:'simit_vip'},{utm_source:'qr',utm_medium:'offline',utm_campaign:'qr_masa'},{utm_source:'private@example.invalid',utm_medium:'offline',utm_campaign:'qr_paket'}])assert.deepEqual(qrCardEventParams(v),{});});
const report=(v,extra={})=>({metricHeaders:[{name:'sessions'}],rows:[{metricValues:[{value:String(v)}]}],rowCount:1,metadata:{timeZone:'America/New_York',...extra}});
function ctx(router,remaining=30,now='2026-10-21T23:00:00Z'){const calls=[];return{env:{GA4_ACCESS_TOKEN:'synthetic-only'},now:new Date(now),budget:{remaining},calls,fetch:async(url,init)=>{const body=JSON.parse(init.body);calls.push(body);return Response.json(router(body,calls.length));}};}
test('QR sessions use native session source/medium/campaign filters, complete NY days and shared 30 request budget',async()=>{
 const c=ctx((b,n)=>{if(n===1)return report(232);assert.deepEqual(b.dateRanges,[{startDate:'2026-10-01',endDate:'2026-10-20'}]);assert.deepEqual(b.dimensionFilter.andGroup.expressions.map(x=>[x.filter.fieldName,x.filter.stringFilter.value]),[['sessionSource','qr'],['sessionMedium','offline'],['sessionCampaignName','qr_paket']]);return report(7);});
 const r=await collectWithQr(c);assert.equal(r.metrics.find(x=>x.metric==='visits_7d').value_num,232);assert.equal(r.metrics.find(x=>x.metric==='qr_paket_sessions_mtd').value_num,7);assert.equal(r.requestsUsed,2);assert.equal(c.budget.remaining,28);
});
for(const mode of ['threshold','sample','malformed','quota'])test('QR '+mode+' never fabricates zero or removes verified total',async()=>{const c=ctx((b,n)=>n===1?report(232):mode==='threshold'?report(0,{subjectToThresholding:true}):mode==='sample'?report(0,{samplingMetadatas:[{}]}):{} ,mode==='quota'?1:30);const r=await collectWithQr(c);assert.equal(r.status,'connected');assert.equal(r.metrics[0].value_num,232);assert.equal(r.metrics.find(x=>x.metric==='qr_paket_sessions_mtd').value_num,null);assert.ok(c.budget.remaining>=0);});
test('Explicit empty QR report is sourced zero; first day has no invented monthly sessions',async()=>{const c=ctx((b,n)=>n===1?report(232):{metricHeaders:[{name:'sessions'}],rowCount:0,metadata:{timeZone:'America/New_York'}});assert.equal((await collectWithQr(c)).metrics.at(-1).value_num,0);const day=ctx(()=>report(232),30,'2026-11-01T06:00:00Z');const r=await collectWithQr(day);assert.equal(day.calls.length,1);assert.equal(r.metrics.length,1);});
const good={version:1,business_id:'b',month:'2026-10-01',timezone:'America/New_York',include_tests:false,cohort_end_exclusive:'2026-10-21T04:00:00Z',observed_at:'2026-10-21T23:00:00Z',source:'qr/offline/qr_paket',coupon_scope:'signup_reward:SIMIT',sessions:null,sessions_checked_at:null,registrations:2,confirmed:2,coupons:2,used:2,order_linked:1,staff_attested:1,repeat_30d:{known:false,numerator:null,denominator:null,rate:null}};
test('Funnel validates tenant/month/filter/count sums and excludes staff attestation from repeat denominator',()=>{assert.equal(validQrFunnel(good,'b','2026-10-01',false),true);for(const patch of [{business_id:'other'},{include_tests:true},{used:3},{confirmed:3},{source:'qr_card'},{repeat_30d:{known:true,numerator:1,denominator:2,rate:.5}}])assert.equal(validQrFunnel({...good,...patch},'b','2026-10-01',false),false);});

test('secondary QR HTTP 400 keeps total sessions and stores only safe error code',async()=>{
 const c=ctx(()=>report(232));const original=c.fetch;c.fetch=async(u,i)=>c.calls.length===1?new Response(JSON.stringify({errors:[{detail:'private-provider-detail'}]}),{status:400}):original(u,i);
 const r=await collectWithQr(c);assert.equal(r.status,'connected');assert.equal(r.metrics[0].value_num,232);assert.equal(r.metrics[1].value_num,null);assert.doesNotMatch(JSON.stringify(r),/private-provider-detail/);assert.match(r.metrics[1].value_text,/400/);
});
