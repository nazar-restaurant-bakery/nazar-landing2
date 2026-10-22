import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fixture} from './fixtures/signupRewardCouponsNative.mjs';
import {validQrFunnel} from '../src/lib/qrVipFunnel.ts';
test('actual K10/K11/16 plus QR cohort: sources, confirmed evidence, SIMIT coupons, null/linked redemption, isolation and missing GA4',async()=>{
 const h=await fixture(),checks=[];try{
 h.sql(await readFile(new URL('../supabase/migrations/20261021000300_loyalty_referrals_metrics.sql',import.meta.url),'utf8'));
 h.sql(await readFile(new URL('../supabase/migrations/20261021001000_ops_campaign_usage_split.sql',import.meta.url),'utf8'));
 h.sql(`ALTER TABLE core.ops_metrics ALTER COLUMN id SET DEFAULT gen_random_uuid(); ALTER TABLE core.ops_metrics ADD COLUMN business_id uuid NOT NULL REFERENCES core.businesses(id),ADD COLUMN source text,ADD COLUMN metric text,ADD COLUMN value_num numeric,ADD COLUMN value_text text,ADD COLUMN period_start date,ADD COLUMN period_end date,ADD COLUMN collected_at timestamptz DEFAULT now(),ADD COLUMN is_test boolean DEFAULT false`);
 h.sql(await readFile(new URL('../supabase/migrations/20261021001100_qr_vip_funnel.sql',import.meta.url),'utf8'));
 const B=h.config.businessId,other=h.config.secondBusinessId,actor=h.config.scopeFixture.users.ownerA;const yesterday=new Date(Date.now()-86400000).toISOString();const parts=new Intl.DateTimeFormat('en',{year:'numeric',month:'2-digit',timeZone:'America/New_York'}).formatToParts(new Date(yesterday));const M=parts.find(x=>x.type==='year').value+'-'+parts.find(x=>x.type==='month').value+'-01';
 const read=(biz=B,who=actor,tests=true)=>h.sql(`SELECT public.qr_vip_funnel_v1('${biz}','${M}',${tests})`,{role:'authenticated',subject:who});
 h.reward({benefit_code:'SIMIT'});
 const earn=(tag='qr_paket',confirmed=true)=>{const c=h.customer({status:'pending_review'}),s=h.signup(c,{createdAt:yesterday});h.sql(`UPDATE core.signups SET utm=jsonb_build_object('utm_source','qr','utm_medium','offline','utm_campaign','${tag}') WHERE id='${s}'`);if(confirmed)h.confirm(c,s,{confirmedAt:new Date().toISOString()});return{c,s,cp:h.coupon(c)};};
 const a=earn(),b=earn(),pending=earn('qr_paket',false),notQr=earn('other');let f=read();assert.equal(f.registrations,3);assert.equal(f.confirmed,2);assert.equal(f.coupons,2);assert.equal(f.used,0);assert.equal(f.sessions,null);checks.push('3 QR customers -> 2 dated confirmations -> 2 SIMIT coupons; non-QR and unconfirmed excluded downstream');
 assert.equal(h.redeem(a.cp.code).redeemed,true);const o=h.order(b.c,{date:new Date().toISOString(),amount:3000,trace:false});const id=h.sql(`SELECT to_jsonb(clover_order_id) FROM core.orders WHERE id='${o}'`);assert.equal(h.redeem(b.cp.code,{cloverOrderId:id,attestation:h.note({channel:'site_pickup'})}).redeemed,true);h.redeem(notQr.cp.code);f=read();assert.deepEqual([f.used,f.order_linked,f.staff_attested],[2,1,1]);assert.equal(f.repeat_30d.known,false);assert.equal(validQrFunnel(f,B,M,true),true);checks.push('only exact QR signup evidence-linked coupons count; 2 uses=1 linked+1 attested; immature repeat unknown');
 assert.equal(h.redeem(a.cp.code).code,'already_used');assert.equal(read().used,2);checks.push('second coupon use never increments funnel');
 assert.equal(read(B,actor,false).registrations,0);assert.equal(read(other,h.config.scopeFixture.users.staffB).registrations,0);assert.notEqual(h.raw(`SELECT public.qr_vip_funnel_v1('${other}','${M}',true)`,{role:'authenticated',subject:actor}).status,0);checks.push('test filter, empty second tenant and wrong-tenant 403 boundary');
 // Persisted GA4 snapshots are real-only and cannot be borrowed by test mode.
 h.sql(`INSERT INTO core.ops_metrics(business_id,source,metric,value_num,period_start,period_end) VALUES('${B}','ga4','qr_paket_sessions_mtd',7,'${M}',(statement_timestamp() AT TIME ZONE 'America/New_York')::date-1)`);assert.equal(read(B,actor,false).sessions,7);assert.equal(read().sessions,null);checks.push('period-matched fresh GA4=7 for real view; test cohort never borrows it');
 h.sql(`UPDATE core.ops_metrics SET collected_at=now()-interval '27 hours'`);assert.equal(read(B,actor,false).sessions,null);checks.push('stale GA4 unknown, not zero');
 for(const role of ['anon','service_role'])assert.notEqual(h.raw(`SELECT public.qr_vip_funnel_v1('${B}','${M}',true)`,{role}).status,0);checks.push('anonymous/service_role cannot use staff-only reader');
 const out=new URL('../20_Yonetim/Teslim_Raporlari/QR_VIP_Huni_kanit/',import.meta.url);await mkdir(out,{recursive:true});await writeFile(new URL('native.json',out),JSON.stringify({passed:checks.length,checks,hosted:false,provider_calls:0},null,2)+'\n');console.log(JSON.stringify({passed:checks.length,checks}));
 }finally{await h.stop();}
});
