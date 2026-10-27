// Owned native PG18.6, loopback-only fixture; no provider or hosted database.
import test,{after} from 'node:test';import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {spawn} from 'node:child_process';
import {processCouponWelcome} from '../functions/_lib/couponWelcome.ts';
import {reconcileCouponDelivery} from '../functions/_lib/couponDelivery.ts';
import {fixture,repo} from './fixtures/customerTestClassificationNative.mjs';
const h=await fixture({currentCouponSchema:true});after(()=>h.stop());
const q=h.literal,B=h.business,OTHER=randomUUID();
await h.sql(await readFile(join(repo,'supabase/migrations/20261024000200_coupon_first_event_bootstrap.sql'),'utf8'));
const invariant=()=>h.sql(`SELECT jsonb_object_agg(p.oid::text,md5(pg_get_functiondef(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('core','public') AND(p.proname LIKE 'message_send_%' OR p.proname LIKE 'coupon_welcome_%' OR p.proname LIKE 'coupon_bootstrap_%')`);
const before=invariant();h.sql(await readFile(join(repo,'tools/test-env/welcome-automation/forward-candidate.sql'),'utf8'));
const call=(name,args={})=>h.sql(`SELECT public.${name}(${Object.entries(args).map(([k,v])=>`${k}=>${q(typeof v==='object'?JSON.stringify(v):v)}`).join(',')})`,{service:true});
const start=(id=randomUUID())=>({id,...call('coupon_automation_start_v1',{p_business_id:B,p_run_id:id})});
const next=(run,kind='dispatch',business=B)=>call('coupon_automation_next_v1',{p_business_id:business,p_run_id:run.id,p_run_token:run.runToken,p_kind:kind});
const end=run=>call('coupon_automation_finish_v1',{p_business_id:B,p_run_id:run.id,p_run_token:run.runToken});
const record=(run,n,outcome,kind='dispatch')=>call('coupon_automation_record_v1',{p_business_id:B,p_run_id:run.id,p_run_token:run.runToken,p_kind:kind,p_attempt_id:n.attemptId,p_outcome:outcome});
const offer=randomUUID(),campaign=randomUUID();
h.sql(`INSERT INTO core.offers(id,business_id,name,starts_at,ends_at,active,is_test) VALUES('${offer}','${B}','Synthetic automation',current_date-1,current_date+30,true,false);
 INSERT INTO core.campaigns(id,business_id,offer_id,name,benefit_type,target_clover_item_id,benefit_code,min_amount_cents,include_tax,include_tip,order_type_ids,starts_at,ends_at,tz_name,eligibility,max_units_per_order,period,status,is_test,campaign_kind,coupon_channels,coupon_order_type_map,vip_list_id)
 VALUES('${campaign}','${B}','${offer}','Synthetic automation','item','LOCALSIMIT01','SIMIT',3000,false,false,ARRAY['LOCALDINE01','LOCALPICK01','LOCALDELV01'],clock_timestamp()-interval '1 hour',NULL,'America/New_York','subscribed_only',1,'campaign','active',false,'signup_reward',ARRAY['dine_in','site_pickup','site_delivery'],'{"LOCALDINE01":"dine_in","LOCALPICK01":"site_pickup","LOCALDELV01":"site_delivery"}','LOCAL_VIP_LIST');`);
function customer(){const email='automation-'+randomUUID()+'@fixture.test';h.sql(`SELECT public.submit_signup_once('${randomUUID()}','${B}','Local ordinary fixture',${q(email)},NULL,'website_vip_page',true,false,'{}',NULL)`,{service:true});
 const person=h.sql(`SELECT jsonb_build_object('customer',c.id,'signup',s.id) FROM core.customers c JOIN core.signups s ON s.customer_id=c.id WHERE c.email=${q(email)}`);
 const profile='PROFILE_'+randomUUID().replaceAll('-','');const evidence={source:'klaviyo',listId:'LOCAL_VIP_LIST',doubleOptIn:true,canReceiveEmailMarketing:true,consent:'SUBSCRIBED',emailSha256:createHash('sha256').update(email).digest('hex')};
 h.sql(`SELECT public.coupon_record_confirmed_vip_v1('${B}','${person.customer}','${person.signup}',${q(profile)},clock_timestamp(),clock_timestamp(),${q(JSON.stringify(evidence))})`,{service:true});
 return {...person,email,profile,coupon:h.sql(`SELECT to_jsonb(id) FROM core.campaign_coupons WHERE customer_id='${person.customer}'`)};}
