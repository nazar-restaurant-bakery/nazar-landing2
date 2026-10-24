// Full captured schema + real K3/K4/K5/K6/K9/K10/receipt DDL, owned PG18.6 only.
// Fresh synthetic logical ordinary records are created locally; no flag is flipped,
// no hosted identity/provider/customer/key is used or sent.
import test,{after} from 'node:test';import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import {spawn} from 'node:child_process';
import {fixture,repo} from './fixtures/customerTestClassificationNative.mjs';
import {processCouponBootstrap,verifyCouponBootstrapEvent,couponEventPropertiesMatch} from '../functions/_lib/couponBootstrap.ts';
import {reconcileCouponDelivery} from '../functions/_lib/couponDelivery.ts';
const h=await fixture({currentCouponSchema:true});after(()=>h.stop());
const q=h.literal,path='supabase/migrations/20261024000200_coupon_first_event_bootstrap.sql';
const snapshot=()=>h.sql(`SELECT jsonb_object_agg(oid::text,md5(pg_get_functiondef(oid))) FROM pg_proc WHERE oid IN(
 'public.message_send_reserve_v1(uuid,uuid,text,text,text)'::regprocedure,'public.message_send_claim_v1(uuid)'::regprocedure,
 'public.message_send_context_v1(uuid,uuid)'::regprocedure,'public.message_send_finalize_v1(uuid,uuid,text)'::regprocedure,
 'core.message_send_window_blocked_v1(uuid,uuid,uuid)'::regprocedure)`);
const before=snapshot();h.sql(await readFile(join(repo,path),'utf8'));
const actor=randomUUID(),staff=randomUUID(),onlyPlatform=randomUUID();
h.sql(`INSERT INTO auth.users(id) VALUES('${actor}'),('${staff}'),('${onlyPlatform}');
 INSERT INTO core.business_staff(business_id,staff_id,role,active) VALUES('${h.business}','${actor}','owner',true),('${h.business}','${staff}','staff',true);
 INSERT INTO core.platform_operators(staff_id,active) VALUES('${actor}',true),('${onlyPlatform}',true);
 INSERT INTO core.message_send_settings(business_id,enabled) VALUES('${h.business}',true);`);
const offer=randomUUID(),campaign=randomUUID(),list='LOCAL_VIP_LIST',profileId='LOCAL_PROFILE';
h.sql(`INSERT INTO core.offers(id,business_id,name,starts_at,ends_at,active,is_test) VALUES('${offer}','${h.business}','Local coupon',current_date-1,current_date+30,true,false);
 INSERT INTO core.campaigns(id,business_id,offer_id,name,benefit_type,target_clover_item_id,benefit_code,min_amount_cents,include_tax,include_tip,order_type_ids,starts_at,ends_at,tz_name,eligibility,max_units_per_order,period,status,is_test,campaign_kind,coupon_channels,coupon_order_type_map,vip_list_id)
 VALUES('${campaign}','${h.business}','${offer}','Local coupon','item','LOCALSIMIT01','SIMIT',3000,false,false,ARRAY['LOCALDINE01','LOCALPICK01','LOCALDELV01'],clock_timestamp()-interval '1 hour',NULL,'America/New_York','subscribed_only',1,'campaign','active',false,'signup_reward',ARRAY['dine_in','site_pickup','site_delivery'],'{"LOCALDINE01":"dine_in","LOCALPICK01":"site_pickup","LOCALDELV01":"site_delivery"}','${list}');`);
