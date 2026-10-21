import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './fixtures/signupRewardCouponsNative.mjs';
const h=await fixture();const checks=[];
after(async()=>{await writeFile(join(h.config.run,'coupon-suite-summary.json'),JSON.stringify({scope:'K10_COUPONS_NATIVE_PG18_6',checks,total:checks.length,passed:checks.filter(x=>x.passed).length,provider_calls:0,hosted:false,real_customer_data:false},null,2)+'\n');await h.stop();});
function check(name,body){test(name,async t=>{try{await body(t);checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,error:String(e.message)});throw e;}});}
function fails(sql,re=/.+/){const r=h.raw(sql);assert.notEqual(r.status,0);assert.match(r.stderr,re);}
const count=table=>h.sql(`SELECT count(*) FROM core.${table}`);
function earned({campaign=null,status='pending_review',businessId=h.config.businessId,real=false}={}){
 const c=campaign||h.reward({business_id:businessId,is_test:!real});const u=h.customer({businessId,status});
 if(real)h.sql(`UPDATE core.customers SET is_test=false,email='${u}@synthetic.test',identity_key='email:${u}@synthetic.test' WHERE id='${u}'`);
 const s=h.signup(u,{businessId});const result=h.confirm(u,s,{businessId});return{campaign:c,customer:u,signup:s,result,coupon:h.coupon(u)};
}
check('verified DOI changes pending VIP to subscribed and atomically creates one coupon/outbox',()=>{
 const before=count('campaign_coupons'),x=earned();assert.equal(x.result.confirmed,true);assert.equal(x.result.issued,1);assert.equal(x.coupon.state,'issued');
 assert.equal(count('campaign_coupons'),before+1);assert.match(x.coupon.code,/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}(-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){3}$/);
 assert.equal(h.sql(`SELECT email_status='subscribed' FROM core.customers WHERE id='${x.customer}'`),true);
 assert.equal(h.sql(`SELECT count(*) FROM core.coupon_welcome_outbox WHERE coupon_id='${x.coupon.id}'`),1);
 const again=h.confirm(x.customer,x.signup);assert.equal(again.idempotent,true);assert.equal(h.coupon(x.customer).id,x.coupon.id);
});
check('checkbox or direct subscribed update without evidence issues no coupon',()=>{
 h.reward();const u=h.customer({status:'pending_review'});h.signup(u);h.sql(`UPDATE core.customers SET email_status='subscribed' WHERE id='${u}'`);
 assert.equal(h.coupon(u),null);assert.equal(h.sql(`SELECT public.coupon_issue_confirmed_v1('${h.config.businessId}','${u}')`,{service:true}).issued,0);
});
check('missing DOI, mismatching email/list and a non-VIP request cannot grant coupons',()=>{
 h.reward();for(const evidence of [{doubleOptIn:false},{emailSha256:'0'.repeat(64)},{listId:'WRONG_LIST'},{canReceiveEmailMarketing:false}]){
 const u=h.customer({status:'pending_review'}),s=h.signup(u);assert.throws(()=>h.confirm(u,s,{evidence}));assert.equal(h.coupon(u),null);}
 const u=h.customer({status:'not_subscribed'}),s=h.signup(u,{consent:false,source:'catering'});assert.throws(()=>h.confirm(u,s));assert.equal(h.coupon(u),null);
});
check('unsubscribed and persisted negative observations are never cleared',()=>{
 h.reward();const u=h.customer({status:'unsubscribed'}),s=h.signup(u);assert.equal(h.confirm(u,s).code,'customer_blocked');assert.equal(h.coupon(u),null);
 const v=h.customer({status:'pending_review'}),sv=h.signup(v);h.sql(`INSERT INTO core.klaviyo_email_observations(customer_id,status,checked_at,blocked_at,blocked_status) VALUES('${v}','suppressed',clock_timestamp(),clock_timestamp(),'suppressed')`);
 assert.equal(h.confirm(v,sv).confirmed,false);assert.equal(h.coupon(v),null);
});
check('dated DOI evidence is immutable and service-only; catch-up issues at most once',()=>{
 const x=earned();fails(`DELETE FROM core.vip_confirmation_evidence WHERE customer_id='${x.customer}'`,/IMMUTABLE/);
 fails(`UPDATE core.vip_confirmation_evidence SET email_sha256=repeat('0',64) WHERE customer_id='${x.customer}'`,/IMMUTABLE/);
 assert.equal(h.sql(`SELECT public.coupon_issue_confirmed_v1('${h.config.businessId}','${x.customer}')`,{service:true}).issued,0);
 const auth=h.raw(`SELECT public.coupon_issue_confirmed_v1('${h.config.businessId}','${x.customer}')`,{role:'authenticated',subject:h.config.scopeFixture.users.ownerA});assert.notEqual(auth.status,0);
});
check('inactive configured campaign does not prevent consent; later catch-up issues its one coupon',()=>{
 const campaign=h.reward({status:'draft'}),u=h.customer({status:'pending_review'}),s=h.signup(u);
 const context=h.sql(`SELECT public.coupon_confirmation_context_v1('${h.config.businessId}','${u}','${s}')`,{service:true});assert.equal(context.allowed,true);
 const confirmed=h.confirm(u,s);assert.equal(confirmed.confirmed,true);assert.equal(confirmed.issued,0);assert.equal(h.coupon(u),null);
 h.sql(`UPDATE core.campaigns SET status='active' WHERE id='${campaign}'`);
 assert.equal(h.sql(`SELECT public.coupon_issue_confirmed_v1('${h.config.businessId}','${u}')`,{service:true}).issued,1);
 assert.equal(h.sql(`SELECT public.coupon_issue_confirmed_v1('${h.config.businessId}','${u}')`,{service:true}).issued,0);
});
check('lookup is read-only, masks names, normalizes code and retains earned rights after unsubscribe',()=>{
 const x=earned();h.sql(`UPDATE core.customers SET email_status='unsubscribed',email_suppressed_at=clock_timestamp() WHERE id='${x.customer}'`);
 const before=count('offer_redemptions');const result=h.sql(`BEGIN READ ONLY;SELECT public.coupon_lookup_v1('${h.config.businessId}','${x.coupon.code.toLowerCase().replaceAll('-',' ')}');COMMIT;`,{role:'authenticated',subject:h.config.scopeFixture.users.ownerA});
 assert.equal(result.valid,true);assert.equal(result.customerNameMasked,'S***');assert.equal(result.campaign.minimumAmountCents,3000);assert.equal(count('offer_redemptions'),before);
});
check('staff receipt attestation at exact 3000 cents writes one staff_mark redemption and usage',()=>{
 const x=earned();const result=h.redeem(x.coupon.code);assert.equal(result.redeemed,true);assert.equal(result.evidenceMode,'staff_attested');
 const r=h.sql(`SELECT to_jsonb(r) FROM core.offer_redemptions r WHERE id='${result.redemptionId}'`);assert.equal(r.order_id,null);assert.equal(r.source,'staff_mark');assert.equal(r.units,1);
 assert.equal(h.sql(`SELECT reserved_units FROM core.campaign_usage WHERE campaign_id='${x.campaign}'`),1);
 const again=h.redeem(x.coupon.code);assert.equal(again.code,'already_used');assert.equal(again.redemptionId,result.redemptionId);
});
check('2999 cents, marketplace/delivery aliases and missing attestation fail closed',()=>{
 const x=earned();assert.equal(h.redeem(x.coupon.code,{attestation:h.note({qualifyingAmountCents:2999})}).code,'below_minimum');
 assert.equal(h.redeem(x.coupon.code,{attestation:h.note({channel:'doordash'})}).code,'channel_not_allowed');
 assert.equal(h.redeem(x.coupon.code,{attestation:null}).code,'attestation_required');assert.equal(h.coupon(x.customer).state,'issued');
});
check('only a next order after coupon issuance qualifies, including staff-attested receipts',()=>{
 const x=earned();assert.equal(h.redeem(x.coupon.code,{attestation:h.note({receiptAt:'2026-10-01T00:00:00Z'})}).code,'order_before_coupon');
 const o=h.order(x.customer),id=h.sql(`SELECT to_jsonb(clover_order_id) FROM core.orders WHERE id='${o}'`);
 assert.equal(h.redeem(x.coupon.code,{cloverOrderId:id,attestation:h.note({channel:'site_pickup',qualifyingAmountCents:5000})}).code,'order_before_coupon');
 assert.equal(h.redeem(x.coupon.code).redeemed,true);
});
check('signup reward configuration rejects missing, duplicate or restricted unsupported terms',()=>{
 for(const change of [{vip_list_id:null},{coupon_channels:null},{coupon_channels:['dine_in','dine_in']},{weekdays:[1]},{restore_on_full_refund:true},{include_tax:true},{min_amount_cents:2999}])assert.throws(()=>h.reward(change));
});
check('actual K4 suppression guard rejects a direct positive consent update',()=>{
 const u=h.customer({status:'unsubscribed'});fails(`UPDATE core.customers SET email_status='subscribed',email_suppressed_at=NULL WHERE id='${u}'`,/Suppression requires approved new customer consent/);
});
check('all three configured own channels redeem and reuse of one receipt is blocked',()=>{
 for(const channel of ['dine_in','site_pickup','site_delivery']){const x=earned();assert.equal(h.redeem(x.coupon.code,{attestation:h.note({channel})}).redeemed,true);}
 const campaign=h.reward(),a=earned({campaign}),b=earned({campaign}),n=h.note();assert.equal(h.redeem(a.coupon.code,{attestation:n}).redeemed,true);
 assert.equal(h.redeem(b.coupon.code,{attestation:n}).code,'order_already_rewarded');
});
check('coupon redemption shares the durable K9 global quota',()=>{
 const campaign=h.reward({max_total_units:1}),a=earned({campaign}),b=earned({campaign});assert.equal(h.redeem(a.coupon.code).redeemed,true);
 assert.equal(h.redeem(b.coupon.code).code,'total_limit');assert.equal(h.coupon(b.customer).state,'issued');
});
check('linked Clover order uses paid matched amount/channel source without a silent attestation fallback',()=>{
 const x=earned();const o=h.order(x.customer,{date:new Date().toISOString(),amount:3000,trace:false}),id=h.sql(`SELECT to_jsonb(clover_order_id) FROM core.orders WHERE id='${o}'`);
 assert.equal(h.redeem(x.coupon.code,{cloverOrderId:id,attestation:h.note({channel:'site_pickup',qualifyingAmountCents:2999})}).code,'attestation_mismatch');
 const accepted=h.redeem(x.coupon.code,{cloverOrderId:id,attestation:h.note({channel:'site_pickup'})});assert.equal(accepted.redeemed,true);assert.equal(accepted.evidenceMode,'clover_verified');
 const missing=earned();assert.equal(h.redeem(missing.coupon.code,{cloverOrderId:'UNKNOWNORDER01'}).code,'order_not_synced');
 const other=earned();const oo=h.order(other.customer,{date:new Date().toISOString(),raw:{refundsVerified:false}});const oid=h.sql(`SELECT to_jsonb(clover_order_id) FROM core.orders WHERE id='${oo}'`);
 assert.equal(h.redeem(other.coupon.code,{cloverOrderId:oid}).code,'amount_evidence_missing');
});
check('wrong business, legacy-only and platform-only staff are denied before coupon data',()=>{
 const x=earned();for(const actor of [h.config.scopeFixture.users.staffB,h.config.scopeFixture.users.legacyOnly,h.config.scopeFixture.users.platformOnly]){
 const r=h.raw(`SELECT public.coupon_lookup_v1('${h.config.businessId}','${x.coupon.code}')`,{role:'authenticated',subject:actor});assert.notEqual(r.status,0);assert.match(r.stderr,/Access denied/);
 }
 const foreign=earned({businessId:h.config.secondBusinessId});const result=h.sql(`SELECT public.coupon_lookup_v1('${h.config.businessId}','${foreign.coupon.code}')`,{role:'authenticated',subject:h.config.scopeFixture.users.ownerA});
 assert.equal(result.status,'wrong_business');assert.equal(result.customerNameMasked,null);assert.equal(result.couponId,null);
});
check('campaign stopping/expiry fail lookup while issued promises and identity stay immutable',()=>{
 const x=earned();fails(`UPDATE core.campaigns SET min_amount_cents=4000 WHERE id='${x.campaign}'`,/TERMS_IMMUTABLE/);
 fails(`UPDATE core.campaigns SET campaign_kind='order_reward',coupon_channels=NULL,vip_list_id=NULL,coupon_order_type_map='{}' WHERE id='${x.campaign}'`,/TERMS_IMMUTABLE/);
 h.sql(`UPDATE core.campaigns SET status='stopped' WHERE id='${x.campaign}'`);assert.equal(h.redeem(x.coupon.code).code,'campaign_inactive');
 fails(`UPDATE core.campaign_coupons SET code='AAAA-AAAA-AAAA-AAAA' WHERE id='${x.coupon.id}'`,/IMMUTABLE/);
});
check('coupon refund cannot be voided, restored or bypassed through the old evaluator',()=>{
 const x=earned();const o=h.order(x.customer,{date:new Date().toISOString(),trace:false});const oid=h.sql(`SELECT to_jsonb(clover_order_id) FROM core.orders WHERE id='${o}'`);
 const r=h.redeem(x.coupon.code,{cloverOrderId:oid,attestation:h.note({channel:'site_pickup',qualifyingAmountCents:5000})});assert.equal(r.redeemed,true);
 h.refund(o,5000);assert.equal(h.evaluate(x.campaign,o).code,'coupon_required');
 fails(`UPDATE core.offer_redemptions SET status='voided',void_reason='full_refund',voided_at=clock_timestamp(),quota_reserved=false WHERE id='${r.redemptionId}'`,/NEVER_VOIDED/);
 assert.equal(h.coupon(x.customer).state,'redeemed');assert.equal(h.sql(`SELECT reserved_units FROM core.campaign_usage WHERE campaign_id='${x.campaign}'`),1);
});
check('two real PostgreSQL backends contend for one coupon; exactly one redemption commits',async t=>{
 const x=earned(),actor=h.config.scopeFixture.users.ownerA,tag='coupon_'+randomUUID().replaceAll('-','');
 const prefix=`BEGIN;SET LOCAL request.jwt.claim.role='authenticated';SET LOCAL request.jwt.claim.sub='${actor}';SET LOCAL ROLE authenticated;`;
 const expr=h.redeemExpression(x.coupon.code);const first=h.session(prefix+`SET LOCAL application_name='${tag}a';SELECT json_build_object('backendPid',pg_backend_pid(),'decision',${expr});SELECT pg_sleep(3);COMMIT;`,tag+'a');
 first.promise.catch(()=>{});t.after(()=>{if(first.child.exitCode===null)first.child.kill();});
 let sleeping=false;for(let n=0;n<60;n++){sleeping=h.sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='${tag}a' AND wait_event='PgSleep')`);if(sleeping)break;if(first.child.exitCode!==null)await first.promise;await new Promise(r=>setTimeout(r,30));}if(!sleeping){const detail=await first.promise;await writeFile(join(h.config.run,'race-first-unexpected.json'),JSON.stringify(detail,null,2));}assert.equal(sleeping,true);
 const second=h.session(prefix+`SET LOCAL application_name='${tag}b';SELECT json_build_object('backendPid',pg_backend_pid(),'decision',${expr});COMMIT;`,tag+'b');second.promise.catch(()=>{});t.after(()=>{if(second.child.exitCode===null)second.child.kill();});
 let blocked=null;for(let n=0;n<60;n++){blocked=h.sql(`SELECT json_build_object('pid',pid,'blockers',pg_blocking_pids(pid)) FROM pg_stat_activity WHERE application_name='${tag}b' AND wait_event_type='Lock'`);if(blocked?.blockers.length)break;await new Promise(r=>setTimeout(r,30));}assert.ok(blocked?.blockers.length);
 const raw=await Promise.all([first.promise,second.promise]);const result=raw.map(x=>JSON.parse(x.stdout.split(/\r?\n/).find(s=>s.startsWith('{'))));assert.notEqual(result[0].backendPid,result[1].backendPid);assert.equal(result[0].decision.redeemed,true);assert.equal(result[1].decision.code,'already_used');
 assert.equal(h.sql(`SELECT count(*) FROM core.offer_redemptions WHERE coupon_id='${x.coupon.id}'`),1);
 await writeFile(join(h.config.run,'coupon-two-backend-race.json'),JSON.stringify({blocked,results:result,distinctBackends:true},null,2)+'\n');
});
check('actual K4 restoration does not wait for an already-issued coupon campaign lock',async t=>{
 const x=earned(),tag='restore_'+randomUUID().replaceAll('-','');h.sql(`UPDATE core.customers SET email_status='unsubscribed',email_suppressed_at=clock_timestamp() WHERE id='${x.customer}'`);
 const first=h.session(`BEGIN;SET LOCAL application_name='${tag}';SELECT 1 FROM core.campaigns WHERE id='${x.campaign}' FOR UPDATE;SELECT pg_sleep(4);COMMIT;`,tag);first.promise.catch(()=>{});t.after(()=>{if(first.child.exitCode===null)first.child.kill();});
 let sleeping=false;for(let n=0;n<60;n++){sleeping=h.sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='${tag}' AND wait_event='PgSleep')`);if(sleeping)break;await new Promise(r=>setTimeout(r,25));}assert.equal(sleeping,true);
 const restored=h.sql(`SELECT to_jsonb(public.crm_restore_email_consent_v1('${x.customer}',clock_timestamp(),'customer_web','synthetic renewed consent',repeat('c',64),true,true))`,{role:'authenticated',subject:h.config.scopeFixture.users.ownerA});assert.match(restored,/^[0-9a-f-]{36}$/);
 assert.equal(first.child.exitCode,null,'restoration must complete while the unrelated held campaign row is still locked');
 await first.promise;assert.equal(h.coupon(x.customer).id,x.coupon.id);assert.equal(h.sql(`SELECT count(*) FROM core.campaign_coupons WHERE customer_id='${x.customer}'`),1);
 await writeFile(join(h.config.run,'k4-restore-existing-coupon-lock.json'),JSON.stringify({restoredWhileCampaignLocked:true,couponId:x.coupon.id,onlyOneCoupon:true},null,2)+'\n');
});
check('three actual backends avoid issuer, legacy order-writer and wrong-customer coupon lock cycle',async t=>{
 const campaign=h.reward({status:'draft'}),u=h.customer({status:'pending_review'}),su=h.signup(u);assert.equal(h.confirm(u,su).issued,0);
 h.sql(`UPDATE core.campaigns SET status='active' WHERE id='${campaign}'`);
 const v=h.customer({status:'pending_review'}),sv=h.signup(v);h.confirm(v,sv);const cp=h.coupon(v);
 const legacyCampaign=h.campaign(),order=h.order(u,{date:new Date().toISOString()}),cloverId=h.sql(`SELECT to_jsonb(clover_order_id) FROM core.orders WHERE id='${order}'`);
 const tag='three_'+randomUUID().replaceAll('-','');
 const legacy=h.session(`BEGIN;SET LOCAL application_name='${tag}legacy';SELECT 1 FROM core.orders WHERE id='${order}' FOR UPDATE;SELECT pg_sleep(5);SET LOCAL request.jwt.claim.role='service_role';SET LOCAL ROLE service_role;SELECT json_build_object('pid',pg_backend_pid(),'decision',${h.expression(legacyCampaign,order)});COMMIT;`,tag+'legacy');legacy.promise.catch(()=>{});t.after(()=>{if(legacy.child.exitCode===null)legacy.child.kill();});
 async function waitSleeping(name){for(let n=0;n<60;n++){if(h.sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='${name}' AND wait_event='PgSleep')`))return;await new Promise(r=>setTimeout(r,25));}throw Error('staged local backend did not reach its held-lock pause');}
 await waitSleeping(tag+'legacy');
 const issuer=h.session(`BEGIN;SET LOCAL application_name='${tag}issuer';SELECT 1 FROM core.customers WHERE id='${u}' FOR NO KEY UPDATE;SELECT pg_sleep(2);SET LOCAL request.jwt.claim.role='service_role';SET LOCAL ROLE service_role;SELECT json_build_object('pid',pg_backend_pid(),'decision',public.coupon_issue_confirmed_v1('${h.config.businessId}','${u}'));COMMIT;`,tag+'issuer');issuer.promise.catch(()=>{});t.after(()=>{if(issuer.child.exitCode===null)issuer.child.kill();});await waitSleeping(tag+'issuer');
 const expr=h.redeemExpression(cp.code,{cloverOrderId:cloverId,attestation:h.note({channel:'site_pickup',qualifyingAmountCents:5000})});
 const coupon=h.session(`BEGIN;SET LOCAL application_name='${tag}coupon';SET LOCAL request.jwt.claim.role='authenticated';SET LOCAL request.jwt.claim.sub='${h.config.scopeFixture.users.ownerA}';SET LOCAL ROLE authenticated;SELECT json_build_object('pid',pg_backend_pid(),'decision',${expr});COMMIT;`,tag+'coupon');coupon.promise.catch(()=>{});t.after(()=>{if(coupon.child.exitCode===null)coupon.child.kill();});
 let blocked=null;for(let n=0;n<60;n++){blocked=h.sql(`SELECT json_build_object('pid',pid,'blockers',pg_blocking_pids(pid)) FROM pg_stat_activity WHERE application_name='${tag}coupon' AND wait_event_type='Lock'`);if(blocked?.blockers.length)break;await new Promise(r=>setTimeout(r,25));}assert.ok(blocked?.blockers.length,'coupon backend must really wait on the legacy-held order');
 const values=await Promise.all([issuer.promise,legacy.promise,coupon.promise]);const result=values.map(x=>JSON.parse(x.stdout.split(/\r?\n/).find(s=>s.startsWith('{'))));assert.equal(new Set(result.map(x=>x.pid)).size,3);
 assert.equal(result[0].decision.issued,1);assert.equal(result[1].decision.applied,true);assert.equal(result[2].decision.code,'order_unmatched');
 assert.equal(h.sql(`SELECT count(*) FROM core.offer_redemptions WHERE coupon_id='${cp.id}'`),0);
 await writeFile(join(h.config.run,'issuer-legacy-coupon-three-backend.json'),JSON.stringify({distinctBackends:3,actualOrderBlocking:blocked,results:result,noDeadlock:true},null,2)+'\n');
});
check('real-only welcome lease returns immutable coupon snapshot; 202 is accepted, never sent',()=>{
 const x=earned({real:true});const job=h.sql(`SELECT public.coupon_welcome_claim_v1('${h.config.businessId}','${x.coupon.id}')`,{service:true});
 assert.equal(job.allowed,true);assert.equal(job.properties.coupon_code,x.coupon.code);assert.equal(job.properties.coupon_qr_payload,'VIPCOUPON1:'+x.coupon.code);assert.match(job.eventUniqueId,/^[0-9a-f-]{36}$/);
 h.sql(`INSERT INTO core.message_send_settings(business_id,enabled) VALUES('${h.config.businessId}',true) ON CONFLICT(business_id) DO UPDATE SET enabled=true`);
 const reserved=h.sql(`SELECT public.message_send_reserve_v1('${h.config.businessId}','${x.customer}','${job.messageKey}','flow',repeat('a',64))`,{service:true});assert.equal(reserved.allowed,true);
 const claimed=h.sql(`SELECT public.message_send_claim_v1('${reserved.reservationId}')`,{service:true});assert.equal(claimed.allowed,true);
 assert.equal(h.sql(`SELECT public.message_send_context_v1('${reserved.reservationId}','${claimed.leaseId}')`,{service:true}).allowed,true);
 assert.equal(h.sql(`SELECT public.message_send_finalize_v1('${reserved.reservationId}','${claimed.leaseId}','unknown')`,{service:true}).status,'unknown');
 const done=h.sql(`SELECT public.coupon_welcome_finish_v1('${job.jobId}','${job.jobLeaseId}','provider_accepted','${reserved.reservationId}','synthetic-event','event_accepted')`,{service:true});assert.equal(done.status,'provider_accepted');
 assert.equal(h.sql(`SELECT public.coupon_welcome_claim_v1('${h.config.businessId}','${x.coupon.id}')`,{service:true}).allowed,false);
 assert.equal(h.sql(`SELECT status='provider_accepted' FROM core.coupon_welcome_outbox WHERE id='${job.jobId}'`),true);
});
check('welcome provider acceptance cannot be recorded without its consumed K6 reservation',()=>{
 const x=earned({real:true}),job=h.sql(`SELECT public.coupon_welcome_claim_v1('${h.config.businessId}','${x.coupon.id}')`,{service:true});
 assert.throws(()=>h.sql(`SELECT public.coupon_welcome_finish_v1('${job.jobId}','${job.jobLeaseId}','provider_accepted',NULL,NULL,'accepted')`,{service:true}),/CONSUMED_K6_GATE/);
 assert.equal(h.sql(`SELECT status='claimed' FROM core.coupon_welcome_outbox WHERE id='${job.jobId}'`),true);
});
check('actual K6 sliding gate blocks 167 hours and permits 169 hours for coupon flow',()=>{
 h.sql(`INSERT INTO core.message_send_settings(business_id,enabled,min_interval_hours) VALUES('${h.config.businessId}',true,168) ON CONFLICT(business_id) DO UPDATE SET enabled=true,min_interval_hours=168`);
 for(const hours of [167,169]){
  const x=earned({real:true});const key='historical:'+randomUUID();
  h.sql(`INSERT INTO core.message_log(business_id,customer_id,message_key,message_kind,payload_sha256,recipient_sha256,identity_sha256,status,lease_id,reserved_at,reservation_expires_at,claimed_at,dispatch_expires_at,dispatch_authorized_at,sent_at,finished_at)
  SELECT business_id,id,'${key}','campaign',repeat('a',64),encode(sha256(convert_to(email,'UTF8')),'hex'),encode(sha256(convert_to(identity_key,'UTF8')),'hex'),'sent',gen_random_uuid(),clock_timestamp()-interval '${hours} hours'-interval '1 minute',clock_timestamp()-interval '${hours} hours'+interval '4 minutes',clock_timestamp()-interval '${hours} hours'-interval '1 minute',clock_timestamp()-interval '${hours} hours'+interval '1 minute',clock_timestamp()-interval '${hours} hours'-interval '1 second',clock_timestamp()-interval '${hours} hours',clock_timestamp()-interval '${hours} hours' FROM core.customers WHERE id='${x.customer}'`);
  const reserve=h.sql(`SELECT public.message_send_reserve_v1('${h.config.businessId}','${x.customer}','coupon-welcome:${x.coupon.id}','flow',repeat('b',64))`,{service:true});assert.equal(reserve.allowed,hours===169);
  if(hours===167)assert.equal(reserve.code,'frequency_limited');
 }
});
check('actual K6 consuming context blocks a negative change after claim',()=>{
 const x=earned({real:true});h.sql(`INSERT INTO core.message_send_settings(business_id,enabled) VALUES('${h.config.businessId}',true) ON CONFLICT(business_id) DO UPDATE SET enabled=true`);
 const reserved=h.sql(`SELECT public.message_send_reserve_v1('${h.config.businessId}','${x.customer}','coupon-welcome:${x.coupon.id}','flow',repeat('b',64))`,{service:true});assert.equal(reserved.allowed,true);
 const claim=h.sql(`SELECT public.message_send_claim_v1('${reserved.reservationId}')`,{service:true});assert.equal(claim.allowed,true);
 const email=h.sql(`SELECT to_jsonb(email) FROM core.customers WHERE id='${x.customer}'`);h.sql(`SELECT public.coupon_record_negative_v1('${h.config.businessId}','${x.customer}','${email}','suppressed',clock_timestamp())`,{service:true});
 const context=h.sql(`SELECT public.message_send_context_v1('${reserved.reservationId}','${claim.leaseId}')`,{service:true});assert.equal(context.allowed,false);assert.equal(context.code,'customer_ineligible');
});
check('negative provider evidence blocks final context/email but not an already-earned coupon',()=>{
 const x=earned({real:true});const job=h.sql(`SELECT public.coupon_welcome_claim_v1('${h.config.businessId}','${x.coupon.id}')`,{service:true});assert.equal(job.allowed,true);
 const email=h.sql(`SELECT to_jsonb(email) FROM core.customers WHERE id='${x.customer}'`);
 assert.equal(h.sql(`SELECT public.coupon_record_negative_v1('${h.config.businessId}','${x.customer}','${email}','unsubscribed',clock_timestamp())`,{service:true}).blocked,true);
 assert.equal(h.sql(`SELECT public.coupon_welcome_context_v1('${job.jobId}','${job.jobLeaseId}')`,{service:true}).allowed,false);
 assert.equal(h.redeem(x.coupon.code).redeemed,true);
});
check('tables and functions remain private; QR service accessor leaks only QR payload',()=>{
 for(const table of ['campaign_coupons','vip_confirmation_evidence','coupon_welcome_outbox']){
 assert.equal(h.sql(`SELECT relrowsecurity FROM pg_class WHERE oid='core.${table}'::regclass`),true);
 for(const role of ['anon','authenticated','service_role'])assert.equal(h.sql(`SELECT has_table_privilege('${role}','core.${table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')`),false);
 }
 const x=earned();assert.deepEqual(h.sql(`SELECT public.coupon_qr_payload_v1('${x.coupon.qr_token}')`,{service:true}),{payload:'VIPCOUPON1:'+x.coupon.code});
 const bad=h.raw(`SELECT public.coupon_qr_payload_v1('${x.coupon.qr_token}')`,{role:'authenticated',subject:h.config.scopeFixture.users.ownerA});assert.notEqual(bad.status,0);
});
check('historical K9 and K10 functions retain their actual SQL bodies behind guarded dispatch',async()=>{
 const before=JSON.parse(await readFile(join(h.config.run,'forward-migration.json'),'utf8'));
 const inner=h.sql("SELECT to_jsonb(pg_get_functiondef('core.campaign_order_evaluate_v1(uuid,uuid,uuid,integer,text,uuid,text)'::regprocedure))");
 assert.equal(inner.replace('core.campaign_order_evaluate_v1','public.campaign_evaluate_v1'),before.after.definition);
 h.sql("UPDATE core.campaigns SET status='stopped' WHERE campaign_kind='order_reward' AND status='active'");
 const u=h.customer(),campaign=h.campaign(),order=h.order(u);assert.equal(h.evaluate(campaign,order).applied,true);
 assert.equal(h.eligibility(order).reason,'already_applied');
});
