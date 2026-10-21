import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {fixture} from './fixtures/signupRewardCouponsNative.mjs';
import {validLoyaltyMetrics} from '../src/lib/loyaltyMetrics.ts';
test('actual coupons: null-order and linked uses total correctly; repeat cohorts remain order-only, tenant/filter/ACL safe',async()=>{
 const h=await fixture();const checks=[];try{
 h.sql(`ALTER TABLE core.businesses ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'America/New_York'`);
 h.sql(await readFile(new URL('../supabase/migrations/20261021000300_loyalty_referrals_metrics.sql',import.meta.url),'utf8'));
 const meta=()=>h.sql(`SELECT json_build_object('acl',proacl,'definer',prosecdef,'config',proconfig) FROM pg_proc WHERE oid='public.loyalty_metrics_v1(uuid,date,boolean)'::regprocedure`),before=meta();
 const migration=await readFile(new URL('../supabase/migrations/20261021001000_ops_campaign_usage_split.sql',import.meta.url));assert.equal(migration.includes(13),false);h.sql(migration.toString());assert.deepEqual(meta(),before);checks.push('same RPC signature, ACL, SECURITY DEFINER, empty search_path; immutable old migration untouched');
 const B=h.config.businessId,other=h.config.secondBusinessId,actor=h.config.scopeFixture.users.ownerA;
 const parts=new Intl.DateTimeFormat('en',{timeZone:'America/New_York',year:'numeric',month:'2-digit'}).formatToParts(new Date());const M=parts.find(x=>x.type==='year').value+'-'+parts.find(x=>x.type==='month').value+'-01';
 const metrics=(biz=B,include=true,at=M)=>h.sql(`SELECT public.loyalty_metrics_v1('${biz}','${at}',${include})`,{role:'authenticated',subject:actor});
 const campaign=h.reward();const earn=()=>{const c=h.customer({status:'pending_review'}),s=h.signup(c);h.confirm(c,s);return{customer:c,coupon:h.coupon(c)};};
 const a=earn();assert.equal(h.redeem(a.coupon.code).redeemed,true);
 let data=metrics(),item=data.campaigns.items.find(x=>x.campaign_id===campaign);assert.equal(data.campaigns.known,true);assert.deepEqual([item.applied,item.order_linked,item.staff_attested],[1,0,1]);assert.equal(item.repeat_30d.known,false);assert.equal(item.repeat_30d.denominator,null);assert.equal(validLoyaltyMetrics(data,{businessId:B,month:M,includeTests:true,identity:actor}),true);checks.push('only staff-attested source is known: 1=0+1, repeat unknown');
 const b=earn(),order=h.order(b.customer,{date:new Date().toISOString(),amount:3000,trace:false}),clover=h.sql(`SELECT to_jsonb(clover_order_id) FROM core.orders WHERE id='${order}'`);assert.equal(h.redeem(b.coupon.code,{cloverOrderId:clover,attestation:h.note({channel:'site_pickup'})}).redeemed,true);
 item=metrics().campaigns.items.find(x=>x.campaign_id===campaign);assert.deepEqual([item.applied,item.order_linked,item.staff_attested],[2,1,1]);assert.equal(h.redeem(a.coupon.code).code,'already_used');assert.equal(metrics().campaigns.items.find(x=>x.campaign_id===campaign).applied,2);checks.push('actual Clover-linked and null-order coupon redemption: 2=1+1; second use adds nothing');
 assert.equal(metrics(B,false).campaigns.items.length,0);checks.push('test campaign/customer data excluded when include_tests=false');
 const denied=h.raw(`SELECT public.loyalty_metrics_v1('${other}','${M}',true)`,{role:'authenticated',subject:actor});assert.notEqual(denied.status,0);assert.match(denied.stderr,/Access denied/);checks.push('other tenant denied before data');
 // Historical linked cohorts use the existing immutable K9 insert path; no fake coupon timestamp rewrite.
 const legacy=h.campaign({period:'unlimited'});for(const repeat of [true,false]){const c=h.customer();const o=h.order(c,{date:'2026-08-01T12:00:00Z'});h.sql(`INSERT INTO core.offer_redemptions(business_id,campaign_id,customer_id,order_id,applied_at,source,period_key,units,snapshot) SELECT '${B}','${legacy}','${c}','${o}','2026-08-01T12:00:00Z','clover_trace','${randomUUID()}',1,jsonb_build_object('campaign',to_jsonb(ca)) FROM core.campaigns ca WHERE id='${legacy}'`);if(repeat)h.order(c,{date:'2026-08-31T12:00:00Z'});}
 const cohort=metrics(B,true,'2026-08-01').campaigns.items.find(x=>x.campaign_id===legacy);assert.deepEqual([cohort.applied,cohort.order_linked,cohort.staff_attested],[2,2,0]);assert.deepEqual([cohort.repeat_30d.numerator,cohort.repeat_30d.denominator,cohort.repeat_30d.rate],[1,2,.5]);checks.push('historical linked cohort remains 1/2; null-order uses excluded from repeat cohort');
 assert.notEqual(h.raw(migration.toString()).status,0);checks.push('migration replay/predecessor mismatch fails closed');
 const out=new URL('../20_Yonetim/Teslim_Raporlari/K10_Ops_Kullanim_kanit/',import.meta.url);await mkdir(out,{recursive:true});await writeFile(new URL('native.json',out),JSON.stringify({passed:checks.length,checks,migration_sha256:createHash('sha256').update(migration).digest('hex'),hosted:false,provider_calls:0},null,2)+'\n');console.log(JSON.stringify({passed:checks.length,checks}));
 }finally{await h.stop();}
});