test('forward candidate parses without changing existing K6/Welcome/bootstrap functions',()=>assert.deepEqual(invariant(),before));
test('missing/default-disabled settings create no run',()=>{const r=start();assert.equal(r.allowed,false);assert.equal(r.code,'disabled');assert.equal(h.sql('SELECT count(*) FROM core.coupon_automation_runs'),0);h.sql(`INSERT INTO core.coupon_automation_settings(business_id) VALUES('${B}')`);assert.equal(start().code,'disabled');});
test('RLS and service-only grants deny browser and direct private reads',()=>{for(const t of ['settings','runs','dispatch_attempts','receipt_polls']){assert.equal(h.sql(`SELECT relrowsecurity FROM pg_class WHERE oid='core.coupon_automation_${t}'::regclass`),true);for(const role of ['anon','authenticated','service_role'])assert.equal(h.sql(`SELECT has_table_privilege('${role}','core.coupon_automation_${t}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')`),false);}for(const role of ['anon','authenticated'])assert.equal(h.sql(`SELECT has_function_privilege('${role}','public.coupon_automation_start_v1(uuid,uuid)','EXECUTE')`),false);});
test('run lease, replay and missing normal setup are fail closed',()=>{h.sql(`UPDATE core.coupon_automation_settings SET enabled=true,review_ref='local-reviewed-fixture' WHERE business_id='${B}'`);const r=start();assert.equal(r.allowed,true);assert.equal(start().code,'busy');assert.equal(start(r.id).code,'replay');assert.equal(next(r).code,'normal_setup_pending');assert.throws(()=>next(r,'dispatch',OTHER));assert.throws(()=>next({...r,runToken:randomUUID()}));assert.equal(end(r).acknowledged,true);assert.equal(start(r.id).code,'replay');});
test('one durable exact dispatch attempt survives unconfirmed queued HTTP and cannot be retried',()=>{h.sql(`INSERT INTO core.message_send_settings(business_id,enabled) VALUES('${B}',true);INSERT INTO core.coupon_delivery_settings(business_id,enabled,account_id,flow_id,message_id,received_metric_id,review_ref) VALUES('${B}',true,'ACCOUNT','PERMANENT','MESSAGE','METRIC','local-review');`);
 const x=customer(),run=start(),n=next(run);assert.equal(n.allowed,true);assert.equal(n.couponId,x.coupon);assert.equal(next(run).code,'limit');assert.equal(record(run,n,'unknown').acknowledged,true);assert.equal(end(run).acknowledged,true);
 assert.equal(h.sql(`SELECT to_jsonb(status) FROM core.coupon_welcome_outbox WHERE coupon_id='${x.coupon}'`),'queued');const another=start();assert.equal(next(another).code,'queue_empty');end(another);
 assert.notEqual(h.raw(`DELETE FROM core.coupon_automation_dispatch_attempts WHERE id='${n.attemptId}'`).status,0);assert.notEqual(h.raw(`UPDATE core.coupon_automation_dispatch_attempts SET outcome='attempted' WHERE id='${n.attemptId}'`).status,0);
});

