import assert from 'node:assert/strict';
import {afterEach,test} from 'node:test';
import {onRequestPost} from '../functions/api/staff/klaviyo-status.ts';
import {validEmailStatusResult} from '../src/lib/crmEmailStatus.ts';
const original=globalThis.fetch;
afterEach(()=>{globalThis.fetch=original});
const env={VITE_SUPABASE_ANON_KEY:'sb_publishable_test',KLAVIYO_CRM_READ_KEY:'pk_read_test',SUPABASE_SECRET_KEY:'sb_secret_test'};
const id='019cf7d5-0d65-4273-8f98-716a2a0e45be',email='synthetic@example.invalid';
const token=`Bearer ${'a'.repeat(40)}`;
const saved={status:'unsubscribed',checkedAt:'2026-10-15T12:00:00Z',blocked:true,blockedStatus:'unsubscribed',blockedAt:'2026-10-15T12:00:00Z'};
const profile=(marketing={})=>({id:'SYNTHETIC',attributes:{email,subscriptions:{email:{marketing:{consent:'SUBSCRIBED',can_receive_email_marketing:true,suppression:[],list_suppressions:[],...marketing}}}}});
function request(body={customerId:id},origin='https://www.nazarrestaurantandbakery.com'){return new Request('https://www.nazarrestaurantandbakery.com/api/staff/klaviyo-status',{method:'POST',headers:{Origin:origin,Authorization:token,'Content-Type':'application/json'},body:JSON.stringify(body)})}
function mock({global=[profile()],member=[profile()],context={email,saved:null,localStatus:'pending_review'},providerFailure=false,saveFailure=false}={}){
 const calls=[];globalThis.fetch=async(url,opts)=>{url=String(url);calls.push({url,opts});
  if(url.endsWith('/crm_klaviyo_status_v1')){assert.equal(opts.headers.Authorization,token);return Response.json(context)}
  if(url.endsWith('/record_klaviyo_status_v1')){
   assert.equal(opts.headers.apikey,'sb_secret_test');assert.equal(opts.headers.Authorization,undefined);
   if(saveFailure)return new Response('',{status:503});
   const body=JSON.parse(opts.body),negative=['unsubscribed','suppressed'].includes(body.p_status);
   assert.equal(body.p_email,email);assert.equal(body.p_customer_id,id);
   return Response.json({status:body.p_status,checkedAt:body.p_checked_at,blocked:negative,blockedAt:negative?body.p_checked_at:null,blockedStatus:negative?body.p_status:null})
  }
  assert.match(opts.headers.Authorization,/^Klaviyo-API-Key/);assert.ok(opts.signal);
  if(providerFailure)return new Response('',{status:429});
  const path=new URL(url).pathname;
  assert.equal(new URL(url).searchParams.get('filter'),`equals(email,"${email}")`);
  return Response.json({data:path.includes('/lists/')?member:global});
 };return calls;
}
test('a staff rejection stops before any provider access',async()=>{let n=0;globalThis.fetch=async()=>{n++;return new Response('',{status:403})};assert.equal((await onRequestPost({request:request(),env})).status,403);assert.equal(n,1)});
test('arbitrary email lookup and cross-origin access are rejected before network',async()=>{globalThis.fetch=()=>{throw Error('must not fetch')};assert.equal((await onRequestPost({request:request({email}),env})).status,400);assert.equal((await onRequestPost({request:request({customerId:id},'https://bad.invalid'),env})).status,403)});
test('a confirmed member is persisted without granting local consent',async()=>{const calls=mock();const r=await onRequestPost({request:request(),env}),b=await r.json();assert.equal(b.status,'confirmed');assert.equal(b.synced,true);assert.equal(b.saved.blocked,false);assert.equal(calls.length,4);assert.equal(r.headers.get('Cache-Control'),'private, no-store');assert.equal(validEmailStatusResult(b),true)});
test('an unsubscribed profile is recorded even after leaving the VIP list',async()=>{const calls=mock({global:[profile({consent:'UNSUBSCRIBED',suppression:undefined,list_suppressions:undefined})],member:[]});const b=await(await onRequestPost({request:request(),env})).json();assert.equal(b.status,'unsubscribed');assert.equal(b.saved.blocked,true);assert.equal(calls.filter(c=>c.url.includes('/lists/')).length,0);assert.equal(calls.length,3)});
test('VIP-list suppression blocks; a different list suppression alone does not',async()=>{mock({global:[profile({list_suppressions:[{list_id:'UeJynm'}]})]});let b=await(await onRequestPost({request:request(),env})).json();assert.equal(b.status,'suppressed');mock({global:[profile({list_suppressions:[{list_id:'OTHER'}]})]});b=await(await onRequestPost({request:request(),env})).json();assert.equal(b.status,'confirmed')});
test('global suppression blocks a subscribed profile',async()=>{mock({global:[profile({suppression:[{reason:'HARD_BOUNCE'}]})]});const b=await(await onRequestPost({request:request(),env})).json();assert.equal(b.status,'suppressed');assert.equal(b.saved.blocked,true)});
test('missing list membership is not an unsubscribe',async()=>{mock({member:[]});const b=await(await onRequestPost({request:request(),env})).json();assert.equal(b.status,'not_on_list');assert.equal(b.saved.blocked,false)});
test('a rate limit preserves earlier evidence and never records an assumed status',async()=>{const calls=mock({providerFailure:true,context:{email,saved,localStatus:'unsubscribed'}});const b=await(await onRequestPost({request:request(),env})).json();assert.equal(b.status,'unavailable');assert.deepEqual(b.saved,saved);assert.equal(b.localBlocked,true);assert.equal(b.synced,false);assert.equal(calls.length,2);assert.equal(validEmailStatusResult(b),true)});
test('CRM save failure is not reported as synchronized',async()=>{mock({saveFailure:true,global:[profile({consent:'UNSUBSCRIBED'})]});const b=await(await onRequestPost({request:request(),env})).json();assert.equal(b.status,'unsubscribed');assert.equal(b.code,'save_failed');assert.equal(b.synced,false);assert.equal(b.saved,null)});
test('malformed or ambiguous profiles cannot change CRM',async()=>{for(const global of [[profile(),profile()],[{id:'OTHER',attributes:{email:'other@example.invalid'}}],[profile({suppression:null})]]){const calls=mock({global});const b=await(await onRequestPost({request:request(),env})).json();assert.equal(b.status,'unavailable');assert.equal(calls.length,2)}});
test('known profile without explicit consent is not confirmed',async()=>{mock({global:[profile({consent:'NEVER_SUBSCRIBED'})]});const b=await(await onRequestPost({request:request(),env})).json();assert.equal(b.status,'pending')});
test('UI rejects malformed timestamps or a sync success with no durable record',()=>{const b={status:'unavailable',checkedAt:null,saved,localBlocked:true,synced:false};assert.equal(validEmailStatusResult(b),true);assert.equal(validEmailStatusResult({...b,status:'confirmed',checkedAt:'bad'}),false);assert.equal(validEmailStatusResult({...b,status:'confirmed',checkedAt:saved.checkedAt,saved:null,synced:true}),false)});
