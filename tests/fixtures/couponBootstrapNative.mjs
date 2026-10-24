// Shared full-schema owned-PG fixture. No hosted connection, profile, key or test flag repair.
import {fixture,repo} from './customerTestClassificationNative.mjs';
import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID,createHash} from 'node:crypto';
export async function bootstrapFixture({expires='20 minutes'}={}){
 const h=await fixture({currentCouponSchema:true}),q=h.literal;
 try{
  h.sql(await readFile(join(repo,'supabase/migrations/20261024000200_coupon_first_event_bootstrap.sql'),'utf8'));
  const actor=randomUUID(),offer=randomUUID(),campaign=randomUUID(),email='fixture-'+randomUUID()+'@fixture.test',list='LOCAL_BOOTSTRAP_LIST',profileId='LOCAL_BOOTSTRAP_PROFILE';
  h.sql(`INSERT INTO auth.users(id) VALUES('${actor}');INSERT INTO core.business_staff(business_id,staff_id,role,active) VALUES('${h.business}','${actor}','owner',true);INSERT INTO core.platform_operators(staff_id,active) VALUES('${actor}',true);INSERT INTO core.message_send_settings(business_id,enabled) VALUES('${h.business}',true);
   INSERT INTO core.offers(id,business_id,name,starts_at,ends_at,active,is_test) VALUES('${offer}','${h.business}','Local bootstrap coupon',current_date-1,current_date+30,true,false);
   INSERT INTO core.campaigns(id,business_id,offer_id,name,benefit_type,target_clover_item_id,benefit_code,min_amount_cents,include_tax,include_tip,order_type_ids,starts_at,ends_at,tz_name,eligibility,max_units_per_order,period,status,is_test,campaign_kind,coupon_channels,coupon_order_type_map,vip_list_id)
   VALUES('${campaign}','${h.business}','${offer}','Local coupon','item','LOCALSIMIT01','SIMIT',3000,false,false,ARRAY['LOCALDINE01','LOCALPICK01','LOCALDELV01'],clock_timestamp()-interval '1 hour',NULL,'America/New_York','subscribed_only',1,'campaign','active',false,'signup_reward',ARRAY['dine_in','site_pickup','site_delivery'],'{"LOCALDINE01":"dine_in","LOCALPICK01":"site_pickup","LOCALDELV01":"site_delivery"}','${list}');`);
  h.sql(`SELECT public.submit_signup_once('${randomUUID()}','${h.business}','Local ordinary fixture',${q(email)},NULL,'website_vip_page',true,false,'{}',NULL)`,{service:true});
  const person=h.sql(`SELECT jsonb_build_object('customer',c.id,'signup',s.id) FROM core.customers c JOIN core.signups s ON s.customer_id=c.id WHERE c.email=${q(email)}`);
  const evidence={source:'klaviyo',listId:list,doubleOptIn:true,canReceiveEmailMarketing:true,consent:'SUBSCRIBED',emailSha256:createHash('sha256').update(email).digest('hex')};
  h.sql(`SELECT public.coupon_record_confirmed_vip_v1('${h.business}','${person.customer}','${person.signup}','${profileId}',clock_timestamp(),clock_timestamp(),${q(JSON.stringify(evidence))})`,{service:true});
  const coupon=h.sql(`SELECT to_jsonb(id) FROM core.campaign_coupons WHERE customer_id='${person.customer}'`);
  const permit=h.sql(`SET request.jwt.claim.role='authenticated';SET request.jwt.claim.sub='${actor}';SELECT public.coupon_bootstrap_permit_v1('${h.business}','${coupon}','LOCAL_ACCOUNT','https://owned.invalid','local-recovery-review','${'a'.repeat(64)}',clock_timestamp()+interval '${expires}',clock_timestamp()+interval '3 days',true)`,{role:'authenticated'}).permitId;
  const cfg={mode:'live',isolated:false,url:'https://never-contacted.invalid',serviceKey:'sb_secret_synthetic',processKey:'s'.repeat(64),businessId:h.business,accountId:'LOCAL_ACCOUNT',readKey:'pk_synthetic_read',eventKey:'pk_synthetic_event',receiptKey:'pk_synthetic_receipt',qrOrigin:'https://owned.invalid',approvalId:'local-review-only'};
  const store={async rpc(name,args){return h.sql(`SELECT public.${name}(${Object.entries(args).map(([k,v])=>k+'=>'+(v===null?'NULL':q(typeof v==='object'?JSON.stringify(v):v))).join(',')})`,{service:true});}};
  return Object.assign(h,{actor,coupon,permit,person,email,list,profileId,cfg,store});
 }catch(error){await h.stop();throw error;}
}
