// Complements the full baseline/K3/K4/K5 suite with actual current K9/K10 DDL.
// No reduced bootstrap schema, substituted relation, hosted URL or provider call.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,repo} from './fixtures/customerTestClassificationNative.mjs';
const h=await fixture({currentCouponSchema:true});after(()=>h.stop());
const q=h.literal,list='SYNTHETIC_NATIVE_VIP';
const inventory=JSON.parse(await readFile(join(repo,'tools/test-env/migration-manifest.json'),'utf8'));
const offer=randomUUID(),campaign=randomUUID();
h.sql(`INSERT INTO core.offers(id,business_id,name,starts_at,ends_at,active,is_test) VALUES('${offer}','${h.business}','Synthetic current-schema coupon',current_date-1,current_date+30,true,true);
 INSERT INTO core.campaigns(id,business_id,offer_id,name,benefit_type,target_clover_item_id,benefit_code,
 min_amount_cents,include_tax,include_tip,order_type_ids,starts_at,ends_at,tz_name,eligibility,
 max_units_per_order,period,max_total_units,status,is_test,campaign_kind,coupon_channels,coupon_order_type_map,vip_list_id)
 VALUES('${campaign}','${h.business}','${offer}','Synthetic current-schema coupon','item','NATIVESIMIT01','SIMIT',
 3000,false,false,ARRAY['NATIVEDINE01','NATIVEPICK01','NATIVEDELV01'],clock_timestamp()-interval '1 hour',NULL,'America/New_York','subscribed_only',
 1,'campaign',NULL,'active',true,'signup_reward',ARRAY['dine_in','site_pickup','site_delivery'],
 '{"NATIVEDINE01":"dine_in","NATIVEPICK01":"site_pickup","NATIVEDELV01":"site_delivery"}'::jsonb,'${list}')`);
