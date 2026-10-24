import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrapProvider,bootstrapStore,couponBootstrapConfig,handleCouponBootstrapRequest,couponEventPropertiesMatch} from '../functions/_lib/couponBootstrap.ts';

// Independent transport boundary review. Synthetic responses only; no network.
const config={mode:'live',isolated:false,url:'https://synthetic.invalid',businessId:'10000000-0000-4000-8000-000000000001',
 serviceKey:'sb_secret_synthetic_only',processKey:'synthetic_process_key_12345678901234567890',accountId:'SYNTHETIC',
 readKey:'pk_synthetic_read_only',eventKey:'pk_synthetic_event_only',receiptKey:'pk_synthetic_receipt_only',
 qrOrigin:'https://synthetic.invalid',approvalId:'synthetic-review'};
const metric={type:'metric',id:'METRIC',attributes:{name:'Synthetic',integration:{name:'API',category:'API'}}};
function inventory(next=null){
 const calls=[];
 const provider=bootstrapProvider(config,async(url,options)=>{
  calls.push({url:String(url),options});
  if(new URL(url).pathname==='/api/accounts/')return Response.json({data:[{id:'SYNTHETIC'}]});
  return Response.json({data:[metric],links:{next}});
 });
 return {provider,calls};
}
test('complete inventory uses pinned authenticated GET without redirect following',async()=>{
 const h=inventory();const result=await h.provider.inventory();
 assert.equal(result.complete,true);assert.equal(result.accountId,'SYNTHETIC');assert.equal(result.metrics.length,1);
 assert.equal(h.calls.length,2);
 for(const {url,options}of h.calls){assert.equal(new URL(url).origin,'https://a.klaviyo.com');assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');assert.equal(options.headers.revision,'2026-07-15');}
});
for(const [label,next]of [
 ['foreign origin','https://foreign.invalid/api/metrics/?page%5Bcursor%5D=next'],
 ['wrong path','https://a.klaviyo.com/api/profiles/?page%5Bcursor%5D=next'],
 ['embedded credentials','https://person:credential@a.klaviyo.com/api/metrics/'],
 ['fragment','https://a.klaviyo.com/api/metrics/#next'],
 ['filtered incomplete inventory','https://a.klaviyo.com/api/metrics/?filter=equals(name,%22Synthetic%22)'],
 ['loop','https://a.klaviyo.com/api/metrics/'],
])test('inventory rejects '+label+' before a second metrics request',async()=>{
 const h=inventory(next);await assert.rejects(h.provider.inventory());assert.equal(h.calls.length,2);
});
for(const status of [201,202,301,302,307,308,401,429,500])test('inventory accepts no status '+status,async()=>{
 let calls=0;
 const provider=bootstrapProvider(config,async(url)=>{
  calls++;
  if(new URL(url).pathname==='/api/accounts/')return Response.json({data:[{id:'SYNTHETIC'}]});
  return new Response('not read',{status});
 });
 await assert.rejects(provider.inventory());assert.equal(calls,2);
});
test('wrong account cannot read inventory',async()=>{
 let calls=0;const provider=bootstrapProvider(config,async()=>{calls++;return Response.json({data:[{id:'FOREIGN'}]});});
 await assert.rejects(provider.inventory());assert.equal(calls,1);
});
test('bootstrap cannot invoke arbitrary database RPC or profile/subscription writes',async()=>{
 const calls=[];const store=bootstrapStore(config,async(...args)=>{calls.push(args);return Response.json({allowed:false});});
 for(const name of ['coupon_bootstrap_permit_v1','coupon_bootstrap_late_bind_v1','message_send_settings','anything'])await assert.rejects(store.rpc(name,{}));
 const provider=bootstrapProvider(config,async(...args)=>{calls.push(args);return Response.json({});});
 for(const path of ['/profile-subscription-bulk-create-jobs','/profiles/OTHER','https://foreign.invalid'])await assert.rejects(provider.coupon.get(path));
 assert.equal(calls.length,0);
});
test('default-disabled route performs no RPC or provider request',async()=>{
 let calls=0;const deps={store:{async rpc(){calls++;throw Error();}},provider:{}};
 const response=await handleCouponBootstrapRequest(new Request('https://synthetic.invalid/api/internal/coupon-bootstrap',{method:'POST'}),{...config,mode:'disabled'},deps);
 assert.equal(response.status,503);assert.equal(calls,0);
});
test('browser-origin and injected arbitrary protocol are rejected without side effects',async()=>{
 let calls=0;const deps={store:{async rpc(){calls++;throw Error();}},provider:{}};
 for(const [headers,body]of [
 [{Origin:'https://synthetic.invalid'},{action:'dispatch',permitId:config.businessId}],
 [{},{action:'dispatch',permitId:config.businessId,protocol:{claim:'bypass'}}],
 [{},{action:'welcome',businessId:config.businessId,couponId:config.businessId}],
 ]){
  const request=new Request('https://synthetic.invalid/api/internal/coupon-bootstrap',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.processKey,...headers},body:JSON.stringify(body)});
  const response=await handleCouponBootstrapRequest(request,config,deps);assert.ok([400,403].includes(response.status));
 }
 assert.equal(calls,0);
});
test('normal process activation cannot enable bootstrap; preview never inherits production keys',()=>{
 const env={SUPABASE_SECRET_KEY:'sb_secret_synthetic',COUPON_PROCESS_ENABLED:'true',COUPON_PROCESS_MODE:'live',
  COUPON_PROCESS_KEY:config.processKey,COUPON_KLAVIYO_ACCOUNT_ID:config.accountId,COUPON_KLAVIYO_READ_KEY:config.readKey,
  COUPON_KLAVIYO_EVENT_KEY:config.eventKey,COUPON_KLAVIYO_RECEIPT_KEY:config.receiptKey,COUPON_QR_ORIGIN:config.qrOrigin,COUPON_LIVE_APPROVAL_ID:config.approvalId};
 assert.equal(couponBootstrapConfig(env,'nazarrestaurantandbakery.com').mode,'disabled');
 assert.equal(couponBootstrapConfig({...env,COUPON_BOOTSTRAP_ENABLED:'true',COUPON_BOOTSTRAP_MODE:'live'},'preview.pages.dev').mode,'disabled');
});
test('provider normalization preserves original event identity and coupon content',()=>{
 const expected={coupon_id:config.businessId,expires_at:null,minimum_amount_cents:3000,channels:['dine_in','site_pickup','site_delivery']};
 const received={coupon_id:config.businessId,minimum_amount_cents:3000,channels:['dine_in','site_pickup','site_delivery'],$event_id:'original'};
 assert.equal(couponEventPropertiesMatch(received,expected,'original'),true);
 for(const patch of [{$event_id:'different'}, {coupon_id:'different'}, {minimum_amount_cents:0},
  {expires_at:'2030-01-01'}, {channels:[]}, {$flow:'unrelated'}, {coupon_id:undefined}]){
  assert.equal(couponEventPropertiesMatch({...received,...patch},expected,'original'),false);
 }
});
