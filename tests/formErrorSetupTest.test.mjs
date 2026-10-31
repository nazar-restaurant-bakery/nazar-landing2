import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {PRODUCTION_BUSINESS_ID} from '../src/lib/deploymentEnvironment.ts';
const compile=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const data=s=>`data:text/javascript;base64,${Buffer.from(s).toString('base64')}`;
const helper=data(compile(await readFile(new URL('../functions/api/signup.ts',import.meta.url),'utf8'))
 .replace('"../../src/lib/deploymentEnvironment.ts"',JSON.stringify(new URL('../src/lib/deploymentEnvironment.ts',import.meta.url).href))
 .replace('"../_lib/resendEmail.ts"',JSON.stringify(new URL('../functions/_lib/resendEmail.ts',import.meta.url).href)));
const endpoint=compile(await readFile(new URL('../functions/api/staff/form-error-setup-test.ts',import.meta.url),'utf8'))
 .replace('"../signup"',JSON.stringify(helper))
 .replace('"../../../src/lib/deploymentEnvironment.ts"',JSON.stringify(new URL('../src/lib/deploymentEnvironment.ts',import.meta.url).href));
const {onRequestPost,onRequest}=await import(data(endpoint));
const original=globalThis.fetch; afterEach(()=>{globalThis.fetch=original});
function setup({staff=true,claim=true,deliveryFails=false,enabled=true}={}){
 const calls=[];let attempted=false;
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init.body),headers:init.headers});
  if(String(url).includes('staff_business_authorized_v1'))return Response.json(typeof staff==='function'?staff(JSON.parse(init.body)):staff);
  if(String(url).includes('record_form_error_v1')){const result=claim&&!attempted;attempted=true;return Response.json(result)}
  if(String(url).includes('api.resend.com')){if(deliveryFails)throw new Error('uncertain transport');return Response.json({id:"re_test_1"})}
  return Response.json(true);
 };
 const env={VITE_SUPABASE_ANON_KEY:'mock',SUPABASE_SECRET_KEY:'sb_secret_mock',RESEND_API_KEY:'mock',FORM_ERROR_ALERTS_ENABLED:String(enabled)};
 const request=(changes={})=>new Request('https://www.nazarrestaurantandbakery.com/api/staff/form-error-setup-test',{method:'POST',headers:{Origin:'https://www.nazarrestaurantandbakery.com','Content-Type':'application/json',Authorization:'Bearer fake-session-000000000000000000',...changes},body:'{}'});
 return {calls,env,request};
}
test('unsupported method and cross-origin calls cannot send',async()=>{const s=setup();assert.equal(onRequest().status,405);assert.equal((await onRequestPost({env:s.env,request:s.request({Origin:'https://elsewhere.invalid'})})).status,403);assert.equal(s.calls.length,0)});
test('missing session or disabled alerts cannot send',async()=>{let s=setup();assert.equal((await onRequestPost({env:s.env,request:s.request({Authorization:''})})).status,401);s=setup({enabled:false});assert.equal((await onRequestPost({env:s.env,request:s.request()})).status,503);assert.equal(s.calls.length,0)});
test('nonstaff authenticated session is denied before claiming',async()=>{const s=setup({staff:false});assert.equal((await onRequestPost({env:s.env,request:s.request()})).status,403);assert.equal(s.calls.length,1)});
test('platform read permission cannot authorize a configured-business email test write',async()=>{
 const s=setup({staff:args=>args.p_operation==='crm.read'});
 assert.equal((await onRequestPost({env:s.env,request:s.request()})).status,403);
 assert.equal(s.calls.length,1);
 assert.ok(s.calls[0].url.endsWith('/rpc/staff_business_authorized_v1'));
 assert.deepEqual(s.calls[0].body,{p_business_id:PRODUCTION_BUSINESS_ID,p_operation:'crm.write'});
 assert.equal(s.calls.some(call=>/record_form_error|api.resend.com/.test(call.url)),false);
});
test('isolated configuration never falls back to the Production alert sender',async()=>{
 const s=setup();s.env.APP_ENV='isolated-test';
 assert.equal((await onRequestPost({env:s.env,request:s.request()})).status,503);
 assert.equal(s.calls.length,0);
});
test('one accepted test has fixed recipient, explicit label and cannot send twice',async()=>{const s=setup();const first=await onRequestPost({env:s.env,request:s.request()});assert.equal(first.status,200);assert.equal((await first.json()).code,'accepted');assert.equal((await onRequestPost({env:s.env,request:s.request()})).status,409);const messages=s.calls.filter(c=>c.url.includes('api.resend.com'));assert.equal(messages.length,1);assert.deepEqual(messages[0].body.to,['ctnazarbakery@gmail.com']);assert.equal(messages[0].url,'https://api.resend.com/emails');assert.equal(messages[0].headers['Idempotency-Key'],'d8ef70a3-04b7-49c4-a2b9-3b9137c8c802');assert.equal(messages[0].headers.Authorization,'Bearer mock');assert.equal(messages[0].body.from,'Nazar Restaurant & Bakery <notifications@mail.nazarrestaurantandbakery.com>');assert.match(messages[0].body.subject,/^\[TEST\]/);assert.match(messages[0].body.text,/no customer submission/);assert.ok(s.calls.some(c=>c.url.includes('crm_resolve_form_error_v1')))});
test('rate-limited test never reaches delivery API',async()=>{const s=setup({claim:false});assert.equal((await onRequestPost({env:s.env,request:s.request()})).status,409);assert.ok(!s.calls.some(c=>c.url.includes('api.resend.com')))});
test('uncertain delivery is not retried by a second request',async()=>{const s=setup({deliveryFails:true});assert.equal((await onRequestPost({env:s.env,request:s.request()})).status,503);assert.equal((await onRequestPost({env:s.env,request:s.request()})).status,409);assert.equal(s.calls.filter(c=>c.url.includes('api.resend.com')).length,1)});
test('missing RESEND_API_KEY is not ready and sends nothing',async()=>{const s=setup();delete s.env.RESEND_API_KEY;const r=await onRequestPost({env:s.env,request:s.request()});assert.equal(r.status,503);assert.equal((await r.json()).code,'alerts_not_ready');assert.equal(s.calls.length,0)});
