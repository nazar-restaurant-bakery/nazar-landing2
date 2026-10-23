import test from 'node:test';
import assert from 'node:assert/strict';
import {handleWrite,previewHash} from '../supabase/functions/ops-write/index.ts';
const business='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222',user='33333333-3333-4333-8333-333333333333',id='44444444-4444-4444-8444-444444444444';
const env={SUPABASE_URL:'https://'+'s'.repeat(20)+'.supabase.co',SUPABASE_ANON_KEY:'synthetic-public'};
function harness(mode='ok'){
 const seen=[];let claims=0,finals=0;
 const fetch=async(url,init)=>{
  const u=new URL(url);assert.equal(u.origin,env.SUPABASE_URL);assert.equal(init.redirect,'error');seen.push(u.pathname);
  if(u.pathname==='/auth/v1/user')return mode==='invalid-jwt'?new Response('',{status:401}):Response.json({id:user});
  const name=u.pathname.split('/').at(-1),args=JSON.parse(init.body);
  if(mode==='forbidden')return Response.json({code:'42501',message:'private secret message'},{status:403});
  if(mode==='disabled')return Response.json({code:'55000'},{status:400});
  const row={business_id:business,id,target_id:target,preview_hash:await previewHash(business,target),status:'approved',safe_result_code:'approved',expires_at:'2099-01-01T00:00:00Z'};
  assert.equal(init.headers.Authorization,'Bearer synthetic-jwt');
  if(name==='ops_write_preview')return Response.json({...row,status:'previewed'});
  if(name==='ops_write_status'||name==='ops_write_approve')return Response.json(row);
  assert.equal(init.headers.apikey,env.SUPABASE_ANON_KEY);
  assert.equal(init.headers.Authorization,'Bearer synthetic-jwt');
  assert.equal('p_staff_id' in args,false);
  if(name==='ops_write_execute_dry_run'){claims++;if(mode==='timeout')throw new Error('private credential');if(mode==='replay')return Response.json(null);finals++;return Response.json({...row,status:'succeeded',safe_result_code:'dry_run_succeeded'});}
  throw Error('unexpected RPC');
 };
 const invoke=(body,auth='Bearer synthetic-jwt')=>handleWrite(new Request('https://example.invalid',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:auth}:{})},body:JSON.stringify({business_id:business,target_id:target,action_id:id,idempotency_key:id,...body})}),env,fetch);
 return {invoke,seen,get claims(){return claims;},get finals(){return finals;}};
}
test('write preview hash binds tenant, target and canonical before/after summary',async()=>{
 assert.notEqual(await previewHash(business,target),await previewHash(target,target));
 assert.notEqual(await previewHash(business,target),await previewHash(business,id));
});
test('dry-run wrapper preserves verified user JWT, supplies no actor override or service key',async()=>{
 const h=harness(),hash=await previewHash(business,target);
 for(const operation of ['preview','approve','execute']){
  const r=await h.invoke({operation,preview_hash:hash});assert.equal(r.status,200);
  assert.equal(r.headers.get('Access-Control-Allow-Headers'),'authorization,apikey,content-type,x-client-info');
  assert.doesNotMatch(await r.text(),/synthetic-service|claim_token/);
 }
 assert.equal(h.claims,1);assert.equal(h.finals,1);
});
test('missing JWT, invalid JWT and unauthorized staff cannot claim or finalize',async()=>{
 const missing=harness();assert.equal((await missing.invoke({operation:'preview'},'')).status,401);assert.equal(missing.seen.length,0);
 for(const mode of ['invalid-jwt','forbidden']){
  const h=harness(mode),r=await h.invoke({operation:'execute',preview_hash:await previewHash(business,target)});
  assert.equal(r.status,mode==='invalid-jwt'?401:403);assert.equal(h.claims,0);assert.equal(h.finals,0);assert.doesNotMatch(await r.text(),/private/);
 }
});
test('changed preview/target and unexpected body fields never claim',async()=>{
 const h=harness();assert.equal((await h.invoke({operation:'execute',preview_hash:'0'.repeat(64)})).status,409);
 assert.equal((await h.invoke({operation:'preview',message:'must not store'})).status,400);assert.equal(h.claims,0);
});
test('kill switch, consumed approval and timeout never trigger a blind retry',async()=>{
 for(const mode of ['disabled','replay','timeout']){
  const h=harness(mode),r=await h.invoke({operation:'execute',preview_hash:await previewHash(business,target)});
  assert.equal(r.status,mode==='timeout'?503:409);assert.ok(h.claims<=1);assert.ok(h.finals<=1);
  assert.doesNotMatch(await r.text(),/private credential/);
 }
});

test('browser actor parameters are rejected rather than trusted',async()=>{
 const h=harness();const r=await h.invoke({operation:'execute',preview_hash:await previewHash(business,target),p_staff_id:user});
 assert.equal(r.status,400);assert.equal(h.seen.length,0);
});

test('Supabase browser preflight permits x-client-info without invoking auth or RPC',async()=>{
 const origin='https://www.nazarrestaurantandbakery.com';
 const requested='authorization,apikey,content-type,x-client-info';
 const r=await handleWrite(new Request('https://example.invalid',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':requested}}),env,async()=>{assert.fail('preflight must not call auth or RPC');});
 assert.equal(r.status,204);
 assert.equal(r.headers.get('Access-Control-Allow-Origin'),origin);
 assert.equal(r.headers.get('Access-Control-Allow-Headers'),requested);
 assert.equal(r.headers.get('Access-Control-Allow-Methods'),'POST,OPTIONS');
 assert.equal(r.headers.get('Vary'),'Origin');
 assert.equal(await r.text(),'');
});

test('POST responses retain the preflight header list and still require a JWT',async()=>{
 const r=await handleWrite(new Request('https://example.invalid',{method:'POST',headers:{Origin:'https://www.nazarrestaurantandbakery.com','Content-Type':'application/json','x-client-info':'synthetic-client'},body:'{}'}),env,async()=>{assert.fail('missing JWT must not call auth or RPC');});
 assert.equal(r.status,401);
 assert.equal(r.headers.get('Access-Control-Allow-Headers'),'authorization,apikey,content-type,x-client-info');
 assert.deepEqual(await r.json(),{code:'unauthorized'});
});

test('adding the Supabase client header does not permit an untrusted origin',async()=>{
 const r=await handleWrite(new Request('https://example.invalid',{method:'OPTIONS',headers:{Origin:'https://untrusted.invalid','Access-Control-Request-Headers':'x-client-info'}}),env,async()=>{assert.fail('untrusted origin must not call auth or RPC');});
 assert.equal(r.status,403);
 assert.deepEqual(await r.json(),{code:'forbidden'});
});
