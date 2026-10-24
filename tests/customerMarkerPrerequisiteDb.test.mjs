// Owned local PG18.6 only; no launcher, credential, hosted or provider access.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';

import {fixture} from './fixtures/customerTestClassificationNative.mjs';
const h=await fixture({currentCouponSchema:true,useLocalPostgresDatabase:true});after(()=>h.stop());
const q=h.literal;
const sql=await readFile(new URL('../supabase/repairs/20261024000100_customer_test_marker_prerequisite.sql',import.meta.url));
const old22=await readFile(new URL('../supabase/migrations/20261023000100_customer_test_classification.sql',import.meta.url));
const missing=()=>h.sql("SELECT NOT EXISTS(SELECT FROM pg_attribute WHERE attrelid='core.customers'::regclass AND attname='is_test' AND NOT attisdropped)");
const marker=()=>h.sql("SELECT jsonb_build_object('type',a.atttypid='boolean'::regtype,'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='core.customers'::regclass AND a.attname='is_test' AND NOT a.attisdropped");
const security=()=>h.sql(`SELECT jsonb_build_object(
 'functions',(SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'def',pg_get_functiondef(p.oid),'acl',p.proacl,'config',p.proconfig,'definer',p.prosecdef) ORDER BY p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('core','public')),
 'tables',(SELECT jsonb_agg(jsonb_build_object('oid',c.oid,'acl',c.relacl,'rls',c.relrowsecurity,'force',c.relforcerowsecurity) ORDER BY c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='core' AND c.relkind IN('r','v')),
 'policies',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.oid),'[]') FROM pg_policy p),
 'triggers',(SELECT jsonb_agg(jsonb_build_object('oid',t.oid,'def',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) ORDER BY t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='core' AND NOT t.tgisinternal))`);
const data=()=>h.sql(`SELECT jsonb_build_object(
 'customers',(SELECT coalesce(jsonb_agg(to_jsonb(c)-'is_test' ORDER BY id),'[]') FROM core.customers c),
 'signups',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM core.signups s),
 'consent',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM core.consent_events s),
 'coupons',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM core.campaign_coupons s),
 'evidence',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM core.vip_confirmation_evidence s),
 'outbox',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM core.coupon_welcome_outbox s),
 'messages',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]') FROM core.message_log s))`);
