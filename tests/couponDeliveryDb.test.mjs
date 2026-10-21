import test,{after} from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/signupRewardCouponsNative.mjs';
import {processCouponWelcome} from '../functions/_lib/couponWelcome.ts';
const h=await fixture();const path='supabase/migrations/20261021000825_coupon_delivery_reconciliation.sql';
const checks=[];after(async()=>{await writeFile(join(h.config.run,'delivery-reconciliation-summary.json'),JSON.stringify({checks,passed:checks.filter(x=>x.passed).length,total:checks.length,hosted:false,provider_calls:0,synthetic_provider:true,real_customer_data:false},null,2)+'\n');await h.stop();});
h.sql(await readFile(join(h.repo,path),'utf8'));
function check(name,fn){test(name,async()=>{try{await fn();checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,error:e.message});throw e;}});}
const B=h.config.businessId,OTHER=h.config.secondBusinessId;
const rpc=(name,args)=>h.sql('SELECT public.'+name+'('+Object.entries(args).map(([k,v])=>k+'=>'+h.literal(v)).join(',')+')',{service:true});
const store={rpc};
function customer(){
 const c=h.customer({status:'pending_review'});const recipient=c+'@synthetic.test';
 h.sql(`UPDATE core.customers SET is_test=false,email=${h.literal(recipient)},identity_key=${h.literal('email:'+recipient)} WHERE id='${c}'`);
 h.reward({is_test:false});const signup=h.signup(c);const profile='PROFILE_'+c.replaceAll('-','');h.confirm(c,signup,{profile});
 h.sql(`INSERT INTO core.message_send_settings(business_id,enabled) VALUES('${B}',true) ON CONFLICT(business_id) DO UPDATE SET enabled=true;
 INSERT INTO core.coupon_delivery_settings(business_id,enabled,account_id,flow_id,message_id,received_metric_id,review_ref) VALUES('${B}',true,'ACCOUNT','FLOW','MESSAGE','METRIC','synthetic-review-v1') ON CONFLICT(business_id) DO UPDATE SET enabled=true;`);
 return {c,recipient,profile,coupon:h.coupon(c)};
}
async function dispatched(){
 const x=customer();let events=0;
 const provider={mode:'live',async get(path){if(path==='/accounts')return {data:[{id:'ACCOUNT'}]};assert.equal(path,'/profiles');return {data:[{id:x.profile,attributes:{email:x.recipient,subscriptions:{email:{marketing:{consent:'SUBSCRIBED',can_receive_email_marketing:true,suppression:[],list_suppressions:[]}}}}}]};},async eventAccount(){return {data:[{id:'ACCOUNT'}]};},async event(){events++;return {status:202};}};
 const r=await processCouponWelcome({store,provider,businessId:B,accountId:'ACCOUNT',qrOrigin:'https://owned.synthetic.invalid',couponId:x.coupon.id});
 assert.equal(r.status,'provider_accepted',JSON.stringify(r));assert.equal(r.activationReady,false);assert.equal(events,1);
 const binding=h.sql(`SELECT to_jsonb(b) FROM core.coupon_delivery_bindings b JOIN core.coupon_welcome_outbox j ON j.id=b.job_id WHERE j.coupon_id='${x.coupon.id}'`);
 return {...x,binding};
}
function historical(hours){
 // Owned local historical fixture only: production records/triggers are never edited.
 const x=customer(),reservation=randomUUID(),binding=randomUUID();
 const j=rpc('coupon_welcome_claim_v1',{p_business_id:B,p_coupon_id:x.coupon.id});
 h.sql(`INSERT INTO core.message_log(id,business_id,customer_id,message_key,message_kind,payload_sha256,recipient_sha256,identity_sha256,status,lease_id,reserved_at,reservation_expires_at,claimed_at,dispatch_expires_at,dispatch_authorized_at,finished_at)
 VALUES('${reservation}','${B}','${x.c}',${h.literal(j.messageKey)},'flow',repeat('a',64),repeat('b',64),repeat('c',64),'unknown',gen_random_uuid(),clock_timestamp()-interval '${hours+1} hours',clock_timestamp()-interval '${hours} hours',clock_timestamp()-interval '${hours+1} hours',clock_timestamp()-interval '${hours} hours',clock_timestamp()-interval '${hours+1} hours',clock_timestamp()-interval '${hours} hours');
 INSERT INTO core.coupon_delivery_bindings(id,business_id,job_id,reservation_id,account_id,profile_id,flow_id,message_id,received_metric_id,review_ref) VALUES('${binding}','${B}','${j.jobId}','${reservation}','ACCOUNT',${h.literal(x.profile)},'FLOW','MESSAGE','METRIC','historical-fixture');`);
 rpc('coupon_welcome_finish_v1',{p_job_id:j.jobId,p_job_lease_id:j.jobLeaseId,p_outcome:'provider_accepted',p_message_reservation_id:reservation,p_provider_event_id:null,p_safe_code:'pending_receipt'});
 return {...x,reservation,binding:{id:binding,reservation_id:reservation}};
}
function record(x,hours=0){return rpc('coupon_delivery_record_v1',{p_business_id:B,p_binding_id:x.binding.id,p_provider_event_id:'RECEIPT_'+randomUUID().replaceAll('-',''),p_delivered_at:new Date(Date.now()-hours*3600000).toISOString(),p_evidence_sha256:'d'.repeat(64)});}
const blocked=x=>h.sql(`SELECT core.message_send_window_blocked_v1('${B}','${x.c}',NULL)`);
check('actual K4/K6/K10 processor binds before exactly one synthetic accepted event; raw unknown is immutable',async()=>{
 const x=await dispatched();assert.equal(blocked(x),true);const before=h.sql(`SELECT to_jsonb(m) FROM core.message_log m WHERE id='${x.binding.reservation_id}'`);
 assert.equal(record(x).acknowledged,true);assert.equal(blocked(x),true);
 assert.deepEqual(h.sql(`SELECT to_jsonb(m) FROM core.message_log m WHERE id='${x.binding.reservation_id}'`),before);
 assert.notEqual(h.raw(`UPDATE core.message_log SET status='sent',sent_at=clock_timestamp() WHERE id='${x.binding.reservation_id}'`).status,0);
 assert.equal(rpc('coupon_delivery_context_v1',{p_business_id:B,p_coupon_id:x.coupon.id}).activationAllowed,true);
 h.sql(`UPDATE core.coupon_delivery_settings SET enabled=false WHERE business_id='${B}'`);
 assert.equal(rpc('coupon_delivery_context_v1',{p_business_id:B,p_coupon_id:x.coupon.id}).activationAllowed,false);
});
for(const hours of [167,169])check('confirmed delivery '+hours+' hours ago uses the actual rolling window',()=>{const x=historical(hours);record(x,hours);assert.equal(blocked(x),hours===167);});
check('unknown without evidence is never cleared merely by age',()=>{const x=historical(1000);assert.equal(blocked(x),true);});
check('provider receipt is idempotent; conflicting receipt and foreign business are rejected',async()=>{
 const x=await dispatched();const args={p_business_id:B,p_binding_id:x.binding.id,p_provider_event_id:'EVENT_'+randomUUID().replaceAll('-',''),p_delivered_at:new Date().toISOString(),p_evidence_sha256:'d'.repeat(64)};
 assert.equal(rpc('coupon_delivery_record_v1',args).acknowledged,true);assert.equal(rpc('coupon_delivery_record_v1',args).acknowledged,true);
 assert.throws(()=>rpc('coupon_delivery_record_v1',{...args,p_provider_event_id:'OTHER_EVENT'}));
 assert.throws(()=>rpc('coupon_delivery_record_v1',{...args,p_business_id:OTHER}));
 assert.notEqual(h.raw(`DELETE FROM core.coupon_delivery_receipts WHERE binding_id='${x.binding.id}'`).status,0);
});
check('only active platform operator plus target membership can attest a cancelled provider queue; review keeps a bounded quarantine',()=>{
 const x=historical(169);const args=`'${B}','${x.reservation}','synthetic/cancel-evidence',repeat('e',64),clock_timestamp()`;
 for(const name of ['ownerA','managerA','staffA','platformOnly','inactivePlatform'])assert.notEqual(h.raw(`SELECT public.coupon_review_not_sent_v1(${args})`,{role:'authenticated',subject:h.config.scopeFixture.users[name]}).status,0,name);
 const actor=h.config.scopeFixture.users.platformMember;const result=h.sql(`SELECT public.coupon_review_not_sent_v1(${args})`,{role:'authenticated',subject:actor});
 assert.equal(result.acknowledged,true);assert.ok(Date.parse(result.quarantineUntil)>Date.now()+167*3600000);assert.equal(blocked(x),true);
 const again=h.sql(`SELECT public.coupon_review_not_sent_v1(${args})`,{role:'authenticated',subject:actor});assert.equal(again.quarantineUntil,result.quarantineUntil);
 assert.notEqual(h.raw(`UPDATE core.coupon_delivery_reviews SET quarantine_until=clock_timestamp() WHERE reservation_id='${x.reservation}'`).status,0);
});
check('a completed historical cancellation review releases the hold after quarantine; new delivery proof wins',()=>{
 const x=historical(500),actor=h.config.scopeFixture.users.platformMember;
 h.sql(`INSERT INTO core.coupon_delivery_reviews(reservation_id,business_id,actor_id,evidence_ref,evidence_sha256,provider_cancelled_at,quarantine_until,recorded_at) VALUES('${x.reservation}','${B}','${actor}','synthetic/historical-cancel',repeat('e',64),clock_timestamp()-interval '200 hours',clock_timestamp()-interval '32 hours',clock_timestamp()-interval '200 hours')`);
 assert.equal(blocked(x),false);record(x);assert.equal(blocked(x),true);
});
check('all new records are private/RLS and service reads cannot become a browser write endpoint',()=>{
 for(const t of ['coupon_delivery_settings','coupon_delivery_bindings','coupon_delivery_receipts','coupon_delivery_reviews']){
  assert.equal(h.sql(`SELECT relrowsecurity FROM pg_class WHERE oid='core.${t}'::regclass`),true);
  for(const role of ['anon','authenticated','service_role'])assert.equal(h.sql(`SELECT has_table_privilege('${role}','core.${t}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')`),false);
 }
 assert.equal(h.sql("SELECT has_function_privilege('authenticated','public.coupon_delivery_record_v1(uuid,uuid,text,timestamptz,text)','EXECUTE')"),false);
 assert.equal(h.sql("SELECT has_function_privilege('anon','public.coupon_review_not_sent_v1(uuid,uuid,text,text,timestamptz)','EXECUTE')"),false);
});
