import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fixture} from './fixtures/signupRewardCouponsNative.mjs';
import {handleDoiWebhook} from '../functions/_lib/vipDoiWebhook.ts';
test('actual K4/K10/order18/DOI SQL: automatic issuance, replay/concurrency, RLS, suppression, isolation and no send',async()=>{
 const h=await fixture(),checks=[];
 const migration=await readFile(new URL('../supabase/migrations/20261022000200_vip_doi_webhook.sql',import.meta.url),'utf8');
 try{
  let r=h.raw(migration);assert.notEqual(r.status,0);assert.match(r.stderr,/DOI_REQUIRES_ORDER18/);checks.push('missing order18 rejects before creation');
  const predecessor=await readFile(new URL('./fixtures/siteOrderFoundation.order18.sql',import.meta.url));
  assert.equal(createHash('sha256').update(predecessor).digest('hex'),'c8d92ad4a69b0c46ea3578054f92bd2aa675bd92ea5e4e2e161f040445aa0953');
  r=h.raw(predecessor.toString('utf8'));assert.equal(r.status,0,r.stderr);
  const operator=JSON.parse(await readFile(new URL('./fixtures/vipDoiOperatorChecks.json',import.meta.url),'utf8'));
  const catalog=conditions=>h.sql('SELECT json_build_array('+conditions.map(c=>'COALESCE(('+c+'),false)').join(',')+')');
  assert.ok(catalog(operator.preconditions).every(Boolean));
  const old=h.sql(`SELECT json_build_object('body',md5(prosrc),'acl',proacl) FROM pg_proc WHERE oid='public.coupon_record_confirmed_vip_v1(uuid,uuid,uuid,text,timestamptz,timestamptz,jsonb)'::regprocedure`);
  r=h.raw(migration);assert.equal(r.status,0,r.stderr);
  assert.ok(catalog(operator.postconditions).every(Boolean));checks.push('same operator pre/post catalog conditions pass on actual PostgreSQL');
  assert.deepEqual(h.sql(`SELECT json_build_object('body',md5(prosrc),'acl',proacl) FROM pg_proc WHERE oid='public.coupon_record_confirmed_vip_v1(uuid,uuid,uuid,text,timestamptz,timestamptz,jsonb)'::regprocedure`),old);checks.push('accepted issuer bytes and ACL unchanged');
  const match=(b,e,l='SYNTHETIC_VIP')=>h.sql(`SELECT public.vip_doi_webhook_match_v1('${b}',${h.literal(e)},'${l}')`,{service:true});
  const store={async rpc(name,args){
   assert.ok(['vip_doi_webhook_match_v1','vip_doi_webhook_confirm_v1','vip_doi_webhook_observe_v1','coupon_confirmation_context_v1','coupon_record_negative_v1'].includes(name));
   const params=Object.entries(args).map(([k,v])=>k+'=>'+(v===null?'NULL':typeof v==='object'?h.literal(JSON.stringify(v))+'::jsonb':h.literal(v)));
   return h.sql('SELECT public.'+name+'('+params.join(',')+')',{service:true});
  }};
  const config={enabled:true,key:'synthetic_key_'.repeat(4),flowId:'SYNTHETIC_FLOW',listId:'SYNTHETIC_VIP',coupon:{mode:'mock',businessId:h.config.businessId,accountId:'SYNTHETIC_ACCOUNT'}};
  function person(){
   h.reward({is_test:false});const c=h.customer({status:'pending_review'}),email=c+'@synthetic.test';
   h.sql(`UPDATE core.customers SET is_test=false,email='${email}',identity_key='email:${email}' WHERE id='${c}'`);
   const s=h.signup(c,{createdAt:new Date(Date.now()-60000).toISOString()}),time=new Date(Date.now()-10000).toISOString();
   let consent='SUBSCRIBED',doi=true;
   const provider={mode:'mock',async get(path){
    if(path==='/accounts')return {data:[{id:'SYNTHETIC_ACCOUNT'}]};
    if(path==='/lists/SYNTHETIC_VIP')return {data:{id:'SYNTHETIC_VIP',attributes:{opt_in_process:'double_opt_in'}}};
    return {data:[{id:'PROFILE_'+c.replaceAll('-',''),attributes:{email,subscriptions:{email:{marketing:{consent,can_receive_email_marketing:consent==='SUBSCRIBED',double_optin:doi,consent_timestamp:time,suppression:[],list_suppressions:[]}}}}}]};
   },async event(){assert.fail('email/event forbidden');},async eventAccount(){assert.fail('event account forbidden');}};
   const req=()=>new Request('https://owned.invalid/api/webhooks/vip-doi',{method:'POST',headers:{Authorization:'Bearer '+config.key,'X-Klaviyo-Flow-ID':config.flowId,'Content-Type':'application/json'},body:JSON.stringify({version:1,email,listId:config.listId})});
   return {c,s,email,time,provider,run:()=>handleDoiWebhook(req(),config,{store,provider}),negative:()=>{consent='UNSUBSCRIBED';},unconfirmed:()=>{doi=false;}};
  }
  const a=person();assert.equal(h.coupon(a.c),null);assert.equal((await a.run()).status,200);assert.ok(h.coupon(a.c));assert.equal((await a.run()).status,200);
  assert.equal(h.sql(`SELECT count(*) FROM core.campaign_coupons WHERE customer_id='${a.c}'`),1);
  assert.equal(h.sql(`SELECT count(*) FROM core.vip_doi_webhook_receipts WHERE business_id='${h.config.businessId}'`),1);
  assert.equal(h.sql('SELECT count(*) FROM core.message_log'),0);checks.push('authenticated synthetic Flow callback -> existing DOI verifier -> one coupon/outbox; replay one receipt; zero sends');
  const b=person();b.unconfirmed();assert.equal((await b.run()).status,503);assert.equal(h.coupon(b.c),null);
  assert.equal(h.sql(`SELECT count(*) FROM core.vip_doi_webhook_attempts WHERE status='retryable' AND safe_code='verification_unconfirmed'`),1);checks.push('checkbox without DOI produces no coupon and durable safe retry record');
  const c=person();c.negative();assert.equal((await c.run()).status,200);assert.equal(h.coupon(c.c),null);
  assert.equal(h.sql(`SELECT email_status='unsubscribed' AND email_suppressed_at IS NOT NULL FROM core.customers WHERE id='${c.c}'`),true);checks.push('provider unsubscribe remains K4 protected, no coupon');
  const d=person();h.sql(`UPDATE core.customers SET email_status='unsubscribed' WHERE id='${d.c}'`);assert.equal((await d.run()).status,200);assert.equal(h.coupon(d.c),null);checks.push('local unsubscribe cannot be lifted by callback');
  const ambiguous=person();h.signup(ambiguous.c);assert.equal(match(h.config.businessId,ambiguous.email).code,'local_request_ambiguous');assert.equal(h.coupon(ambiguous.c),null);
  assert.equal(match(h.config.secondBusinessId,a.email).code,'local_request_unmatched');checks.push('ambiguous signup and other tenant are never guessed');
  const marked=h.customer({status:'pending_review'});h.signup(marked);const markedEmail=h.sql(`SELECT to_jsonb(email) FROM core.customers WHERE id='${marked}'`);assert.equal(match(h.config.businessId,markedEmail).allowed,false);checks.push('hosted-style is_test records excluded by matcher');
  const concurrent=person(),hash=createHash('sha256').update(concurrent.email).digest('hex');
  const evidence={source:'klaviyo',listId:'SYNTHETIC_VIP',emailSha256:hash,doubleOptIn:true,canReceiveEmailMarketing:true,consent:'SUBSCRIBED'};
  const call=`SELECT public.vip_doi_webhook_confirm_v1('${h.config.businessId}','${concurrent.c}','${concurrent.s}','PROFILE_RACE','${concurrent.time}',clock_timestamp(),${h.literal(JSON.stringify(evidence))}::jsonb,'SYNTHETIC_ACCOUNT')`;
  const serviceCall="SET request.jwt.claim.role='service_role';SET ROLE service_role;"+call;
  const one=h.session(serviceCall,'doi_race_one'),two=h.session(serviceCall,'doi_race_two');await Promise.all([one.promise,two.promise]);
  assert.equal(h.sql(`SELECT count(*) FROM core.campaign_coupons WHERE customer_id='${concurrent.c}'`),1);
  assert.equal(h.sql(`SELECT count(*) FROM core.vip_doi_webhook_receipts WHERE confirmation_evidence_id IN(SELECT id FROM core.vip_confirmation_evidence WHERE customer_id='${concurrent.c}')`),1);checks.push('two simultaneous database sessions commit one coupon and one receipt');
  for(const role of ['anon','authenticated']){
   assert.notEqual(h.raw(`SELECT public.vip_doi_webhook_match_v1('${h.config.businessId}','${a.email}','SYNTHETIC_VIP')`,{role}).status,0);
   assert.notEqual(h.raw(call,{role}).status,0);
   assert.notEqual(h.raw(`SELECT public.vip_doi_webhook_observe_v1('${h.config.businessId}',repeat('a',64),'confirmed','confirmation_recorded')`,{role}).status,0);
  }
  for(const role of ['anon','authenticated','service_role'])for(const table of ['vip_doi_webhook_receipts','vip_doi_webhook_attempts'])assert.notEqual(h.raw('SELECT * FROM core.'+table,{role}).status,0);
  assert.notEqual(h.raw('DELETE FROM core.vip_doi_webhook_receipts').status,0);
  assert.equal(h.sql(`SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN('core.vip_doi_webhook_receipts'::regclass,'core.vip_doi_webhook_attempts'::regclass)`),true);checks.push('anonymous/staff functions denied; all direct roles denied; RLS + immutable audit');
  const output=new URL('../20_Yonetim/Teslim_Raporlari/K10_DOI_Webhook_kanit/',import.meta.url);await mkdir(output,{recursive:true});
  await writeFile(new URL('native.json',output),JSON.stringify({checks,passed:checks.length,hosted:false,providerCalls:0,emails:0,scope:'OWNED_LOOPBACK_POSTGRES_18_6_SYNTHETIC_ONLY',run:h.config.run},null,2)+'\n');console.log(JSON.stringify({passed:checks.length,checks}));
 }finally{await h.stop();}
});
