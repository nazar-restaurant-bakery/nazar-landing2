// Real owned loopback PG18.6 + complete baseline/application DDL; no hosted I/O.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,repo} from './fixtures/customerTestClassificationNative.mjs';
import {auditMigrations} from '../tools/test-env/audit-migrations.mjs';
const h=await fixture({currentCouponSchema:true});after(()=>h.stop());
const q=h.literal,path='supabase/migrations/20261024000300_doi_mixed_signup_eligibility.sql';
await h.apply();h.sql(await readFile(join(repo,'supabase/migrations/20261024000200_coupon_first_event_bootstrap.sql'),'utf8'));
const snapshot=()=>h.sql(`SELECT jsonb_object_agg(p.oid::text,md5(pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('core','public') AND p.proname<>'klaviyo_profile_sync_eligible_v1'`);
const before=snapshot(),acl=h.sql("SELECT to_jsonb(proacl) FROM pg_proc WHERE oid='core.klaviyo_profile_sync_eligible_v1(uuid,uuid)'::regprocedure");
const actor=randomUUID(),offer=randomUUID(),campaign=randomUUID();
h.sql(`INSERT INTO auth.users(id) VALUES('${actor}');INSERT INTO core.business_staff(business_id,staff_id,role,active) VALUES('${h.business}','${actor}','owner',true);INSERT INTO core.platform_operators(staff_id,active) VALUES('${actor}',true);
INSERT INTO core.message_send_settings(business_id,enabled) VALUES('${h.business}',true);
INSERT INTO core.offers(id,business_id,name,starts_at,ends_at,active,is_test) VALUES('${offer}','${h.business}','Local coupon',current_date-1,current_date+30,true,false);
INSERT INTO core.campaigns(id,business_id,offer_id,name,benefit_type,target_clover_item_id,benefit_code,min_amount_cents,include_tax,include_tip,order_type_ids,starts_at,ends_at,tz_name,eligibility,max_units_per_order,period,status,is_test,campaign_kind,coupon_channels,coupon_order_type_map,vip_list_id)
VALUES('${campaign}','${h.business}','${offer}','Local coupon','item','LOCALSIMIT01','SIMIT',3000,false,false,ARRAY['LOCALDINE01','LOCALPICK01','LOCALDELV01'],clock_timestamp()-interval '1 hour',NULL,'America/New_York','subscribed_only',1,'campaign','active',false,'signup_reward',ARRAY['dine_in','site_pickup','site_delivery'],'{"LOCALDINE01":"dine_in","LOCALPICK01":"site_pickup","LOCALDELV01":"site_delivery"}','LOCAL_LIST');`);
function person({history=true,doi=true}={}){
 const email='ordinary-'+randomUUID()+'@fixture.test';
 h.sql(`SELECT public.submit_signup_once('${randomUUID()}','${h.business}','Ordinary local person',${q(email)},NULL,'website_vip_page',true,false,'{}',NULL)`,{service:true});
 const p=h.sql(`SELECT jsonb_build_object('id',c.id,'signup',s.id) FROM core.customers c JOIN core.signups s ON s.customer_id=c.id WHERE c.email=${q(email)}`);p.email=email;
 if(history)for(let i=0;i<2;i++)h.sql(`INSERT INTO core.signups(business_id,customer_id,name,email,source,consent_email,fingerprint,is_test,created_at) VALUES('${h.business}','${p.id}','Historical test',${q(email)},'website_vip_page',false,'${randomUUID()}',true,clock_timestamp()-interval '${i+1} days')`);
 if(doi){const proof={source:'klaviyo',listId:'LOCAL_LIST',doubleOptIn:true,canReceiveEmailMarketing:true,consent:'SUBSCRIBED',emailSha256:createHash('sha256').update(email).digest('hex')};
 h.sql(`SELECT public.coupon_record_confirmed_vip_v1('${h.business}','${p.id}','${p.signup}','PROFILE_${randomUUID()}',clock_timestamp(),clock_timestamp(),${q(JSON.stringify(proof))})`,{service:true});}
 return p;
}
const eligible=(p,business=h.business)=>h.sql(`SELECT core.klaviyo_profile_sync_eligible_v1('${business}','${p.id}')`);
const main=person(),noDoi=person({doi:false}),clean=person({history:false});
const historyBefore=h.sql(`SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM core.signups s WHERE customer_id='${main.id}'`);
test('old helper rejects mixed history despite real DOI, no-test behavior unchanged',()=>{assert.equal(eligible(main),false);assert.equal(eligible(noDoi),false);assert.equal(eligible(clean),true);});
test('Production-shaped business/offer marker absence is supported before forward SQL',()=>{
 h.sql('ALTER TABLE core.businesses DROP COLUMN is_test;ALTER TABLE core.offers DROP COLUMN is_test;');
 assert.equal(h.sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='core' AND table_name IN('businesses','offers') AND column_name='is_test'"),0);
});
test('forward migration preserves all other function definitions, ACL and existing rows',async()=>{
 h.sql(await readFile(join(repo,path),'utf8'));assert.deepEqual(snapshot(),before);assert.deepEqual(h.sql("SELECT to_jsonb(proacl) FROM pg_proc WHERE oid='core.klaviyo_profile_sync_eligible_v1(uuid,uuid)'::regprocedure"),acl);
 assert.deepEqual(h.sql(`SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM core.signups s WHERE customer_id='${main.id}'`),historyBefore);
 assert.equal(h.sql(`SELECT count(*) FROM core.signups WHERE customer_id='${main.id}' AND is_test`),2);
});
test('same customer with two historical tests and exact genuine DOI becomes eligible',()=>{assert.equal(eligible(main),true);assert.equal(eligible(clean),true);assert.equal(eligible(noDoi),false);});
test('existing K6 gate and actual bootstrap permit accept evidenced history without bypass',()=>{
 const cp=h.sql(`SELECT to_jsonb(id) FROM core.campaign_coupons WHERE customer_id='${main.id}'`);
 const r=h.sql(`SELECT public.message_send_reserve_v1('${h.business}','${main.id}','local-profile-report','flow','${'a'.repeat(64)}')`,{service:true});assert.equal(r.allowed,true,JSON.stringify(r));
 const permit=h.sql(`SET request.jwt.claim.role='authenticated';SET request.jwt.claim.sub='${actor}';SELECT public.coupon_bootstrap_permit_v1('${h.business}','${cp}','LOCAL_ACCOUNT','https://owned.invalid','local-mixed-history-review','${'b'.repeat(64)}',clock_timestamp()+interval '20 minutes',clock_timestamp()+interval '3 days',true)`,{role:'authenticated'});assert.ok(permit.permitId,JSON.stringify(permit));
 assert.equal(h.sql(`SELECT count(*) FROM core.coupon_bootstrap_permits WHERE attempts<>0`),0);
});
test('same DOI cannot produce a second coupon job or permit',()=>{
 const counts=()=>h.sql(`SELECT jsonb_build_object('coupons',(SELECT count(*) FROM core.campaign_coupons WHERE customer_id='${main.id}'),'jobs',(SELECT count(*) FROM core.coupon_welcome_outbox j JOIN core.campaign_coupons cp ON cp.id=j.coupon_id WHERE cp.customer_id='${main.id}'),'permits',(SELECT count(*) FROM core.coupon_bootstrap_permits WHERE customer_id='${main.id}'))`);
 const initial=counts(),cp=h.sql(`SELECT to_jsonb(id) FROM core.campaign_coupons WHERE customer_id='${main.id}'`);
 h.sql(`SELECT public.coupon_issue_confirmed_v1('${h.business}','${main.id}')`,{service:true});
 const e=h.sql(`SELECT to_jsonb(e) FROM core.vip_confirmation_evidence e WHERE customer_id='${main.id}'`);
 h.sql(`SELECT public.coupon_record_confirmed_vip_v1('${h.business}','${main.id}','${main.signup}',${q(e.provider_profile_id)},${q(e.confirmed_at)},clock_timestamp(),${q(JSON.stringify(e.evidence))})`,{service:true});
 const duplicate=h.raw(`SET request.jwt.claim.role='authenticated';SET request.jwt.claim.sub='${actor}';SELECT public.coupon_bootstrap_permit_v1('${h.business}','${cp}','LOCAL_ACCOUNT','https://owned.invalid','local-mixed-history-review','${'b'.repeat(64)}',clock_timestamp()+interval '20 minutes',clock_timestamp()+interval '3 days',true)`,{role:'authenticated'});
 assert.notEqual(duplicate.status,0);assert.deepEqual(counts(),initial);assert.deepEqual(initial,{coupons:1,jobs:1,permits:1});
});
function rollbackDenied(label,sql){test(label,()=>{const p=person();assert.equal(eligible(p),true);const res=h.raw('BEGIN;'+sql(p)+`;SELECT core.klaviyo_profile_sync_eligible_v1('${h.business}','${p.id}');ROLLBACK;`);assert.equal(res.status,0,res.stderr);assert.ok(res.stdout.trim().endsWith('f'),res.stdout);});}
rollbackDenied('test customer remains denied',p=>`UPDATE core.customers SET is_test=true WHERE id='${p.id}';`);
rollbackDenied('unsubscribed customer remains denied',p=>`UPDATE core.customers SET email_status='unsubscribed' WHERE id='${p.id}';`);
rollbackDenied('suppressed customer remains denied',p=>`UPDATE core.customers SET email_status='unsubscribed',email_suppressed_at=clock_timestamp() WHERE id='${p.id}';`);
for(const status of ['unsubscribed','suppressed'])rollbackDenied('negative provider observation '+status+' remains denied',p=>`INSERT INTO core.klaviyo_email_observations(customer_id,status,checked_at,blocked_status,blocked_at) VALUES('${p.id}','${status}',clock_timestamp(),'${status}',clock_timestamp());`);
rollbackDenied('blocked_at remains denied even confirmed status',p=>`INSERT INTO core.klaviyo_email_observations(customer_id,status,checked_at,blocked_status,blocked_at) VALUES('${p.id}','confirmed',clock_timestamp(),'suppressed',clock_timestamp());`);
rollbackDenied('test-style current email denied despite older genuine DOI',p=>`UPDATE core.customers SET email='other@example.com' WHERE id='${p.id}';`);
rollbackDenied('changed ordinary email fails proof binding',p=>`UPDATE core.customers SET email='changed-${randomUUID()}@fixture.test' WHERE id='${p.id}';`);
for(const source of ['website_vip_page','catering'])rollbackDenied('newer unevidenced '+source+' signup denied',p=>`INSERT INTO core.signups(business_id,customer_id,email,source,consent_email,fingerprint,is_test,created_at) VALUES('${h.business}','${p.id}',${q(p.email)},'${source}',true,'${randomUUID()}',false,clock_timestamp());`);
rollbackDenied('later test signup denied',p=>`INSERT INTO core.signups(business_id,customer_id,email,source,fingerprint,is_test,created_at) VALUES('${h.business}','${p.id}',${q(p.email)},'website_vip_page','${randomUUID()}',true,clock_timestamp());`);
rollbackDenied('equal-time test signup denied rather than UUID order',p=>`INSERT INTO core.signups(business_id,customer_id,email,source,fingerprint,is_test,created_at) SELECT '${h.business}','${p.id}',${q(p.email)},'website_vip_page','${randomUUID()}',true,created_at FROM core.signups WHERE id='${p.signup}';`);

// Deliberately malformed new evidence is inserted only by the owned local PG
// fixture to verify defense against inconsistent stored proof, never by a public API.
for(const [label,patch] of [
 ['missing DOI',{doubleOptIn:null}],['false DOI',{doubleOptIn:false}],
 ['missing provider source',{source:null}],['marketing denied',{canReceiveEmailMarketing:false}],
 ['pending consent',{consent:'PENDING'}],['different list',{listId:'OTHER_LIST'}],
 ['JSON email hash mismatch',{emailSha256:'0'.repeat(64)}]
])test('mixed history rejects '+label,()=>{
 const p=person({doi:false}),hash=createHash('sha256').update(p.email).digest('hex');
 const proof={source:'klaviyo',listId:'LOCAL_LIST',doubleOptIn:true,canReceiveEmailMarketing:true,consent:'SUBSCRIBED',emailSha256:hash,...patch};
 h.sql(`UPDATE core.customers SET email_status='subscribed' WHERE id='${p.id}';
 INSERT INTO core.vip_confirmation_evidence(business_id,customer_id,signup_id,provider_profile_id,confirmed_at,checked_at,email_sha256,evidence)
 VALUES('${h.business}','${p.id}','${p.signup}','LOCAL_CORRUPT',clock_timestamp(),clock_timestamp(),'${hash}',${q(JSON.stringify(proof))});`);
 assert.equal(eligible(p),false);
});
for(const [label,confirmed,checked]of [
 ['confirmation before request',"clock_timestamp()-interval '2 days'",'clock_timestamp()'],
 ['future checked evidence',"clock_timestamp()+interval '1 hour'","clock_timestamp()+interval '1 hour'"]
])test('mixed history rejects '+label,()=>{
 const p=person({doi:false}),hash=createHash('sha256').update(p.email).digest('hex');
 const proof={source:'klaviyo',listId:'LOCAL_LIST',doubleOptIn:true,canReceiveEmailMarketing:true,consent:'SUBSCRIBED',emailSha256:hash};
 h.sql(`UPDATE core.customers SET email_status='subscribed' WHERE id='${p.id}';INSERT INTO core.vip_confirmation_evidence(business_id,customer_id,signup_id,provider_profile_id,confirmed_at,checked_at,email_sha256,evidence) VALUES('${h.business}','${p.id}','${p.signup}','LOCAL_CORRUPT',${confirmed},${checked},'${hash}',${q(JSON.stringify(proof))});`);
 assert.equal(eligible(p),false);
});
rollbackDenied('signup email must match current identity',p=>`UPDATE core.signups SET email='different@fixture.test' WHERE id='${p.signup}';`);
rollbackDenied('signup must request email consent',p=>`UPDATE core.signups SET consent_email=false WHERE id='${p.signup}';`);
rollbackDenied('catering cannot stand in for genuine VIP request',p=>`UPDATE core.signups SET source='catering' WHERE id='${p.signup}';`);
test('K5 eligible mixed history exports latest genuine signup and can enqueue profile-only job',()=>{
 const p=person();const payload=h.sql(`SELECT core.klaviyo_profile_sync_payload_v1('${h.business}','${p.id}')`);
 assert.equal(payload.source,'website_vip_page');assert.equal(payload.name,'Ordinary local person');
 const result=h.sql(`SELECT public.klaviyo_profile_sync_enqueue_v1('${h.business}','LOCAL_ACCOUNT',1,'${p.id}')`,{service:true});
 assert.equal(result.enqueued,1,JSON.stringify(result));
});
test('existing K6 reserve claim consuming-context path all accepts exact mixed-history proof',()=>{
 const p=person();const r=h.sql(`SELECT public.message_send_reserve_v1('${h.business}','${p.id}','local-all-phases','flow','${'c'.repeat(64)}')`,{service:true});assert.equal(r.allowed,true);
 const c=h.sql(`SELECT public.message_send_claim_v1('${r.reservationId}')`,{service:true});assert.equal(c.allowed,true);
 const g=h.sql(`SELECT public.message_send_context_v1('${r.reservationId}','${c.leaseId}')`,{service:true});assert.equal(g.allowed,true);assert.equal(g.code,'dispatch_authorized');
 // No provider call. This is a fresh synthetic gate record inside the owned DB.
});
for(const phase of ['claim','context'])test('new negative observation still blocks mixed-history K6 '+phase,()=>{
 const p=person();const r=h.sql(`SELECT public.message_send_reserve_v1('${h.business}','${p.id}','local-negative-${phase}','flow','${'d'.repeat(64)}')`,{service:true});assert.equal(r.allowed,true);
 const c=phase==='context'?h.sql(`SELECT public.message_send_claim_v1('${r.reservationId}')`,{service:true}):null;
 h.sql(`INSERT INTO core.klaviyo_email_observations(customer_id,status,checked_at,blocked_status,blocked_at) VALUES('${p.id}','suppressed',clock_timestamp(),'suppressed',clock_timestamp());`);
 const result=h.sql(phase==='claim'?`SELECT public.message_send_claim_v1('${r.reservationId}')`:`SELECT public.message_send_context_v1('${r.reservationId}','${c.leaseId}')`,{service:true});
 assert.equal(result.allowed,false);assert.equal(result.code,'customer_ineligible');
});
test('receipt activation respects new negative observation and K6 unknown finalize remains immutable',()=>{
 const p=person(),row=h.sql(`SELECT jsonb_build_object('job',j.id,'coupon',j.coupon_id,'key',j.message_key,'profile',e.provider_profile_id) FROM core.coupon_welcome_outbox j JOIN core.campaign_coupons cp ON cp.id=j.coupon_id JOIN core.vip_confirmation_evidence e ON e.id=cp.confirmation_evidence_id WHERE cp.customer_id='${p.id}'`),jobLease=randomUUID();
 const r=h.sql(`SELECT public.message_send_reserve_v1('${h.business}','${p.id}',${q(row.key)},'flow','${'e'.repeat(64)}')`,{service:true});assert.equal(r.allowed,true);
 const c=h.sql(`SELECT public.message_send_claim_v1('${r.reservationId}')`,{service:true});assert.equal(c.allowed,true);
 assert.equal(h.sql(`SELECT public.message_send_context_v1('${r.reservationId}','${c.leaseId}')`,{service:true}).allowed,true);
 h.sql(`INSERT INTO core.coupon_delivery_settings(business_id,enabled,account_id,flow_id,message_id,received_metric_id,review_ref) VALUES('${h.business}',true,'LOCAL_ACCOUNT','LOCAL_FLOW','LOCAL_MESSAGE','LOCAL_METRIC','local-receipt-review');UPDATE core.coupon_welcome_outbox SET status='claimed',job_lease_id='${jobLease}',lease_expires_at=clock_timestamp()+interval '5 minutes' WHERE id='${row.job}';`);
 assert.equal(h.sql(`SELECT public.coupon_delivery_bind_v1('${h.business}','${row.job}','${jobLease}','${r.reservationId}',${q(row.profile)})`,{service:true}).allowed,true);
 const ctx=()=>h.sql(`SELECT public.coupon_delivery_context_v1('${h.business}','${row.coupon}')`,{service:true});assert.equal(ctx().activationAllowed,true);
 h.sql(`INSERT INTO core.klaviyo_email_observations(customer_id,status,checked_at,blocked_status,blocked_at) VALUES('${p.id}','suppressed',clock_timestamp(),'suppressed',clock_timestamp());`);
 assert.equal(ctx().activationAllowed,false);
 assert.equal(h.sql(`SELECT public.message_send_finalize_v1('${r.reservationId}','${c.leaseId}','unknown')`,{service:true}).status,'unknown');
 assert.equal(h.sql(`SELECT public.message_send_finalize_v1('${r.reservationId}','${c.leaseId}','unknown')`,{service:true}).idempotent,true);
 assert.equal(ctx().activationAllowed,false);assert.equal(h.sql(`SELECT core.message_send_window_blocked_v1('${h.business}','${p.id}',NULL)`),true);
 assert.equal(h.sql(`SELECT public.coupon_delivery_context_v1('${randomUUID()}','${row.coupon}')`,{service:true}),null);
});
test('wrong business and missing customer fail closed',()=>{assert.equal(eligible(main,randomUUID()),false);assert.equal(eligible({id:randomUUID()}),false);});
test('anon authenticated and service role still cannot directly execute private helper',()=>{for(const role of ['anon','authenticated','service_role'])assert.notEqual(h.raw(`SELECT core.klaviyo_profile_sync_eligible_v1('${h.business}','${main.id}')`,{role}).status,0);});
test('DOI evidence remains immutable; no test history removal or flag clearing',()=>{for(const sql of [`UPDATE core.vip_confirmation_evidence SET evidence='{}'`,`DELETE FROM core.vip_confirmation_evidence`])assert.notEqual(h.raw(sql).status,0);assert.deepEqual(h.sql(`SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM core.signups s WHERE customer_id='${main.id}'`),historyBefore);});
test('inventory pins new LF SQL, execution disabled, order unassigned',async()=>{const result=await auditMigrations({root:repo});assert.equal(result.integrity.ok,true,JSON.stringify(result.integrity.issues));});

test('migration refuses unreviewed/reapplied helper fingerprint',async()=>{assert.notEqual(h.raw(await readFile(join(repo,path),'utf8')).status,0);assert.deepEqual(snapshot(),before);});
