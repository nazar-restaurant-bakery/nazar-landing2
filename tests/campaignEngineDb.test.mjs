import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {fixture} from './fixtures/campaignEngineNative.mjs';

// This suite starts a dedicated, owned loopback native PG18.6 cluster. Every
// case really runs; lack of PostgreSQL/configuration fails rather than skips.
const h=await fixture();
const checks=[];
after(async()=>{await writeFile(join(h.config.run,'suite-summary.json'),JSON.stringify({scope:'K9_NATIVE_SYNTHETIC_DB_TESTS',
 checks,passed:checks.filter(x=>x.passed).length,total:checks.length,hidden_skips:0,hosted_connection:false,
 real_customer_data:false,provider_calls:0,message_sends:0,fixture_only_two_tenants:true},null,2)+'\n');await h.stop();});
function check(name,body){test(name,async t=>{try{await body(t);checks.push({name,passed:true});}catch(error){checks.push({name,passed:false,error:String(error.message)});throw error;}});}
const count=(where='true')=>h.sql(`SELECT count(*) FROM core.offer_redemptions WHERE ${where}`);
const row=id=>h.sql(`SELECT to_jsonb(r) FROM core.offer_redemptions r WHERE id='${id}'`);
function rejectsSql(sql,pattern){const result=h.raw(sql);assert.notEqual(result.status,0,'SQL must fail closed');if(pattern)assert.match(result.stderr,pattern);}
async function race(t,expressionA,expressionB,label){
 const tag='k9a_'+randomUUID().replaceAll('-','');
 const sql=expression=>`SELECT json_build_object('backendPid',pg_backend_pid(),'decision',${expression});`;
 const first=h.session(`BEGIN;SET LOCAL application_name='${tag}';SET LOCAL request.jwt.claim.role='service_role';SET LOCAL ROLE service_role;`+sql(expressionA)+'SELECT pg_sleep(5);COMMIT;',tag);
 first.promise.catch(()=>{});
 t.after(()=>{if(first.child.exitCode===null)first.child.kill();});
 let locked=false;for(let n=0;n<50;n++){locked=h.sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
  WHERE a.application_name='${tag}' AND a.wait_event='PgSleep' AND l.locktype='relation' AND l.relation='core.campaigns'::regclass AND l.granted)`);if(locked)break;await new Promise(r=>setTimeout(r,40));}
 assert.equal(locked,true,'First evaluator must complete and hold campaign locks in an open transaction before the second session starts');
 const firstBackend=h.sql(`SELECT pid FROM pg_stat_activity WHERE application_name='${tag}'`);
 const secondTag='k9b_'+randomUUID().replaceAll('-','');
 const second=h.session(`BEGIN;SET LOCAL application_name='${secondTag}';SET LOCAL request.jwt.claim.role='service_role';SET LOCAL ROLE service_role;`+sql(expressionB)+'COMMIT;',secondTag);
 second.promise.catch(()=>{});
 t.after(()=>{if(second.child.exitCode===null)second.child.kill();});
 let blockingProof=null;for(let n=0;n<60;n++){
  const observed=h.sql(`SELECT json_build_object('backendPid',pid,'blockers',pg_blocking_pids(pid),'waitEventType',wait_event_type,'waitEvent',wait_event)
   FROM pg_stat_activity WHERE application_name='${secondTag}'`);
  if(observed?.waitEventType==='Lock'&&observed.blockers.includes(firstBackend)){blockingProof=observed;break;}
  await new Promise(r=>setTimeout(r,30));
 }
 assert.ok(blockingProof,'The second real backend must be observed blocked by the first before it commits');
 const results=await Promise.all([first.promise,second.promise]);const parsed=results.map(r=>JSON.parse(r.stdout.split(/\r?\n/).find(x=>x.startsWith('{'))));
 assert.notEqual(parsed[0].backendPid,parsed[1].backendPid);assert.equal(parsed[0].decision.applied,true);assert.equal(parsed[1].decision.applied,false);
 assert.equal(blockingProof.backendPid,parsed[1].backendPid);assert.ok(blockingProof.blockers.includes(parsed[0].backendPid));
 await writeFile(join(h.config.run,label+'.json'),JSON.stringify({campaignLockObserved:locked,firstEvaluatorFinishedBeforeSecondStarted:true,secondActuallyBlockedByFirst:blockingProof,
  sessionResults:parsed,distinctBackends:true},null,2)+'\n');return parsed;
}

check('eligible Clover trace creates exactly one applied redemption',()=>{
 const c=h.customer(),p=h.campaign(),o=h.order(c);const before=count();const result=h.evaluate(p,o);
 assert.equal(result.applied,true);assert.equal(result.code,'applied');assert.equal(count(),before+1);
 assert.equal(row(result.redemptionId).status,'applied');assert.equal(row(result.redemptionId).source,'clover_trace');
 rejectsSql(`UPDATE core.offer_redemptions SET customer_id='${h.customer()}' WHERE id='${result.redemptionId}'`,/IMMUTABLE/);
 rejectsSql(`UPDATE core.offer_redemptions SET snapshot='{}'::jsonb WHERE id='${result.redemptionId}'`,/IMMUTABLE/);
});
check('same order retry is idempotent while a second order in the same period is denied',()=>{
 const c=h.customer(),p=h.campaign(),o=h.order(c);const one=h.evaluate(p,o),retry=h.evaluate(p,o),second=h.evaluate(p,h.order(c));
 assert.equal(one.applied,true);assert.equal(retry.redemptionId,one.redemptionId);assert.equal(retry.code,'already_applied');
 assert.equal(second.applied,false);assert.equal(second.code,'period_limit');assert.equal(count(`campaign_id='${p}'`),1);
});
check('tenant-local week rollover permits a second redemption',()=>{
 const c=h.customer(),p=h.campaign();assert.equal(h.evaluate(p,h.order(c,{date:'2026-10-11T23:59:00-04:00'})).applied,true);
 assert.equal(h.evaluate(p,h.order(c,{date:'2026-10-12T00:01:00-04:00'})).applied,true);assert.equal(count(`campaign_id='${p}'`),2);
});
check('campaign-period and unlimited-period configurations use the same evaluator',()=>{
 const c=h.customer(),campaign=h.campaign({benefit_type:'discount',discount_percentage:20,target_clover_item_id:null,min_amount_cents:1000,order_type_ids:['DELIVERY01'],period:'campaign'});
 assert.equal(h.evaluate(campaign,h.order(c,{type:'DELIVERY01',product:'OTHERPRODUCT1',tracePercent:20})).applied,true);
 assert.equal(h.evaluate(campaign,h.order(c,{type:'DELIVERY01',date:'2026-10-11T16:00:00Z',tracePercent:20})).code,'period_limit');
 const unlimited=h.campaign({period:'unlimited',min_amount_cents:2000});
 assert.equal(h.evaluate(unlimited,h.order(c)).applied,true);assert.equal(h.evaluate(unlimited,h.order(c)).applied,true);
 const fixed=h.campaign({benefit_type:'discount',target_clover_item_id:null,discount_amount_cents:250,min_amount_cents:1000,period:'unlimited'});
 const fixedOrder=amount=>h.order(c,{raw:{raw:{discounts:{elements:[{code:'K9SYNTHETIC',amount}]}}}});
 assert.equal(h.evaluate(fixed,fixedOrder(-250)).applied,true);
 for(const amount of [0,-100,250])assert.equal(h.evaluate(fixed,fixedOrder(amount)).applied,false);
});
check('second synthetic tenant does not consume first tenant limits',()=>{
 const a=h.customer(),b=h.customer({businessId:h.config.secondBusinessId});const pa=h.campaign({max_total_units:1}),pb=h.campaign({business_id:h.config.secondBusinessId,max_total_units:1});
 assert.equal(h.evaluate(pb,h.order(b,{businessId:h.config.secondBusinessId}),{businessId:h.config.secondBusinessId}).applied,true);
 assert.equal(count(`campaign_id='${pa}'`),0);assert.equal(h.evaluate(pa,h.order(a)).applied,true);
});
check('cross-business campaign/order/customer/offer references fail closed',()=>{
 const a=h.customer(),b=h.customer({businessId:h.config.secondBusinessId}),p=h.campaign();
 assert.equal(h.evaluate(p,h.order(b,{businessId:h.config.secondBusinessId})).applied,false);
 assert.equal(h.evaluate(p,h.order(a),{businessId:h.config.secondBusinessId}).applied,false);
 const foreignOffer=h.offer({businessId:h.config.secondBusinessId});rejectsSql(`INSERT INTO core.campaigns(business_id,offer_id,name,benefit_type,discount_percentage,min_amount_cents,order_type_ids,starts_at,ends_at) VALUES('${h.config.businessId}','${foreignOffer}','Cross business','discount',20,0,ARRAY['PICKUP0001'],'2025-01-01','2030-01-01')`,/TENANT_MISMATCH|foreign key/);
 const wrong=h.order(b);assert.equal(h.evaluate(p,wrong).applied,false);assert.equal(count(`campaign_id='${p}'`),0);
 assert.equal(h.evaluate(p,h.order(a)).applied,true);
 rejectsSql(`UPDATE core.customers SET business_id='${h.config.secondBusinessId}' WHERE id='${a}'`,/foreign key/);
 rejectsSql(`UPDATE core.offers SET business_id='${h.config.secondBusinessId}' WHERE id=(SELECT offer_id FROM core.campaigns WHERE id='${p}')`,/foreign key/);
});
check('per-order units and global unit cap are enforced in the database',()=>{
 const c=h.customer(),p=h.campaign({period:'unlimited',max_units_per_order:2,max_total_units:3}),o=h.order(c,{quantity:2});
 assert.equal(h.evaluate(p,o,{units:3}).code,'per_order_limit');
 assert.equal(h.evaluate(p,o,{units:2}).applied,true);assert.equal(h.evaluate(p,h.order(c,{quantity:2}),{units:2}).code,'total_limit');
 assert.equal(h.sql(`SELECT sum(units)::int FROM core.offer_redemptions WHERE campaign_id='${p}'`),2);
});
check('wrong channel, product, inventory evidence and missing trace cannot redeem',()=>{
 const c=h.customer(),p=h.campaign();for(const [options,code] of [[{type:'DINEIN0001'},'channel_mismatch'],[{product:'WRONGPRODUCT1'},'product_mismatch'],[{trace:false},'trace_missing']]){
  assert.equal(h.evaluate(p,h.order(c,options)).code,code);}
 const o=h.order(c);h.sql(`UPDATE core.order_items SET quantity=NULL WHERE order_id='${o}'`);assert.equal(h.evaluate(p,o).applied,false);
 assert.equal(count(`campaign_id='${p}'`),0);
});
check('Clover line-item ID is not mistaken for catalog product ID',()=>{
 const c=h.customer(),p=h.campaign(),o=h.order(c,{product:'WRONGPRODUCT1'});h.sql(`UPDATE core.order_items SET clover_item_id='PRODUCT0001' WHERE order_id='${o}'`);
 assert.equal(h.evaluate(p,o).code,'product_mismatch');
});
check('global or unrelated-line code alone does not prove a free target item',()=>{
 const c=h.customer(),p=h.campaign(),globalOnly=h.order(c);h.sql(`UPDATE core.order_items SET raw_response=raw_response-'discounts' WHERE order_id='${globalOnly}'`);
 assert.equal(h.evaluate(p,globalOnly).applied,false);
 for(const pct of [0,20])assert.equal(h.evaluate(p,h.order(c,{tracePercent:pct})).applied,false);
 const deleted=h.order(c);h.sql(`UPDATE core.order_items SET raw_response=jsonb_set(raw_response,'{discounts,elements,0,deleted}','true'::jsonb) WHERE order_id='${deleted}'`);
 assert.equal(h.evaluate(p,deleted).applied,false);
 const voided=h.order(c);h.sql(`UPDATE core.order_items SET raw_response=jsonb_set(raw_response,'{discounts,elements,0,discount,voided}','true'::jsonb) WHERE order_id='${voided}'`);
 assert.equal(h.evaluate(p,voided).applied,false);
});
check('underclaiming evidenced free quantity cannot bypass configured unit limits',()=>{
 const c=h.customer(),p=h.campaign({max_units_per_order:2}),o=h.order(c,{quantity:2});
 assert.equal(h.evaluate(p,o,{units:1}).applied,false);assert.equal(count(`campaign_id='${p}'`),0);
 assert.equal(h.evaluate(p,o,{units:2}).applied,true);
});
check('inactive campaign and outside date/time/day windows deny',()=>{
 const c=h.customer();assert.equal(h.evaluate(h.campaign({status:'draft'}),h.order(c)).code,'campaign_inactive');
 assert.equal(h.evaluate(h.campaign({starts_at:'2026-11-01T00:00:00Z'}),h.order(c)).code,'outside_window');
 assert.equal(h.evaluate(h.campaign({weekdays:[1]}),h.order(c)).code,'outside_window');
 assert.equal(h.evaluate(h.campaign({local_start:'09:00',local_end:'11:00'}),h.order(c)).code,'outside_window');
});
check('tenant timezone applies across daylight-saving fallback',()=>{
 const c=h.customer(),p=h.campaign({period:'unlimited',weekdays:[7],local_start:'01:00',local_end:'02:00'});
 assert.equal(h.evaluate(p,h.order(c,{date:'2025-11-02T05:30:00Z'})).applied,true);
 assert.equal(h.evaluate(p,h.order(c,{date:'2025-11-02T06:30:00Z'})).applied,true);
 assert.equal(h.evaluate(p,h.order(c,{date:'2025-11-02T07:30:00Z'})).applied,false);
});
check('subscribed-only excludes unsubscribed and not_subscribed customers',()=>{
 const p=h.campaign();for(const status of ['unsubscribed','not_subscribed','pending_review'])assert.equal(h.evaluate(p,h.order(h.customer({status}))).code,'customer_ineligible');
 assert.equal(count(`campaign_id='${p}'`),0);
});
check('everyone never changes consent or suppression',()=>{
 const c=h.customer({status:'unsubscribed'}),p=h.campaign({eligibility:'everyone'});
 const snapshot=()=>h.sql(`SELECT json_build_object('status',email_status,'suppressed',email_suppressed_at,'events',(SELECT count(*) FROM core.consent_events)) FROM core.customers WHERE id='${c}'`);
 const before=snapshot();assert.equal(h.evaluate(p,h.order(c)).applied,true);assert.deepEqual(snapshot(),before);
});
check('net threshold uses explicit payment tax/tip rather than order total',()=>{
 const c=h.customer(),p=h.campaign({include_tax:false,include_tip:false,min_amount_cents:3000});
 assert.equal(h.evaluate(p,h.order(c,{amount:3200,paymentRaw:{taxAmount:300,tipAmount:500}})).code,'below_minimum');
 assert.equal(h.evaluate(p,h.order(c,{amount:3300,paymentRaw:{taxAmount:300,tipAmount:500}})).applied,true);
});
check('missing or malformed money evidence denies rather than assuming zero',()=>{
 const c=h.customer(),p=h.campaign({include_tax:false,include_tip:false});for(const raw of [{},{taxAmount:0},{taxAmount:'unknown',tipAmount:0}]){
  const o=h.order(c);h.sql(`UPDATE core.payments SET raw_response=${h.literal(JSON.stringify(raw))}::jsonb WHERE order_id='${o}'`);assert.equal(h.evaluate(p,o).code,'amount_evidence_missing');}
 for(const marker of [false,null,'true']){
  const o=h.order(c,{raw:{refundsVerified:marker}});assert.equal(h.evaluate(p,o).code,'amount_evidence_missing');
 }
 const missing=h.order(c);h.sql(`UPDATE core.orders SET raw_response=raw_response-'refundsVerified' WHERE id='${missing}'`);
 assert.equal(h.evaluate(p,missing).code,'amount_evidence_missing');
 assert.equal(count(`campaign_id='${p}'`),0);
});
check('pending cancelled failed payments and already refunded orders cannot initially apply',()=>{
 const c=h.customer(),p=h.campaign();for(const options of [{amount:null},{amount:null,state:'CANCELLED'},{paymentStatus:'FAIL'}])assert.equal(h.evaluate(p,h.order(c,options)).applied,false);
 const o=h.order(c);h.refund(o,5000);assert.equal(h.evaluate(p,o).applied,false);assert.equal(count(`campaign_id='${p}'`),0);
});
check('full refund restore=true retains voided row and permits another order',()=>{
 const c=h.customer(),p=h.campaign({restore_on_full_refund:true,max_total_units:1}),o=h.order(c),r=h.evaluate(p,o);
 const ledger=()=>h.sql(`SELECT json_build_object('redemption',to_jsonb(r),'usage',to_jsonb(u),'eventCount',
  (SELECT count(*) FROM core.campaign_events WHERE campaign_id='${p}')) FROM core.offer_redemptions r
  JOIN core.campaign_usage u ON u.campaign_id=r.campaign_id WHERE r.id='${r.redemptionId}'`);
 const original=ledger();h.sql(`UPDATE core.orders SET raw_response=jsonb_set(raw_response,'{refundsVerified}','false'::jsonb) WHERE id='${o}'`);
 assert.equal(h.evaluate(p,o).code,'refund_amount_evidence_missing');assert.deepEqual(ledger(),original);
 h.refund(o,5000);
 for(const marker of [false,null,'true']){
  h.sql(`UPDATE core.orders SET raw_response=jsonb_set(raw_response,'{refundsVerified}',${h.literal(JSON.stringify(marker))}::jsonb) WHERE id='${o}'`);
  assert.equal(h.evaluate(p,o).code,'refund_amount_evidence_missing');assert.deepEqual(ledger(),original);
 }
 h.sql(`UPDATE core.orders SET raw_response=raw_response-'refundsVerified' WHERE id='${o}'`);
 assert.equal(h.evaluate(p,o).code,'refund_amount_evidence_missing');assert.deepEqual(ledger(),original);
 h.sql(`UPDATE core.orders SET raw_response=jsonb_set(raw_response,'{refundsVerified}','true'::jsonb) WHERE id='${o}'`);
 const result=h.evaluate(p,o);assert.equal(result.code,'voided');assert.equal(row(r.redemptionId).status,'voided');assert.equal(row(r.redemptionId).quota_reserved,false);
 assert.equal(ledger().usage.reserved_units,0);assert.equal(ledger().eventCount,original.eventCount+1);
 assert.equal(h.evaluate(p,h.order(c)).applied,true);assert.equal(count(`campaign_id='${p}'`),2);assert.equal(h.evaluate(p,o).applied,false);
});
check('full refund with nonzero tip uses gross captured evidence without double subtracting',()=>{
 const c=h.customer(),p=h.campaign({include_tax:false,include_tip:false,restore_on_full_refund:true,min_amount_cents:3000}),
  o=h.order(c,{amount:3300,paymentRaw:{taxAmount:300,tipAmount:500}}),r=h.evaluate(p,o);
 assert.equal(r.applied,true);h.refund(o,3800,{taxAmount:300,tipAmount:500});assert.equal(h.evaluate(p,o).code,'voided');
 assert.equal(row(r.redemptionId).quota_reserved,false);assert.equal(h.evaluate(p,h.order(c)).applied,true);
});
check('refund equal to payment amount but leaving tip is partial and keeps quota when net remains eligible',()=>{
 const c=h.customer(),p=h.campaign({include_tax:false,include_tip:false,restore_on_full_refund:true,restore_on_partial_below_minimum:false,min_amount_cents:400}),
  o=h.order(c,{amount:3300,paymentRaw:{taxAmount:300,tipAmount:500}}),r=h.evaluate(p,o);
 assert.equal(r.applied,true);h.refund(o,3300,{taxAmount:300,tipAmount:500});const result=h.evaluate(p,o);
 assert.equal(row(r.redemptionId).quota_reserved,true);assert.equal(result.code,'already_applied');
});
check('full refund restore=false retains person and global quotas',()=>{
 const c=h.customer(),p=h.campaign({restore_on_full_refund:false,max_total_units:1}),o=h.order(c),r=h.evaluate(p,o);h.refund(o,5000);
 assert.equal(h.evaluate(p,o).code,'voided');assert.equal(row(r.redemptionId).quota_reserved,true);assert.equal(h.evaluate(p,h.order(c)).applied,false);
 assert.equal(h.evaluate(p,h.order(h.customer())).code,'total_limit');
});
check('partial refund above minimum stays applied and below minimum restores only when configured',()=>{
 const c=h.customer(),p=h.campaign({restore_on_partial_below_minimum:true}),o=h.order(c),r=h.evaluate(p,o);h.refund(o,1000);
 assert.equal(h.evaluate(p,o).code,'already_applied');assert.equal(row(r.redemptionId).status,'applied');h.refund(o,1500);
 assert.equal(h.evaluate(p,o).code,'voided');assert.equal(row(r.redemptionId).quota_reserved,false);assert.equal(h.evaluate(p,h.order(c)).applied,true);
});
check('partial refund below minimum without restoration keeps quota reserved',()=>{
 const c=h.customer(),p=h.campaign({restore_on_partial_below_minimum:false}),o=h.order(c),r=h.evaluate(p,o);h.refund(o,2500);
 assert.equal(h.evaluate(p,o).code,'voided');assert.equal(row(r.redemptionId).quota_reserved,true);assert.equal(h.evaluate(p,h.order(c)).code,'period_limit');
});
check('refund uses original application snapshot even after campaign parameters change',()=>{
 const c=h.customer(),p=h.campaign({restore_on_full_refund:false}),o=h.order(c),r=h.evaluate(p,o);
 h.sql(`UPDATE core.campaigns SET restore_on_full_refund=true,min_amount_cents=100,status='stopped' WHERE id='${p}'`);h.refund(o,5000);
 assert.equal(h.evaluate(p,o).code,'voided');assert.equal(row(r.redemptionId).quota_reserved,true);
});
check('unknown partial refund tax allocation holds original quota',()=>{
 const c=h.customer(),p=h.campaign({include_tax:false,include_tip:false,restore_on_partial_below_minimum:true}),o=h.order(c),r=h.evaluate(p,o);
 h.refund(o,2500);h.sql(`UPDATE core.refunds SET raw_response='{}'::jsonb WHERE order_id='${o}'`);const result=h.evaluate(p,o);
 assert.equal(result.applied,false);assert.equal(row(r.redemptionId).quota_reserved,true);
});
check('refund without same-order successful payment association preserves quota',()=>{
 const c=h.customer(),p=h.campaign({restore_on_full_refund:true}),o=h.order(c),r=h.evaluate(p,o);h.refund(o,5000);
 h.sql(`UPDATE core.refunds SET payment_id=NULL WHERE order_id='${o}'`);assert.equal(h.evaluate(p,o).applied,false);
 assert.equal(row(r.redemptionId).status,'applied');assert.equal(row(r.redemptionId).quota_reserved,true);
});
check('staff mark requires actual authenticated active staff identity and note',()=>{
 const c=h.customer(),p=h.campaign(),o=h.order(c,{trace:false});assert.equal(h.evaluate(p,o,{source:'staff_mark',staffActor:randomUUID(),staffNote:'Synthetic evidence'}).applied,false);
 const actor=randomUUID();h.sql(`INSERT INTO core.crm_staff(auth_user_id,role,active) VALUES('${actor}','staff',true)`);
 for(const staffNote of ['  ','\t\n']){const blank=h.expression(p,o,{source:'staff_mark',staffActor:actor,staffNote});assert.equal(h.sql(`SET request.jwt.claim.sub='${actor}';SELECT ${blank}`,{service:true}).applied,false);}
 const expression=h.expression(p,o,{source:'staff_mark',staffActor:actor,staffNote:'Synthetic staff evidence'});
 assert.equal(h.sql(`SET request.jwt.claim.sub='${actor}';SELECT ${expression}`,{service:true}).applied,true);
});
check('evidence creation changes activation stopping and parameters are recorded immutably',()=>{
 const p=h.campaign({status:'draft'});const before=h.sql(`SELECT count(*) FROM core.campaign_events WHERE campaign_id='${p}'`);assert.ok(before>=1);
 h.sql(`UPDATE core.campaigns SET status='active' WHERE id='${p}';UPDATE core.campaigns SET min_amount_cents=4000 WHERE id='${p}';UPDATE core.campaigns SET status='stopped' WHERE id='${p}'`);
 assert.ok(h.sql(`SELECT count(*) FROM core.campaign_events WHERE campaign_id='${p}'`)>=before+3);
 rejectsSql(`UPDATE core.campaign_events SET occurred_at=clock_timestamp() WHERE campaign_id='${p}'`);
 rejectsSql(`DELETE FROM core.campaign_events WHERE campaign_id='${p}'`);
});
check('core tables stay private RLS enabled and evaluator is service-only',()=>{
 for(const role of ['anon','authenticated','service_role'])for(const table of ['campaigns','offer_redemptions','campaign_events','campaign_usage'])assert.equal(h.sql(`SELECT has_table_privilege('${role}','core.${table}','SELECT,INSERT,UPDATE,DELETE')`),false);
 assert.equal(h.sql("SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN('core.campaigns'::regclass,'core.offer_redemptions'::regclass,'core.campaign_events'::regclass,'core.campaign_usage'::regclass)"),true);
 for(const role of ['anon','authenticated','service_role'])assert.equal(h.sql(`SELECT bool_or(has_function_privilege('${role}',p.oid,'EXECUTE')) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='core' AND p.proname LIKE 'campaign_%'`),false);
 const c=h.customer(),p=h.campaign(),o=h.order(c);for(const role of ['anon','authenticated']){const result=h.raw('SELECT '+h.expression(p,o),{role});assert.notEqual(result.status,0);}
});
check('repeatable-read and serializable requests fail before any redemption',()=>{
 const c=h.customer(),p=h.campaign(),o=h.order(c);for(const isolation of ['REPEATABLE READ','SERIALIZABLE'])rejectsSql(`BEGIN ISOLATION LEVEL ${isolation};SET LOCAL request.jwt.claim.role='service_role';SET LOCAL ROLE service_role;SELECT ${h.expression(p,o)};ROLLBACK;`,/READ_COMMITTED/);
 assert.equal(count(`campaign_id='${p}'`),0);
});
check('two real PostgreSQL sessions admit only one person-period redemption',async t=>{
 const c=h.customer(),p=h.campaign();await race(t,h.expression(p,h.order(c)),h.expression(p,h.order(c)),'person-period-race');assert.equal(count(`campaign_id='${p}'`),1);
});
check('two real PostgreSQL sessions enforce a multi-unit campaign total cap',async t=>{
 const p=h.campaign({max_total_units:3,max_units_per_order:2}),a=h.customer(),b=h.customer();
 await race(t,h.expression(p,h.order(a,{quantity:2}),{units:2}),h.expression(p,h.order(b,{quantity:2}),{units:2}),'total-unit-race');assert.equal(h.sql(`SELECT sum(units)::int FROM core.offer_redemptions WHERE campaign_id='${p}'`),2);
});
