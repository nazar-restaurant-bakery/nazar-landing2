import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {bootstrapFixture} from './fixtures/couponBootstrapNative.mjs';
import {processCouponBootstrap,verifyCouponBootstrapEvent} from '../functions/_lib/couponBootstrap.ts';
import {couponWelcomeProperties} from '../functions/_lib/couponWelcome.ts';
function providerFor(h){let body=null,posts=0,eventAt=null;
 const person=()=>({id:h.profileId,attributes:{email:h.email,subscriptions:{email:{marketing:{consent:'SUBSCRIBED',can_receive_email_marketing:true,double_optin:true,consent_timestamp:new Date().toISOString(),suppression:[],list_suppressions:[]}}}}});
 const provider={coupon:{mode:'live',async get(path){return path==='/accounts'?{data:[{id:'LOCAL_ACCOUNT'}]}:{data:[person()]};},async eventAccount(){return {data:[{id:'LOCAL_ACCOUNT'}]};},async event(b){posts++;body=structuredClone(b);eventAt=new Date().toISOString();return {status:202};}},async inventory(){return {accountId:'LOCAL_ACCOUNT',complete:true,metrics:posts?[{type:'metric',id:'LOCAL_METRIC',attributes:{name:'Nazar Coupon Welcome Authorized',integration:{name:'API',category:'API'}}}]:[]};},async events(_p,m){if(!m)return {data:[]};const props=structuredClone(body.data.attributes.properties);delete props.expires_at;props.$event_id=body.data.attributes.unique_id;return {data:[{id:'REAL_SYNTHETIC_EVENT',attributes:{datetime:eventAt,event_properties:props},relationships:{profile:{data:{id:h.profileId}},metric:{data:{id:'LOCAL_METRIC'}}}}],links:{next:null}};}};
 return {provider,posts:()=>posts};
}
test('crash after one POST before either finalizer recovers original unknown and proves event, never rePOST',async()=>{
 const h=await bootstrapFixture();try{
  const x=providerFor(h),fault={async rpc(name,args){if(name==='message_send_finalize_v1')throw Error('simulated worker termination after provider202');return h.store.rpc(name,args);}};
  const first=await processCouponBootstrap({config:h.cfg,store:fault,provider:x.provider,permitId:h.permit});assert.equal(first.status,'unknown');assert.equal(x.posts(),1);
  assert.equal(h.sql('SELECT to_jsonb(state) FROM core.coupon_bootstrap_permits'),'dispatch_bound');assert.equal(h.sql('SELECT to_jsonb(status) FROM core.message_log'),'sending');
  const early=await h.store.rpc('coupon_bootstrap_recover_v1',{p_permit_id:h.permit});assert.equal(early.acknowledged,false);assert.equal(early.retryAllowed,false);
  // LOCAL only: simulate expiry of the original dispatch deadline; never replace
  // the immutable lease, identity, authorization time or any production row.
  h.sql("UPDATE core.message_log SET dispatch_expires_at=clock_timestamp()-interval '1 second'");
  const recovered=await h.store.rpc('coupon_bootstrap_recover_v1',{p_permit_id:h.permit});assert.equal(recovered.acknowledged,true);assert.equal(recovered.retryAllowed,false);
  assert.equal(h.sql('SELECT to_jsonb(status) FROM core.message_log'),'unknown');assert.equal(h.sql('SELECT to_jsonb(status) FROM core.coupon_welcome_outbox'),'unknown');
  assert.equal((await h.store.rpc('coupon_bootstrap_recover_v1',{p_permit_id:h.permit})).acknowledged,true);
  await processCouponBootstrap({config:h.cfg,store:h.store,provider:x.provider,permitId:h.permit});assert.equal(x.posts(),1);
  assert.equal((await verifyCouponBootstrapEvent({config:h.cfg,store:h.store,provider:x.provider,permitId:h.permit})).status,'event_verified');assert.equal(x.posts(),1);assert.equal(h.sql('SELECT attempts FROM core.coupon_bootstrap_permits'),1);
 }finally{await h.stop();}
});
test('last DB bind rejects permit expiration even after valid K6 authorization; no event is posted',async()=>{
 const h=await bootstrapFixture({expires:'3 seconds'});try{
  const j=await h.store.rpc('coupon_bootstrap_claim_v1',{p_permit_id:h.permit});assert.equal(j.allowed,true);
  const props={...couponWelcomeProperties(j,h.cfg.qrOrigin),bootstrap_event_unique_id:j.eventUniqueId};
  const reserve=await h.store.rpc('message_send_reserve_v1',{p_business_id:h.business,p_customer_id:j.customerId,p_message_key:j.messageKey,p_message_kind:'flow',p_payload_sha256:createHash('sha256').update(JSON.stringify(props)).digest('hex')});
  const lease=await h.store.rpc('message_send_claim_v1',{p_reservation_id:reserve.reservationId});
  assert.equal((await h.store.rpc('message_send_context_v1',{p_reservation_id:reserve.reservationId,p_lease_id:lease.leaseId})).allowed,true);
  h.sql('SELECT pg_sleep(3.1) IS NULL');
  await assert.rejects(h.store.rpc('coupon_bootstrap_dispatch_bind_v1',{p_permit_id:h.permit,p_job_id:j.jobId,p_job_lease_id:j.jobLeaseId,p_reservation_id:reserve.reservationId,p_profile_id:h.profileId}));
  assert.equal(h.sql('SELECT count(*) FROM core.coupon_bootstrap_audit WHERE event_type=\'dispatch_bound\''),0);
 }finally{await h.stop();}
});