function submit(email,consent=false){
 return h.raw(`SELECT public.submit_signup_once('${randomUUID()}','${h.business}','INTERNAL TEST Local repair',${q(email)},NULL,'website_vip_page',${consent},false,'{}',NULL)`,{service:true});
}
test('repair and unchanged22 are LF/no-BOM; both applied SQL hashes are preserved',()=>{
 for(const b of [sql,old22]){assert.equal(b.includes(13),false);assert.notEqual(b[0],0xef);assert.equal(b.at(-1),10);}
 assert.equal(createHash('sha256').update(sql).digest('hex'),'8be2dd137a7e2ae8074c83cafdd09c120a51df461e6713502f7a81a0c5b27f98');
 assert.equal(createHash('sha256').update(old22).digest('hex'),'697d2102b2cca67db7b2189daa88e2babc5ec463eb566ee5b74e48e52c951c79');
});
let beforeData,beforeSecurity;
test('reconstruct the confirmed Production difference using the full current application fixture',()=>{
 // Local empty-table DDL only. Canonical K3/application SQL is not rewritten.
 // This is a catalog-difference reconstruction, not a Production dump/replay.
 h.sql('ALTER TABLE core.customers DROP COLUMN is_test');
 assert.equal(missing(),true);
 for(const path of ['signups','campaign_coupons'])assert.equal(h.sql(`SELECT attnotnull AND atttypid='boolean'::regtype FROM pg_attribute WHERE attrelid='core.${path}'::regclass AND attname='is_test'`),true);
 assert.equal(h.sql("SELECT to_regprocedure('core.test_lead_reason_v1(text,text)') IS NOT NULL"),true);
 assert.equal(h.sql("SELECT to_regprocedure('core.classify_test_customer_v1()') IS NULL"),true);
 assert.equal(h.applied.length,10);
});
test('the exact unchanged22 fails on the missing column and leaves no helper/trigger',()=>{
 const r=h.raw(old22.toString());assert.notEqual(r.status,0);assert.match(r.stderr,/CUSTOMER_TEST_CLASSIFIER_PREREQUISITES_REQUIRED/);
 assert.equal(missing(),true);assert.equal(h.sql("SELECT to_regprocedure('core.classify_test_customer_v1()') IS NULL"),true);
 assert.equal(h.sql("SELECT NOT EXISTS(SELECT FROM pg_trigger WHERE tgrelid='core.customers'::regclass AND tgname='classify_test_customer')"),true);
});
test('SQL itself rejects a wrong project declaration before any schema change',()=>{
 const r=h.raw(sql.toString());assert.notEqual(r.status,0);assert.match(r.stderr,/CUSTOMER_MARKER_REPAIR_PRODUCTION_TARGET_REQUIRED/);
 assert.equal(missing(),true);
 // Declaration only in an owned, isolated loopback cluster. Never a connection target.
 h.sql("UPDATE core.installation SET declared_project_ref='khgczybubufouraqyrcj'");
});
test('seed only synthetic historical identities with no column, including a suppressed person',()=>{
 assert.equal(submit('history@repair.invalid',true).status,0);
 assert.equal(submit('blocked@repair.invalid',true).status,0);
 h.sql("SELECT core.suppress_email('blocked@repair.invalid','Synthetic local prerequisite proof')");
 beforeData=data();beforeSecurity=security();
 assert.equal(h.sql('SELECT count(*) FROM core.customers'),2);
});
test('narrow21a adds boolean NOT NULL DEFAULT false, with no historical reclassification',()=>{
 const r=h.raw(sql.toString());assert.equal(r.status,0,r.stderr);
 assert.deepEqual(marker(),{type:true,notNull:true,default:'false'});
 assert.equal(h.sql('SELECT bool_and(NOT is_test) FROM core.customers'),true);
 assert.deepEqual(data(),beforeData);assert.deepEqual(security(),beforeSecurity);
});
test('repeat21a refuses rather than silently treating an existing column as new work',()=>{
 const r=h.raw(sql.toString());assert.notEqual(r.status,0);assert.match(r.stderr,/CUSTOMER_MARKER_REPAIR_REVIEW_REQUIRED/);
 assert.deepEqual(data(),beforeData);assert.deepEqual(security(),beforeSecurity);
});
test('a nullable or wrong-type preexisting column is rejected without conversion',()=>{
 for(const type of ['boolean','text']){
  const r=h.raw('BEGIN;ALTER TABLE core.customers DROP COLUMN is_test;ALTER TABLE core.customers ADD COLUMN is_test '+type+';\n'+sql.toString());
  assert.notEqual(r.status,0);assert.match(r.stderr,/CUSTOMER_MARKER_REPAIR_REVIEW_REQUIRED/);
  assert.deepEqual(marker(),{type:true,notNull:true,default:'false'});
 }
});
test('unchanged22 now succeeds; historical values remain false and new signup gets the marker',()=>{
 const r=h.raw(old22.toString());assert.equal(r.status,0,r.stderr);
 assert.deepEqual(data(),beforeData);
 assert.equal(submit('after@repair.invalid',true).status,0);
 assert.equal(h.sql("SELECT is_test FROM core.customers WHERE email='after@repair.invalid'"),true);
 assert.equal(h.sql("SELECT to_jsonb(email_status) FROM core.customers WHERE email='after@repair.invalid'"),'pending_review');
 assert.equal(h.sql("SELECT is_test FROM core.customers WHERE email='history@repair.invalid'"),false);
});
test('suppression and K4 direct-update guard still win after21a→22',()=>{
 assert.equal(submit('blocked@repair.invalid',true).status,0);
 assert.equal(h.sql("SELECT to_jsonb(email_status) FROM core.customers WHERE email='blocked@repair.invalid'"),'unsubscribed');
 const r=h.raw("UPDATE core.customers SET email_status='subscribed',email_suppressed_at=NULL WHERE email='blocked@repair.invalid'");
 assert.notEqual(r.status,0);assert.match(r.stderr,/Suppression requires approved new customer consent/);
});
test('a Sandbox-shaped existing22 installation cannot run21a; existing markers stay intact',()=>{
 const before=data(),flag=h.sql("SELECT is_test FROM core.customers WHERE email='after@repair.invalid'");
 const r=h.raw(sql.toString());assert.notEqual(r.status,0);assert.match(r.stderr,/CUSTOMER_MARKER_REPAIR_REVIEW_REQUIRED/);
 assert.deepEqual(data(),before);assert.equal(h.sql("SELECT is_test FROM core.customers WHERE email='after@repair.invalid'"),flag);
 assert.equal(h.sql('SELECT count(*) FROM core.message_log'),0);assert.equal(h.sql('SELECT count(*) FROM core.coupon_welcome_outbox'),0);
});