let accepted;
test('actual ordinary processor uses durable attempt and K6 before one synthetic provider event',async()=>{
 const x=customer(),run=start(),n=next(run);assert.equal(n.couponId,x.coupon);let events=0;
 const store={rpc:(name,args)=>Promise.resolve(call(name,args))};
 const provider={mode:'live',async get(path){if(path==='/accounts')return {data:[{id:'ACCOUNT'}]};assert.equal(path,'/profiles');return {data:[{id:x.profile,attributes:{email:x.email,subscriptions:{email:{marketing:{consent:'SUBSCRIBED',can_receive_email_marketing:true,suppression:[],list_suppressions:[]}}}}}]};},async eventAccount(){return {data:[{id:'ACCOUNT'}]};},async event(){events++;return {status:202};}};
 const r=await processCouponWelcome({store,provider,businessId:B,accountId:'ACCOUNT',qrOrigin:'https://owned.synthetic.invalid',couponId:x.coupon});assert.equal(r.status,'provider_accepted');assert.equal(events,1);record(run,n,'provider_accepted');end(run);
 const binding=h.sql(`SELECT to_jsonb(d) FROM core.coupon_delivery_bindings d JOIN core.coupon_welcome_outbox j ON j.id=d.job_id WHERE j.coupon_id='${x.coupon}'`);accepted={...x,binding};
 assert.equal(h.sql(`SELECT to_jsonb(status) FROM core.message_log WHERE id='${binding.reservation_id}'`),'unknown');
});
test('native receipt candidate backoff does not reopen dispatch or fabricate delivery',()=>{const r=start(),n=next(r,'receipt');assert.equal(n.allowed,true);assert.equal(n.couponId,accepted.coupon);assert.equal(n.attemptId,accepted.binding.id);assert.throws(()=>record(r,n,'delivered','receipt'));record(r,n,'pending','receipt');end(r);const again=start();assert.equal(next(again,'receipt').code,'queue_empty');assert.equal(next(again).code,'queue_empty');end(again);});
test('exact native receipt records once while immutable K6 unknown stays byte-identical',async()=>{
 h.sql(`UPDATE core.coupon_automation_receipt_polls SET next_check_at=clock_timestamp()-interval '1 second' WHERE binding_id='${accepted.binding.id}'`);
 const r=start(),n=next(r,'receipt');assert.equal(n.allowed,true);const before=h.sql(`SELECT to_jsonb(m) FROM core.message_log m WHERE id='${accepted.binding.reservation_id}'`);const at=new Date().toISOString();let reads=0;
 const store={rpc:(name,args)=>Promise.resolve(call(name,args))};const provider={mode:'live',async get(path){reads++;if(path==='/accounts')return {data:[{id:'ACCOUNT'}]};if(path==='/metrics/METRIC')return {data:{id:'METRIC',attributes:{name:'Received Email',integration:{name:'Klaviyo',category:'Internal'}}}};assert.equal(path,'/events');return {data:[{id:'RECEIPT_LOCAL',attributes:{datetime:at,event_properties:{$flow:'PERMANENT',$message:'MESSAGE'}},relationships:{profile:{data:{id:accepted.profile}},metric:{data:{id:'METRIC'}}}}],links:{next:null}};}};
 const result=await reconcileCouponDelivery({store,provider,businessId:B,couponId:accepted.coupon,accountId:'ACCOUNT'});assert.equal(result.status,'delivered');assert.equal(reads,3);record(r,n,'delivered','receipt');assert.equal(record(r,n,'pending','receipt').acknowledged,false);end(r);
 assert.deepEqual(h.sql(`SELECT to_jsonb(m) FROM core.message_log m WHERE id='${accepted.binding.reservation_id}'`),before);const again=start();assert.equal(next(again,'receipt').code,'queue_empty');end(again);
});
test('paused settings stop next claim without mutating outbox',()=>{const x=customer(),r=start();h.sql(`UPDATE core.coupon_automation_settings SET enabled=false WHERE business_id='${B}'`);assert.equal(next(r).code,'paused');assert.equal(h.sql(`SELECT to_jsonb(status) FROM core.coupon_welcome_outbox WHERE coupon_id='${x.coupon}'`),'queued');end(r);h.sql(`UPDATE core.coupon_automation_settings SET enabled=true WHERE business_id='${B}'`);const fresh=start(),n=next(fresh);assert.equal(n.couponId,x.coupon);record(fresh,n,'unknown');end(fresh);});
test('local unsubscribe after coupon creation never becomes a dispatch candidate',()=>{const x=customer();h.sql(`UPDATE core.customers SET email_status='unsubscribed' WHERE id='${x.customer}'`);const r=start();assert.equal(next(r).code,'queue_empty');end(r);});
async function concurrent(text){
 assert.equal(h.identity.host,'127.0.0.1');const exe=join(process.env.USERPROFILE,'scoop/apps/postgresql/18.6-4/bin/psql.exe');
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','COMSPEC','PATHEXT'].includes(k.toUpperCase())));
 Object.assign(env,{PGCLIENTENCODING:'UTF8',PGCONNECT_TIMEOUT:'2',PGPASSFILE:join(h.identity.data,'nonexistent-synthetic-password-file')});
 return new Promise((res,rej)=>{const child=spawn(exe,['-X','-q','-w','-h','127.0.0.1','-p',String(h.identity.port),'-U','postgres','-d',h.identity.database,'-v','ON_ERROR_STOP=1','-At'],{env,windowsHide:true});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',rej);child.on('exit',code=>code===0?res(JSON.parse(out.trim().split(/\r?\n/).filter(x=>x.startsWith('{')).at(-1))):rej(Error(err)));child.stdin.end("BEGIN;SET request.jwt.claim.role='service_role';SET ROLE service_role;"+text+";SELECT pg_sleep(0.05);COMMIT;");});
}
test('native two-session run race admits exactly one business runner',async()=>{const ids=[randomUUID(),randomUUID()];const values=await Promise.all(ids.map(id=>concurrent(`SELECT public.coupon_automation_start_v1('${B}','${id}')`)));assert.equal(values.filter(x=>x.allowed).length,1);const i=values.findIndex(x=>x.allowed);assert.equal(values[1-i].code,'busy');end({id:ids[i],runToken:values[i].runToken});});
test('native two-session same-token candidate race marks at most one exact coupon',async()=>{const x=customer(),r=start();const values=await Promise.all([0,1].map(()=>concurrent(`SELECT public.coupon_automation_next_v1('${B}','${r.id}','${r.runToken}','dispatch')`)));assert.equal(values.filter(x=>x.allowed).length,1);const n=values.find(x=>x.allowed);assert.equal(n.couponId,x.coupon);assert.equal(values.find(x=>!x.allowed).code,'limit');assert.equal(h.sql(`SELECT count(*) FROM core.coupon_automation_dispatch_attempts WHERE coupon_id='${x.coupon}'`),1);record(r,n,'unknown');end(r);});
test('expired native run cannot claim; old request ID remains replay after lease turnover',()=>{const r=start();h.sql(`UPDATE core.coupon_automation_runs SET created_at=clock_timestamp()-interval '4 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE business_id='${B}' AND run_id='${r.id}'`);assert.throws(()=>next(r));const fresh=start();assert.equal(fresh.allowed,true);assert.equal(start(r.id).code,'replay');end(fresh);});
test('terminal dispatch audit cannot be truncated or retargeted',()=>{assert.notEqual(h.raw('TRUNCATE core.coupon_automation_dispatch_attempts').status,0);assert.notEqual(h.raw(`UPDATE core.coupon_automation_dispatch_attempts SET coupon_id='${accepted.coupon}' WHERE coupon_id<>'${accepted.coupon}'`).status,0);assert.deepEqual(invariant(),before);});

function variantClaim(x,{couponTest=false,userTest=false,campaignTest=false,status='active',starts="clock_timestamp()-interval '1 hour'",ends='NULL'}={}){
 const ca=randomUUID(),cp=randomUUID(),job=randomUUID(),run=randomUUID();
 const result=h.raw(`BEGIN;
 INSERT INTO core.campaigns SELECT (jsonb_populate_record(NULL::core.campaigns,to_jsonb(c)||jsonb_build_object('id','${ca}','is_test',${campaignTest},'status','${status}','starts_at',${starts},'ends_at',${ends}))).* FROM core.campaigns c WHERE c.id='${campaign}';
 INSERT INTO core.campaign_coupons SELECT (jsonb_populate_record(NULL::core.campaign_coupons,to_jsonb(c)||jsonb_build_object('id','${cp}','campaign_id','${ca}','code',core.coupon_random_code_v1(),'qr_token',encode(extensions.gen_random_bytes(16),'hex'),'is_test',${couponTest}))).* FROM core.campaign_coupons c WHERE c.id='${x.coupon}';
 INSERT INTO core.coupon_welcome_outbox(business_id,coupon_id,message_key,event_unique_id) VALUES('${B}','${cp}','coupon-welcome:${cp}','${job}');
 ${userTest?`UPDATE core.customers SET is_test=true WHERE id='${x.customer}';`:''}
 SET request.jwt.claim.role='service_role';
 CREATE TEMP TABLE variant_run AS SELECT public.coupon_automation_start_v1('${B}','${run}') AS body;
 CREATE TEMP TABLE variant_result AS SELECT public.coupon_automation_next_v1('${B}','${run}',(SELECT (body->>'runToken')::uuid FROM variant_run),'dispatch') AS body;
 SELECT body||jsonb_build_object('attempts',(SELECT count(*) FROM core.coupon_automation_dispatch_attempts WHERE coupon_id='${cp}')) FROM variant_result;ROLLBACK;`);
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout.trim().split(/\r?\n/).filter(v=>v.startsWith('{')).at(-1));
}
function consumeWithoutHttp(x){const r=start(),n=next(r);assert.equal(n.couponId,x.coupon);record(r,n,'unknown');end(r);}

test('all three synthetic markers and inactive campaign exclude queued dispatch',()=>{
 const x=customer();consumeWithoutHttp(x);
 for(const variant of [{couponTest:true},{userTest:true},{campaignTest:true},{status:'stopped'}]){
  const n=variantClaim(x,variant);assert.equal(n.allowed,false);assert.equal(n.code,'queue_empty');assert.equal(n.attempts,0);
 }
 const normal=variantClaim(x);assert.equal(normal.allowed,true);assert.equal(normal.attempts,1);
});

test('status requires authenticated target membership and reveals counts only',()=>{
 const owner=randomUUID(),outside=randomUUID();
 h.sql(`INSERT INTO auth.users(id) VALUES('${owner}'),('${outside}');INSERT INTO core.business_staff(business_id,staff_id,role,active) VALUES('${B}','${owner}','owner',true)`);
 const read=id=>h.raw(`SET request.jwt.claim.role='authenticated';SET request.jwt.claim.sub='${id}';SET ROLE authenticated;SELECT public.coupon_automation_status_v1('${B}')`);
 const allowed=read(owner);assert.equal(allowed.status,0);const status=JSON.parse(allowed.stdout.trim().split(/\r?\n/).at(-1));
 assert.deepEqual(Object.keys(status).sort(),['blockedAttempts','enabled','receiptPending','unconfirmedAttempts']);
 assert.equal(status.enabled,true);assert.notEqual(read(outside).status,0);
 assert.notEqual(h.raw(`SET request.jwt.claim.role='anon';SET ROLE anon;SELECT public.coupon_automation_status_v1('${B}')`).status,0);
 assert.notEqual(h.raw(`SELECT public.coupon_automation_status_v1('${B}')`,{service:true}).status,0);
 h.sql(`UPDATE core.business_staff SET active=false WHERE business_id='${B}' AND staff_id='${owner}'`);assert.notEqual(read(owner).status,0);
});

test('K6 167h is skipped without burning an attempt; 168h and 169h become eligible',()=>{
 const x=customer();
 for(const hours of [167,168,169]){
  const runId=randomUUID();
  // Transaction-owned clock-age fixture rolls back completely, so immutable
  // message history is never rewritten to simulate time passing.
  const result=h.raw(`BEGIN;
   INSERT INTO core.message_log(business_id,customer_id,message_key,message_kind,payload_sha256,recipient_sha256,identity_sha256,status,lease_id,reserved_at,reservation_expires_at,claimed_at,dispatch_authorized_at,sent_at)
   VALUES('${B}','${x.customer}','local-window-${hours}','campaign',repeat('a',64),repeat('b',64),repeat('c',64),'sent',gen_random_uuid(),clock_timestamp()-interval '${hours+1} hours',clock_timestamp()-interval '${hours} hours',clock_timestamp()-interval '${hours+1} hours',clock_timestamp()-interval '${hours+1} hours',clock_timestamp()-interval '${hours} hours');
   SET request.jwt.claim.role='service_role';
   CREATE TEMP TABLE local_run AS SELECT public.coupon_automation_start_v1('${B}','${runId}') AS body;
   SELECT public.coupon_automation_next_v1('${B}','${runId}',(SELECT (body->>'runToken')::uuid FROM local_run),'dispatch');ROLLBACK;`);
  assert.equal(result.status,0,result.stderr);const n=JSON.parse(result.stdout.trim().split(/\r?\n/).filter(v=>v.startsWith('{')).at(-1));assert.equal(n.allowed,hours>=168);if(n.allowed)assert.equal(n.couponId,x.coupon);
  assert.equal(h.sql(`SELECT count(*) FROM core.coupon_automation_dispatch_attempts WHERE coupon_id='${x.coupon}'`),0);
 }
 const r=start(),n=next(r);assert.equal(n.couponId,x.coupon);record(r,n,'unknown');end(r);
});

test('future and ended campaign do not consume an attempt; in-range campaign is eligible',()=>{
 const x=customer();consumeWithoutHttp(x);
 for(const variant of [{starts:"clock_timestamp()+interval '1 day'"},{starts:"clock_timestamp()-interval '2 days'",ends:"clock_timestamp()-interval '1 day'"}]){
  const n=variantClaim(x,variant);assert.equal(n.allowed,false);assert.equal(n.attempts,0);
 }
 const n=variantClaim(x);assert.equal(n.allowed,true);assert.equal(n.attempts,1);
});

test('consumer -> actual Cloudflare route -> native PG -> paced synthetic provider -> receipt',async()=>{
 const {normalConsumerNativeChain}=await import('./fixtures/couponAutomationChain.mjs');
 await normalConsumerNativeChain({h,call,customer,business:B,repo});
});