const email='local-'+randomUUID()+'@fixture.test';
h.sql(`SELECT public.submit_signup_once('${randomUUID()}','${h.business}','Local ordinary fixture',${q(email)},NULL,'website_vip_page',true,false,'{}',NULL)`,{service:true});
const person=h.sql(`SELECT jsonb_build_object('customerId',c.id,'signupId',s.id) FROM core.customers c JOIN core.signups s ON s.customer_id=c.id WHERE c.email=${q(email)}`);
const evidence={source:'klaviyo',listId:list,doubleOptIn:true,canReceiveEmailMarketing:true,consent:'SUBSCRIBED',emailSha256:createHash('sha256').update(email).digest('hex')};
h.sql(`SELECT public.coupon_record_confirmed_vip_v1('${h.business}','${person.customerId}','${person.signupId}','${profileId}',clock_timestamp(),clock_timestamp(),${q(JSON.stringify(evidence))})`,{service:true});
const coupon=h.sql(`SELECT to_jsonb(id) FROM core.campaign_coupons WHERE customer_id='${person.customerId}'`);
const auth=(text,id=actor)=>h.sql(`SET request.jwt.claim.role='authenticated';SET request.jwt.claim.sub='${id}';`+text,{role:'authenticated'});
const rawAuth=(text,id)=>h.raw(`SET request.jwt.claim.role='authenticated';SET request.jwt.claim.sub='${id}';`+text,{role:'authenticated'});
const grant=()=>`SELECT public.coupon_bootstrap_permit_v1('${h.business}','${coupon}','LOCAL_ACCOUNT','https://owned.invalid','local-bootstrap-review','${'a'.repeat(64)}',clock_timestamp()+interval '20 minutes',clock_timestamp()+interval '3 days',true)`;
let permit,body,posts=0;
const secondEmail='other-'+randomUUID()+'@fixture.test';
h.sql(`SELECT public.submit_signup_once('${randomUUID()}','${h.business}','Another local fixture',${q(secondEmail)},NULL,'website_vip_page',true,false,'{}',NULL)`,{service:true});
const secondPerson=h.sql(`SELECT jsonb_build_object('customer',c.id,'signup',s.id) FROM core.customers c JOIN core.signups s ON s.customer_id=c.id WHERE c.email=${q(secondEmail)}`);
h.sql(`SELECT public.coupon_record_confirmed_vip_v1('${h.business}','${secondPerson.customer}','${secondPerson.signup}','LOCAL_PROFILE_SECOND',clock_timestamp(),clock_timestamp(),${q(JSON.stringify({...evidence,emailSha256:createHash('sha256').update(secondEmail).digest('hex')}))})`,{service:true});
const cfg={mode:'live',isolated:false,url:'https://never-contacted.invalid',serviceKey:'sb_secret_synthetic',processKey:'s'.repeat(64),businessId:h.business,accountId:'LOCAL_ACCOUNT',readKey:'pk_synthetic_read',eventKey:'pk_synthetic_event',receiptKey:'pk_synthetic_receipt',qrOrigin:'https://owned.invalid',approvalId:'local-review-only'};
const calls=[];const store={async rpc(name,args){calls.push(name);const keys=Object.entries(args).map(([k,v])=>k+'=>'+(v===null?'NULL':q(typeof v==='object'?JSON.stringify(v):v)));const expression=`SELECT public.${name}(${keys.join(',')})`;return name==='coupon_bootstrap_claim_v1'?sqlAsync("SET request.jwt.claim.role='service_role';SET ROLE service_role;"+expression):h.sql(expression,{service:true});}};
const profile=()=>({id:profileId,attributes:{email,subscriptions:{email:{marketing:{consent:'SUBSCRIBED',can_receive_email_marketing:true,double_optin:true,consent_timestamp:new Date().toISOString(),suppression:[],list_suppressions:[]}}}}});
const metric={type:'metric',id:'LOCAL_METRIC',attributes:{name:'Nazar Coupon Welcome Authorized',integration:{id:'API_LOCAL',name:'API',category:'API'}}};
const provider={coupon:{mode:'live',async get(path){return path==='/accounts'?{data:[{id:'LOCAL_ACCOUNT'}]}:{data:[profile()]};},async eventAccount(){return {data:[{id:'LOCAL_ACCOUNT'}]};},async event(b){posts++;body=structuredClone(b);return {status:202};}},async inventory(){return {accountId:'LOCAL_ACCOUNT',complete:true,metrics:posts?[metric]:[]};},async events(_p,m){if(!m)return {data:[]};const props=structuredClone(body.data.attributes.properties);delete props.expires_at;props.$event_id=body.data.attributes.unique_id;return {data:[{type:'event',id:'PROVIDER_EVENT',attributes:{datetime:new Date().toISOString(),uuid:'PROVIDER_GENERATED_DIFFERENT',event_properties:props},relationships:{profile:{data:{id:profileId}},metric:{data:{id:'LOCAL_METRIC'}}}}],links:{next:null}};}};
const run=()=>processCouponBootstrap({config:cfg,store,provider,permitId:permit});
function sqlAsync(text){const bin=join(process.env.USERPROFILE,'scoop/apps/postgresql/18.6-4/bin/psql.exe');const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','COMSPEC','PATHEXT'].includes(k.toUpperCase())));return new Promise((resolve,reject)=>{const p=spawn(bin,['-X','-q','-w','-h','127.0.0.1','-p',String(h.identity.port),'-U','postgres','-d',h.identity.database,'-At','-v','ON_ERROR_STOP=1'],{windowsHide:true,env:{...env,PGPASSFILE:join(repo,'not-a-password-file'),PGCONNECT_TIMEOUT:'2'}});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('exit',code=>code?reject(Error(err)):resolve(JSON.parse(out.trim().split(/\r?\n/).at(-1))));p.stdin.end(text);});}
test('K6 function hashes unchanged and bootstrap tables are private/RLS',()=>{assert.deepEqual(snapshot(),before);for(const t of ['coupon_bootstrap_permits','coupon_bootstrap_audit']){assert.equal(h.sql(`SELECT relrowsecurity FROM pg_class WHERE oid='core.${t}'::regclass`),true);for(const r of ['anon','authenticated','service_role'])assert.equal(h.sql(`SELECT has_table_privilege('${r}','core.${t}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')`),false);}});
test('only platform operator with target write membership can grant; no seed/settings are enabled',()=>{for(const id of [staff,onlyPlatform])assert.notEqual(rawAuth(grant(),id).status,0);assert.notEqual(h.raw(`SET request.jwt.claim.sub='${actor}';`+grant(),{service:true}).status,0);assert.equal(h.sql('SELECT count(*) FROM core.coupon_bootstrap_permits'),0);permit=auth(grant()).permitId;assert.ok(permit);});
test('normal worker cannot steal reviewed bootstrap job',()=>{const x=h.sql(`SELECT public.coupon_welcome_claim_v1('${h.business}','${coupon}')`,{service:true});assert.equal(x.allowed,false);assert.equal(x.code,'bootstrap_setup_pending');assert.equal(h.sql('SELECT count(*) FROM core.message_log'),0);const other=h.sql(`SELECT public.coupon_welcome_claim_v1('${h.business}',NULL)`,{service:true});assert.equal(other.code,'bootstrap_setup_pending');assert.equal(h.sql(`SELECT count(*) FROM core.coupon_welcome_outbox WHERE status='queued'`),2);});
let results;
test('two concurrent complete workers yield one real DB claim and one provider event',async()=>{
 results=await Promise.all([run(),run()]);assert.equal(results.filter(x=>x.status==='provider_accepted').length,1,JSON.stringify(results));assert.equal(posts,1);
 const state=h.sql(`SELECT jsonb_build_object('attempts',attempts,'state',state) FROM core.coupon_bootstrap_permits WHERE id='${permit}'`);assert.deepEqual(state,{attempts:1,state:'awaiting_event'});
 assert.equal(h.sql(`SELECT count(*) FROM core.coupon_bootstrap_audit WHERE event_type='claimed'`),1);
});
test('single K6 dispatch keeps 202 unknown; retry never claims or posts again',async()=>{
 assert.equal(results.find(x=>x.status==='provider_accepted').activationReady,false);
 assert.equal(body.data.attributes.properties.bootstrap_event_unique_id,body.data.attributes.unique_id);assert.equal(h.sql(`SELECT to_jsonb(status) FROM core.message_log`),'unknown');
 await run();assert.equal(posts,1);assert.deepEqual(snapshot(),before);
});
test('readback accepts documented $event_id/null omission, proves one original event without another POST',async()=>{assert.equal(couponEventPropertiesMatch({a:1,$event_id:'id'},{a:1,expires_at:null},'id'),true);const r=await verifyCouponBootstrapEvent({config:cfg,store,provider,permitId:permit});assert.equal(r.status,'event_verified',JSON.stringify(r));assert.equal(posts,1);});
let binding;
const review=()=>{const p=h.sql(`SELECT to_jsonb(p) FROM core.coupon_bootstrap_permits p`);return {accountId:p.account_id,metricId:p.metric_id,profileId:p.profile_id,couponId:coupon,eventUniqueId:p.event_unique_id,payloadSha256:p.payload_sha256,flowId:'LOCAL_FLOW',messageId:'LOCAL_MESSAGE',receivedMetricId:'SJmF2C',receivedMetricName:'Received Email',receivedIntegration:'Klaviyo/Internal',messageStatus:'manual',messageCount:1,otherActions:0,queueCount:1,queueStatus:'needs_review',queueProfileId:p.profile_id,renderedPayloadSha256:p.payload_sha256,delayMinutes:1440,reviewedAt:new Date().toISOString(),evidenceSha256:'b'.repeat(64)};};
test('late binding rejects wrong recipient, extra queue, Flow, message and service actor',()=>{for(const patch of [{queueCount:2},{queueProfileId:'OTHER'},{flowId:'OTHER'},{messageId:'OTHER'},{messageStatus:'live'},{otherActions:1}]){const x={...review(),...patch};assert.notEqual(rawAuth(`SELECT public.coupon_bootstrap_late_bind_v1('${permit}','LOCAL_FLOW','LOCAL_MESSAGE','SJmF2C',${q(JSON.stringify(x))})`,actor).status,0);}assert.notEqual(h.raw(`SELECT public.coupon_bootstrap_late_bind_v1('${permit}','LOCAL_FLOW','LOCAL_MESSAGE','SJmF2C',${q(JSON.stringify(review()))})`,{service:true}).status,0);});
test('human reviewed single Manual queue can late bind original unknown only once',()=>{const x=auth(`SELECT public.coupon_bootstrap_late_bind_v1('${permit}','LOCAL_FLOW','LOCAL_MESSAGE','SJmF2C',${q(JSON.stringify(review()))})`);binding=x.bindingId;assert.ok(binding);assert.equal(x.activationReady,false);assert.equal(h.sql('SELECT count(*) FROM core.coupon_delivery_bindings'),1);assert.notEqual(rawAuth(`SELECT public.coupon_bootstrap_late_bind_v1('${permit}','LOCAL_FLOW','LOCAL_MESSAGE','SJmF2C',${q(JSON.stringify(review()))})`,actor).status,0);});
test('only real native receipt closes delivery; K6 unknown stays immutable and window stays blocked',async()=>{const context=h.sql(`SELECT public.coupon_delivery_context_v1('${h.business}','${coupon}')`,{service:true});
 const read={mode:'live',async get(path){if(path==='/accounts')return {data:[{id:'LOCAL_ACCOUNT'}]};if(path==='/metrics/SJmF2C')return {data:{id:'SJmF2C',attributes:{name:'Received Email',integration:{name:'Klaviyo',category:'Internal'}}}};return {data:[{id:'NATIVE_RECEIVED',attributes:{datetime:new Date().toISOString(),event_properties:{$flow:'LOCAL_FLOW',$message:'LOCAL_MESSAGE'}},relationships:{profile:{data:{id:profileId}},metric:{data:{id:'SJmF2C'}}}}],links:{next:null}};}};
 assert.equal(context.bindingId,binding);const result=await reconcileCouponDelivery({store,provider:read,businessId:h.business,couponId:coupon,accountId:'LOCAL_ACCOUNT'});assert.equal(result.status,'delivered',JSON.stringify(result));assert.equal(result.activationReady,false);assert.equal(posts,1);assert.equal(h.sql('SELECT to_jsonb(status) FROM core.message_log'),'unknown');assert.equal(h.sql(`SELECT core.message_send_window_blocked_v1('${h.business}','${person.customerId}',NULL)`),true);assert.deepEqual(snapshot(),before);
});
test('bootstrap audit and consumed permit cannot be erased or rearmed',()=>{for(const sql of ["DELETE FROM core.coupon_bootstrap_audit","TRUNCATE core.coupon_bootstrap_audit","UPDATE core.coupon_bootstrap_permits SET attempts=0","DELETE FROM core.coupon_bootstrap_permits"])assert.notEqual(h.raw(sql).status,0);});

test('normal second coupon stays queued until first receipt and separate permanent Flow; first never re-enters',()=>{
 assert.equal(h.sql(`SELECT public.coupon_welcome_claim_v1('${h.business}',NULL)`,{service:true}).code,'bootstrap_setup_pending');
 assert.equal(h.sql(`SELECT public.coupon_bootstrap_record_delivery_v1('${permit}')`,{service:true}).acknowledged,true);
 assert.equal(h.sql(`SELECT public.coupon_welcome_claim_v1('${h.business}',NULL)`,{service:true}).code,'bootstrap_setup_pending');
 h.sql(`INSERT INTO core.coupon_delivery_settings(business_id,enabled,account_id,flow_id,message_id,received_metric_id,review_ref) VALUES('${h.business}',true,'LOCAL_ACCOUNT','PERMANENT_FLOW','PERMANENT_MESSAGE','SJmF2C','local-normal-review')`);
 const next=h.sql(`SELECT public.coupon_welcome_claim_v1('${h.business}',NULL)`,{service:true});assert.equal(next.allowed,true);assert.notEqual(next.couponId,coupon);
 assert.equal(h.sql(`SELECT public.coupon_welcome_claim_v1('${h.business}','${coupon}')`,{service:true}).allowed,false);assert.equal(posts,1);assert.deepEqual(snapshot(),before);
});
