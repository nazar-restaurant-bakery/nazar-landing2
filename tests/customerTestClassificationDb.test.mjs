import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,migrationPath,repo} from './fixtures/customerTestClassificationNative.mjs';

const h=await fixture();after(()=>h.stop());
const q=h.literal;
const migration=await readFile(join(repo,migrationPath));
function submit({email,name='Synthetic Fixture',phone=null,consent=true,source='website_vip_page',request=randomUUID()}={}){
 const meta=source==='catering'?q(JSON.stringify({event_date:'2027-01-20',guests:25,message:'Synthetic native quote'}))+'::jsonb':'NULL';
 const expression=`SELECT public.submit_signup_once('${request}','${h.business}',${q(name)},${q(email)},${q(phone)},${q(source)},${consent},false,'{}',${meta})`;
 h.sql(expression,{service:true});
 const row=h.sql(`SELECT jsonb_build_object('customer',c.id,'name',c.name,'customerTest',c.is_test,'signupTest',s.is_test,
  'status',c.email_status,'suppressed',c.email_suppressed_at IS NOT NULL,'reason',s.test_reason,'consent',s.consent_email,
  'count',(SELECT count(*) FROM core.signups x WHERE x.customer_id=c.id))
  FROM core.customers c JOIN core.signups s ON s.customer_id=c.id WHERE c.identity_key=${q(email?'email:'+email.trim().toLowerCase():'phone:'+phone)}
  ORDER BY s.created_at DESC,s.id LIMIT 1`);
 return{...row,expression};
}
const existing=submit({email:'before-migration@native.invalid'});
const existingRows=h.sql(`SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM core.customers c`);
const existingFunctions=h.sql(`SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),
 'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig) ORDER BY p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('core','public')`);
const security=()=>h.sql(`SELECT jsonb_build_object('tables',(SELECT jsonb_agg(jsonb_build_object('id',c.oid,'acl',c.relacl,'rls',c.relrowsecurity,'force',c.relforcerowsecurity) ORDER BY c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='core' AND c.relkind IN('r','v')),
 'policies',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.oid),'[]') FROM pg_policy p))`);
const existingSecurity=security();