function submit(email,name='Synthetic current-schema signup'){
 const request=randomUUID(),expression=`SELECT public.submit_signup_once('${request}','${h.business}',${q(name)},${q(email)},NULL,'website_vip_page',true,false,'{}',NULL)`;
 h.sql(expression,{service:true});
 return{...h.sql(`SELECT jsonb_build_object('customer',c.id,'signup',s.id,'customerTest',c.is_test,'signupTest',s.is_test,'name',c.name,'status',c.email_status)
  FROM core.customers c JOIN core.signups s ON s.customer_id=c.id WHERE c.email=${q(email)} ORDER BY s.created_at DESC,s.id LIMIT 1`),expression,email};
}
function context(row){return h.sql(`SELECT public.coupon_confirmation_context_v1('${h.business}','${row.customer}','${row.signup}')`,{service:true});}
function confirm(row){
 const evidence={source:'klaviyo',listId:list,doubleOptIn:true,canReceiveEmailMarketing:true,consent:'SUBSCRIBED',
  emailSha256:createHash('sha256').update(row.email).digest('hex'),simulation:true};
 return h.raw(`SELECT public.coupon_record_confirmed_vip_v1('${h.business}','${row.customer}','${row.signup}',
  'SYNTHETIC_NATIVE_${row.customer}',clock_timestamp(),clock_timestamp(),${q(JSON.stringify(evidence))}::jsonb)`,{service:true});
}
const count=(table,row)=>h.sql(`SELECT count(*) FROM core.${table} WHERE customer_id='${row.customer}'`);
const old=submit('before-current-schema@native.invalid');
const fingerprint=()=>h.sql(`SELECT jsonb_object_agg(p.oid::text,jsonb_build_object('def',pg_get_functiondef(p.oid),'acl',p.proacl,'config',p.proconfig,'definer',p.prosecdef))
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('core','public') AND p.proname<>'classify_test_customer_v1'`);
const originalFunctions=fingerprint();
let fresh;
test('full current K9/K10 schema was loaded from the exact inventoried LF SQL',()=>{
 const entries=Object.values(inventory).filter(e=>e&&typeof e==='object'&&'sha256_bytes' in e);
 for(const row of h.applied){
  const entry=entries.find(e=>e.path===row.path)||inventory.reviewed_additive?.find(e=>e.path===row.path);
  assert.ok(entry,row.path);assert.equal(createHash('sha256').update(row.canonicalLf).digest('hex'),entry.sha256_bytes||entry.sha256_lf,row.path);
 }
 assert.equal(h.applied.length,10);
 for(const relation of ['orders','campaigns','business_staff','campaign_coupons','vip_confirmation_evidence','coupon_welcome_outbox','coupon_delivery_settings','message_log'])
  assert.equal(h.sql(`SELECT to_regclass('core.${relation}') IS NOT NULL`),true);
});
test('real signup RPC reproduces the mismatch and actual K10 rejects it before the fix',()=>{
 assert.equal(old.customerTest,false);assert.equal(old.signupTest,true);assert.equal(old.status,'pending_review');
 assert.equal(context(old).allowed,false);assert.equal(context(old).code,'customer_ineligible');
 const result=confirm(old);assert.notEqual(result.status,0);assert.match(result.stderr,/VIP evidence does not match local request/);
 assert.equal(count('campaign_coupons',old),0);assert.equal(count('vip_confirmation_evidence',old),0);
});
test('forward classifier adds no existing-row repair or K9/K10/suppression function change',async()=>{
 await h.apply();assert.deepEqual(fingerprint(),originalFunctions);
 assert.equal(h.sql(`SELECT is_test FROM core.customers WHERE id='${old.customer}'`),false);
});
test('real signup after the fix aligns flags but checkbox creates no coupon or send',()=>{
 fresh=submit('after-current-schema@native.invalid');
 assert.equal(fresh.customerTest,true);assert.equal(fresh.signupTest,true);assert.equal(fresh.status,'pending_review');
 assert.equal(context(fresh).allowed,true);assert.equal(count('campaign_coupons',fresh),0);assert.equal(count('vip_confirmation_evidence',fresh),0);
 assert.equal(h.sql('SELECT count(*) FROM core.coupon_welcome_outbox'),0);assert.equal(h.sql('SELECT count(*) FROM core.message_log'),0);
});
test('actual K10 confirmation RPC consumes dated synthetic evidence and issues only one test coupon/outbox',()=>{
 const result=confirm(fresh);assert.equal(result.status,0,result.stderr);
 assert.equal(JSON.parse(result.stdout.trim()).confirmed,true);assert.equal(count('campaign_coupons',fresh),1);
 assert.equal(h.sql(`SELECT is_test FROM core.campaign_coupons WHERE customer_id='${fresh.customer}'`),true);
 assert.equal(h.sql(`SELECT to_jsonb(email_status) FROM core.customers WHERE id='${fresh.customer}'`),'subscribed');
 const again=confirm(fresh);assert.equal(again.status,0,again.stderr);assert.equal(count('campaign_coupons',fresh),1);
 assert.equal(h.sql('SELECT count(*) FROM core.coupon_welcome_outbox'),1);assert.equal(h.sql('SELECT count(*) FROM core.message_log'),0);
});
test('test coupon stays blocked by the real welcome boundary and never reserves K6',()=>{
 const coupon=h.sql(`SELECT to_jsonb(id) FROM core.campaign_coupons WHERE customer_id='${fresh.customer}'`);
 const result=h.sql(`SELECT public.coupon_welcome_claim_v1('${h.business}','${coupon}')`,{service:true});
 assert.equal(result.allowed,false);assert.equal(result.code,'customer_ineligible');assert.equal(h.sql('SELECT count(*) FROM core.message_log'),0);
});
test('same request remains idempotent after valid confirmation, with no extra signup or coupon',()=>{
 h.sql(fresh.expression,{service:true});assert.equal(count('signups',fresh),1);assert.equal(count('campaign_coupons',fresh),1);
});
test('ordinary customer mixed with a test snapshot remains ordinary and actual K10 refuses confirmation',()=>{
 const first=submit('ordinary-current-schema@fixture.test','Ordinary Fixture');
 const mixed=submit(first.email,'INTERNAL TEST Incoming snapshot');
 assert.equal(first.customer,mixed.customer);assert.equal(mixed.customerTest,false);assert.equal(mixed.signupTest,true);assert.equal(mixed.name,'Ordinary Fixture');
 assert.equal(context(mixed).allowed,false);assert.notEqual(confirm(mixed).status,0);assert.equal(count('campaign_coupons',mixed),0);
});
test('real suppression wins against fresh signup and the K10 positive-evidence path',()=>{
 const row=submit('suppressed-current-schema@native.invalid');h.sql(`SELECT core.suppress_email(${q(row.email)},'Synthetic current-schema suppression')`);
 const next=submit(row.email);assert.equal(next.status,'unsubscribed');assert.equal(context(next).allowed,false);
 const result=confirm(next);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout.trim()).code,'customer_blocked');
 assert.equal(count('campaign_coupons',next),0);assert.equal(h.sql(`SELECT to_jsonb(email_status) FROM core.customers WHERE id='${next.customer}'`),'unsubscribed');
 assert.deepEqual(fingerprint(),originalFunctions);
});
// Optional evidence destination, never a database connection/configuration input.
if(process.env.CUSTOMER_MARKER_EVIDENCE_FILE)after(async()=>writeFile(process.env.CUSTOMER_MARKER_EVIDENCE_FILE,
 JSON.stringify({schema:'full reviewed baseline + actual K3/K4/K5 and current Ops/K7/K6/K8/K9/K10 SQL',
  sourceFiles:h.applied.map(x=>({path:x.path,sha256Lf:createHash('sha256').update(x.canonicalLf).digest('hex')})),
  hosted:false,provider_calls:0,real_customer_data:false,reduced_schema:false},null,2)+'\n'));
