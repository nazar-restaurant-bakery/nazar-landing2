import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../functions/api/signup.ts';
const originalFetch=globalThis.fetch, originalError=console.error;
afterEach(()=>{ globalThis.fetch=originalFetch; console.error=originalError; });
const payload={kind:'catering',name:'PRIVATE CUSTOMER',email:'private@example.invalid',phone:'',
  turnstileToken:'PRIVATE CHALLENGE',requestId:'0c8f9e8d-5a8b-4f1f-8afa-5916392b8d05',
  eventDate:'2026-10-20',guests:'25',message:'PRIVATE MESSAGE'};
function setup({enabled=false,claim=false,recordFails=false,recordHttpFails=false,deliveryFails=false,challengeFails=false,invalidChallenge=false,dbFails=true}={}){
  const calls=[],background=[],logs=[];
  console.error=(line)=>logs.push(line);
  globalThis.fetch=async(url,init)=>{
    calls.push({url:String(url),body:JSON.parse(init.body),signal:init.signal});
    if(String(url).includes('siteverify'))return challengeFails?new Response('',{status:503}):Response.json({success:!invalidChallenge,hostname:'www.nazarrestaurantandbakery.com'});
    if(String(url).includes('submit_signup_once'))return new Response('',{status:dbFails?503:200});
    if(String(url).includes('record_form_error_v1')){if(recordFails)throw new Error('PRIVATE PROVIDER MESSAGE');return recordHttpFails?new Response('PRIVATE PROVIDER MESSAGE',{status:503}):Response.json(claim)}
    if(String(url).includes('api.cloudflare.com')){if(deliveryFails)throw new Error('PRIVATE PROVIDER MESSAGE');return Response.json({success:true,result:{queued:['ctnazarbakery@gmail.com']}})}
    if(String(url).includes('finish_form_error_alert_v1')||String(url).includes('resolve_form_errors_v1')||String(url).includes('claim_catering_staff_notification_v1'))return Response.json(null);
    throw new Error('Unexpected mock call');
  };
  const context={request:new Request('https://www.nazarrestaurantandbakery.com/api/signup',{
    method:'POST',headers:{Origin:'https://www.nazarrestaurantandbakery.com','Content-Type':'application/json'},body:JSON.stringify(payload)}),
    env:{SUPABASE_SECRET_KEY:'sb_secret_PRIVATE',TURNSTILE_SECRET_KEY:'PRIVATE SECRET',CLOUDFLARE_EMAIL_SEND_TOKEN:'PRIVATE SEND TOKEN',FORM_ERROR_ALERTS_ENABLED:String(enabled)},
    waitUntil(promise){background.push(promise)}};
  return {calls,background,logs,context};
}
test('failed signup has opaque reference, safe durable metadata and alerts default off',async()=>{
  const s=setup();const r=await onRequestPost(s.context);const body=await r.json();await Promise.all(s.background);
  assert.equal(r.status,503);assert.match(body.error_id,/^[0-9a-f-]{36}$/);assert.equal(r.headers.get('X-Nazar-Error-ID'),body.error_id);
  assert.ok(Number.isFinite(Date.parse(body.occurred_at)));
  const record=s.calls.find(c=>c.url.includes('record_form_error_v1'));
  assert.equal(record.body.p_id,body.error_id);assert.equal(record.body.p_request_id,payload.requestId);assert.equal(record.body.p_claim_alert,false);
  assert.equal(record.body.p_stage,'database');assert.equal(record.body.p_code,'database_unavailable');
  assert.equal(s.calls.filter(c=>c.url.includes('api.cloudflare.com')).length,0);
  assert.ok(!JSON.stringify([...s.logs,record.body]).includes('PRIVATE'));
  assert.ok(s.calls.find(c=>c.url.includes('siteverify')).signal instanceof AbortSignal);
  assert.ok(s.calls.find(c=>c.url.includes('submit_signup_once')).signal instanceof AbortSignal);
});
test('claimed alert sends only fixed staff recipient and safe metadata; queued is accepted',async()=>{
  const s=setup({enabled:true,claim:true});const r=await onRequestPost(s.context);await Promise.all(s.background);
  assert.equal(r.status,503);
  const email=s.calls.find(c=>c.url.includes('api.cloudflare.com')).body;
  assert.equal(email.to,'ctnazarbakery@gmail.com');assert.equal(email.subject,'Nazar form needs attention');
  assert.ok(!JSON.stringify(email).includes('PRIVATE'));assert.ok(!email.text.includes(payload.requestId));
  assert.equal(s.calls.find(c=>c.url.includes('finish_form_error_alert_v1')).body.p_accepted,true);
});
test('a suppressed atomic claim never sends email',async()=>{
  const s=setup({enabled:true,claim:false});await onRequestPost(s.context);await Promise.all(s.background);
  assert.equal(s.calls.filter(c=>c.url.includes('api.cloudflare.com')).length,0);
});
test('alert delivery failure is recorded without leaking exceptions or changing form response',async()=>{
  const s=setup({enabled:true,claim:true,deliveryFails:true});const r=await onRequestPost(s.context);await Promise.all(s.background);
  assert.equal(r.status,503);assert.equal(s.calls.find(c=>c.url.includes('finish_form_error_alert_v1')).body.p_accepted,false);
  assert.ok(!s.logs.join('').includes('PRIVATE'));
});
test('complete database outage preserves safe runtime reference and does not send ungated email',async()=>{
  const s=setup({enabled:true,recordFails:true});const r=await onRequestPost(s.context);const body=await r.json();await Promise.all(s.background);
  assert.equal(r.status,503);assert.ok(s.logs.every(line=>!line.includes('PRIVATE')));
  assert.equal(JSON.parse(s.logs.at(-1)).id,body.error_id);
  assert.equal(s.calls.filter(c=>c.url.includes('api.cloudflare.com')).length,0);
});
test('verification provider outage is logged separately; rejected challenge is not a server incident',async()=>{
  let s=setup({challengeFails:true});let r=await onRequestPost(s.context);await Promise.all(s.background);
  assert.equal(r.status,503);assert.equal(s.calls.find(c=>c.url.includes('record_form_error_v1')).body.p_stage,'challenge');
  assert.ok(!s.calls.some(c=>c.url.includes('submit_signup_once')));
  s=setup({invalidChallenge:true});r=await onRequestPost(s.context);await Promise.all(s.background);
  assert.equal(r.status,403);assert.equal(s.logs.length,0);assert.equal(s.background.length,0);
});
test('an HTTP logging failure is recorded safely and never sends an ungated email',async()=>{
  const s=setup({enabled:true,recordHttpFails:true});const r=await onRequestPost(s.context);await Promise.all(s.background);
  assert.equal(r.status,503);assert.equal(JSON.parse(s.logs.at(-1)).event,'nazar_form_error_log_unavailable');
  assert.ok(!s.logs.join('').includes('PRIVATE'));assert.ok(!s.calls.some(c=>c.url.includes('api.cloudflare.com')));
});
test('successful retry resolves only its request; logging remains outside successful response',async()=>{
  const s=setup({dbFails:false});const r=await onRequestPost(s.context);await Promise.all(s.background);
  assert.equal(r.status,200);assert.deepEqual(await r.json(),{code:'accepted'});
  assert.deepEqual(s.calls.find(c=>c.url.includes('resolve_form_errors_v1')).body,{p_request_id:payload.requestId});
  assert.equal(s.logs.length,0);
});