test('actual baseline signup RPC reproduces the missing customer marker before forward migration',()=>{
 assert.equal(existing.customerTest,false);assert.equal(existing.signupTest,true);assert.equal(existing.status,'pending_review');
});
test('missing classifier prerequisite refuses the entire forward migration atomically',()=>{
 const result=h.raw('BEGIN;ALTER FUNCTION core.test_lead_reason_v1(text,text) RENAME TO synthetic_temporarily_missing_classifier;\n'+migration.toString('utf8'));
 assert.notEqual(result.status,0);assert.match(result.stderr,/CUSTOMER_TEST_CLASSIFIER_PREREQUISITES_REQUIRED/);
 assert.equal(h.sql("SELECT to_regprocedure('core.test_lead_reason_v1(text,text)') IS NOT NULL"),true);
 assert.equal(h.sql("SELECT to_regprocedure('core.classify_test_customer_v1()') IS NOT NULL"),false);
});
test('LF forward migration adds the trigger without historical row/permission/function rewrites',async()=>{
 assert.equal(migration.includes(13),false);assert.notEqual(migration[0],0xef);
 await h.apply();
 assert.deepEqual(h.sql('SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM core.customers c'),existingRows);
 const after=h.sql(`SELECT jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),
  'acl',p.proacl,'definer',p.prosecdef,'config',p.proconfig) ORDER BY p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname IN('core','public') AND p.proname<>'classify_test_customer_v1'`);
 assert.deepEqual(after,existingFunctions);assert.deepEqual(security(),existingSecurity);
});
for(const email of ['new@native.invalid','new@deep.native.invalid','new@example.com','new@example.net','new@example.org','  MiXeD@Native.Invalid  ']){
 test(`real signup_once path classifies reserved marker ${email.trim()} without granting subscription`,()=>{
  const row=submit({email});assert.equal(row.customerTest,true);assert.equal(row.signupTest,true);
  assert.equal(row.status,'pending_review');assert.equal(row.suppressed,false);assert.equal(row.consent,true);
 });
}
for(const name of ['INTERNAL TEST Native','internal test native','INTERNAL\tTEST Native']){
 test(`shared explicit name marker: ${name}`,()=>{
  const row=submit({email:randomUUID()+'@fixture.test',name});assert.equal(row.customerTest,true);assert.equal(row.signupTest,true);assert.equal(row.status,'pending_review');
 });
}
for(const [name,email] of [['Testerman','person@fixture.test'],['Contest Customer','person@invalid.attacker.test'],['Test User','person@fooexample.com']]){
 test(`ordinary identity is not classified by substring: ${name}`,()=>{
  const row=submit({email,name});assert.equal(row.customerTest,false);assert.equal(row.signupTest,false);assert.equal(row.status,'pending_review');
 });
}
test('phone-only explicit test identity creates no email marketing permission',()=>{
 const row=submit({email:null,name:'INTERNAL TEST Phone',phone:'+12025550123'});
 assert.equal(row.customerTest,true);assert.equal(row.signupTest,true);assert.equal(row.status,'not_subscribed');assert.equal(row.consent,false);
});
test('reserved address with no consent remains not_subscribed',()=>{
 const row=submit({email:'no-consent@native.invalid',consent:false});assert.equal(row.customerTest,true);assert.equal(row.signupTest,true);assert.equal(row.status,'not_subscribed');assert.equal(row.consent,false);
});
test('catering signup classifies customer/signup/request without creating email permission',()=>{
 const row=submit({email:'catering@native.invalid',source:'catering'});
 assert.equal(row.customerTest,true);assert.equal(row.signupTest,true);assert.equal(row.status,'not_subscribed');assert.equal(row.consent,false);
 assert.equal(h.sql(`SELECT is_test FROM core.catering_requests WHERE customer_id='${row.customer}'`),true);
});
test('idempotent request retries never create another signup or permission',()=>{
 const row=submit({email:'one-request@native.invalid'});h.sql(row.expression,{service:true});
 assert.equal(h.sql(`SELECT count(*) FROM core.signups WHERE customer_id='${row.customer}'`),1);
 assert.equal(h.sql(`SELECT to_jsonb(email_status) FROM core.customers WHERE id='${row.customer}'`),'pending_review');
});
test('test snapshot cannot reclassify an existing ordinary contact or its earlier history',()=>{
 const first=submit({email:'existing-person@fixture.test',name:'Ordinary Fixture'});
 const second=submit({email:'existing-person@fixture.test',name:'INTERNAL TEST Incoming snapshot'});
 assert.equal(first.customer,second.customer);assert.equal(second.customerTest,false);assert.equal(second.signupTest,true);assert.equal(second.name,'Ordinary Fixture');
 assert.equal(h.sql(`SELECT count(*) FROM core.signups WHERE customer_id='${first.customer}' AND NOT is_test`),1);
 assert.equal(second.status,'pending_review');
});
test('a persisted customer test marker cannot be cleared by changing its marker-bearing name',()=>{
 const row=submit({email:'persist-marker@fixture.test',name:'INTERNAL TEST Fixture'});
 h.sql(`UPDATE core.customers SET name='Ordinary Fixture',is_test=false WHERE id='${row.customer}'`);
 assert.equal(h.sql(`SELECT is_test FROM core.customers WHERE id='${row.customer}'`),true);
 assert.equal(h.sql(`SELECT to_jsonb(email_status) FROM core.customers WHERE id='${row.customer}'`),'pending_review');
});
test('a mismatched old customer is not silently repaired by an idempotent form retry',()=>{
 h.sql(existing.expression,{service:true});assert.equal(h.sql(`SELECT is_test FROM core.customers WHERE id='${existing.customer}'`),false);
 assert.equal(h.sql(`SELECT count(*) FROM core.signups WHERE customer_id='${existing.customer}'`),1);
});
test('actual suppression path and K4 guard remain authoritative after classification',()=>{
 const email='blocked@native.invalid',row=submit({email});
 h.sql(`SELECT core.suppress_email(${q(email)},'Synthetic native suppression')`);
 const again=submit({email,name:'INTERNAL TEST Blocked retry'});assert.equal(again.status,'unsubscribed');assert.equal(again.suppressed,true);assert.equal(again.customerTest,true);
 const result=h.raw(`UPDATE core.customers SET email_status='subscribed',email_suppressed_at=NULL WHERE id='${row.customer}'`);
 assert.notEqual(result.status,0);assert.match(result.stderr,/Suppression requires approved new customer consent/);
 assert.equal(h.sql(`SELECT to_jsonb(email_status) FROM core.customers WHERE id='${row.customer}'`),'unsubscribed');
});
test('suppressed ordinary contact keeps its identity and block after a test-named snapshot',()=>{
 const email='blocked-ordinary@fixture.test',first=submit({email,name:'Ordinary Fixture'});
 h.sql(`SELECT core.suppress_email(${q(email)},'Synthetic native ordinary suppression')`);
 const second=submit({email,name:'INTERNAL TEST Incoming suppressed snapshot'});
 assert.equal(first.customer,second.customer);assert.equal(second.customerTest,false);assert.equal(second.signupTest,true);
 assert.equal(second.status,'unsubscribed');assert.equal(second.suppressed,true);assert.equal(second.name,'Ordinary Fixture');
});
test('new trigger helper is private and customer RLS/table privileges stay unchanged',()=>{
 for(const role of ['anon','authenticated','service_role']){
  assert.equal(h.sql(`SELECT has_function_privilege('${role}','core.classify_test_customer_v1()','EXECUTE')`),false);
  assert.notEqual(h.raw('UPDATE core.customers SET is_test=true',{role}).status,0);
 }
 assert.deepEqual(security(),existingSecurity);
 const meta=h.sql("SELECT jsonb_build_object('definer',prosecdef,'config',proconfig) FROM pg_proc WHERE oid='core.classify_test_customer_v1()'::regprocedure");
 assert.equal(meta.definer,true);assert.deepEqual(meta.config,['search_path=""']);
});
