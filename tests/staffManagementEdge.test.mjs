import test from 'node:test';import assert from 'node:assert/strict';
import {inviteHandler} from '../supabase/functions/staff-manage-invite/index.ts';
const biz='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222',inv='33333333-3333-4333-8333-333333333333',token='44444444-4444-4444-8444-444444444444',target='55555555-5555-4555-8555-555555555555';
const env={SUPABASE_URL:'https://ssssssssssssssssssss.supabase.co',SUPABASE_ANON_KEY:'synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service'};
const payload={businessId:biz,email:'staff@example.invalid',role:'staff',requestId:'66666666-6666-4666-8666-666666666666'};
const request=(body=payload,headers={})=>new Request('https://edge.invalid/',{method:'POST',headers:{Origin:'https://shop.example.invalid',Authorization:'Bearer synthetic-user-jwt',...headers},body:JSON.stringify(body)});
function fixture(options={}){
 const calls=[];let sending=false,finished=null,mailCalls=0;
 const fetcher=async(input,init={})=>{
  const url=new URL(String(input)),headers=new Headers(init.headers),body=init.body?JSON.parse(init.body):null;calls.push({path:url.pathname,body,key:headers.get('apikey'),authorization:headers.get('Authorization')});
  assert.equal(url.origin,env.SUPABASE_URL);const ok=data=>Response.json(data);
  if(url.pathname==='/auth/v1/user'){assert.equal(headers.get('apikey'),env.SUPABASE_ANON_KEY);return options.invalidJwt?Response.json({}, {status:401}):ok({id:actor});}
  const name=url.pathname.split('/').at(-1);
  if(name==='staff_management_context_v1'){if(options.denied)return Response.json({}, {status:403});return ok({inviteEnabled:!options.disabled,redirectUrl:'https://shop.example.invalid/staff/system'});}
  if(name==='staff_invite_prepare_v1'){assert.deepEqual(body,{p_business_id:biz,p_email:payload.email,p_role:'staff',p_request_key:payload.requestId});return ok(finished||{inviteId:inv,code:'prepared',state:'prepared'});}
  if(name==='staff_invite_gate_v1'){assert.equal(headers.get('Authorization'),'Bearer synthetic-user-jwt');if(sending)return ok(null);sending=true;return ok({inviteId:inv,claimToken:token});}
  if(name==='staff_invite_context_v1'){assert.equal(headers.get('apikey'),env.SUPABASE_SERVICE_ROLE_KEY);assert.deepEqual(body,{p_business_id:biz,p_invite_id:inv,p_claim_token:token});return ok(options.revoked?null:{email:payload.email,redirectUrl:'https://shop.example.invalid/staff/system',existingUserId:options.existing?target:null});}
  if(url.pathname==='/auth/v1/invite'){mailCalls++;assert.equal(headers.get('Authorization'),'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY);assert.deepEqual(body,{email:payload.email});assert.equal(url.searchParams.get('redirect_to'),'https://shop.example.invalid/staff/system');
   if(options.timeout)throw Error('synthetic timeout');if(options.authStatus)return Response.json({}, {status:options.authStatus});return ok({id:target});}
  if(name==='staff_invite_finish_v1'){assert.equal(headers.get('Authorization'),'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY);assert.equal(body.p_claim_token,token);if(finished)return ok(finished);
   finished={state:body.p_outcome,code:body.p_outcome==='existing'?'existing_account_added':body.p_outcome==='unknown'?'invite_unknown':body.p_outcome==='failed'?'invite_rejected':'invited'};
   if(options.lostFinalize&&!options.lostFinalizeUsed){options.lostFinalizeUsed=true;throw Error('synthetic lost DB reply');}return ok(finished);}
  throw Error('Unexpected synthetic request');
 };
 return{calls,fetcher,get mailCalls(){return mailCalls;}};
}
test('JWT + persisted prepare/gate bind one Auth invite; service key never used for user permission RPC',async()=>{
 const f=fixture(),r=await inviteHandler(f.fetcher)(request(),env);assert.equal(r.status,200);assert.deepEqual(await r.json(),{code:'invited'});assert.equal(f.mailCalls,1);
 for(const c of f.calls.filter(c=>/context_v1|prepare_v1|gate_v1/.test(c.path)&&!c.path.endsWith('staff_invite_context_v1')))assert.equal(c.authorization,'Bearer synthetic-user-jwt');
 assert.ok(f.calls.every(c=>!c.body||!Object.hasOwn(c.body,'p_staff_id')));
});
test('concurrent/replayed dispatcher cannot send twice after atomic delivery gate',async()=>{
 const f=fixture(),handler=inviteHandler(f.fetcher);const results=await Promise.all([handler(request(),env),handler(request(),env)]);assert.equal(f.mailCalls,1);assert.ok(results.some(r=>r.status===200));await handler(request(),env);assert.equal(f.mailCalls,1);
});
for(const [options,status,mails,code] of [[{invalidJwt:true},401,0,'unauthorized'],[{denied:true},403,0,'forbidden'],[{disabled:true},503,0,'configuration_required'],[{revoked:true},409,0,'invite_rejected'],[{existing:true},200,0,'existing_account_added'],[{timeout:true},409,1,'invite_unknown'],[{authStatus:500},409,1,'invite_unknown'],[{authStatus:422},409,1,'invite_rejected'],[{lostFinalize:true},200,1,'invited']])test('safe outcome '+JSON.stringify(options),async()=>{
 const f=fixture(options),r=await inviteHandler(f.fetcher)(request(),env);assert.equal(r.status,status);assert.equal((await r.json()).code,code);assert.equal(f.mailCalls,mails);
 if(options.timeout||options.authStatus===500){await inviteHandler(f.fetcher)(request(),env);assert.equal(f.mailCalls,1);}
});
test('spoofed actor/arbitrary redirect/business, no token, wrong origin and malformed payload make no invitation',async()=>{
 for(const [body,headers,status] of [[{...payload,actorId:actor},{},400],[{...payload,redirectUrl:'https://evil.invalid'},{},400],[{...payload,role:'platform_operator'},{},400],[payload,{Authorization:''},401],[payload,{Origin:'http://shop.example.invalid'},403],[payload,{Origin:'https://other.example.invalid'},403]]){
  const f=fixture(),r=await inviteHandler(f.fetcher)(request(body,headers),env);assert.equal(r.status,status);assert.equal(f.mailCalls,0);
 }
});
