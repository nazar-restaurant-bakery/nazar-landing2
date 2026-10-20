import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fixture} from './fixtures/messageSendGateNative.mjs';

const h=await fixture();
const reason=!h?'Dedicated owned native PostgreSQL fixture not supplied; these are not passed concurrency/DB checks.':false;
const intent=(id,key='native_'+randomUUID(),kind='campaign')=>({businessId:h.config.businessId,customerId:id,messageKey:key,messageKind:kind,payloadSha256:'a'.repeat(64)});
function grantSql(expression){return `SELECT json_build_object('backendPid',pg_backend_pid(),'decision',${expression});`;}
async function race(t,sqlA,sqlB){
 const tag='k6a_'+randomUUID().replaceAll('-','');
 const first=h.session(`BEGIN;SET LOCAL application_name='${tag}';SET LOCAL request.jwt.claim.role='service_role';SET LOCAL ROLE service_role;`+sqlA+'SELECT pg_sleep(2);COMMIT;',tag);
 t.after(()=>{if(first.child.exitCode===null)first.child.kill();});
 let held=false;
 for(let n=0;n<35;n++){
  held=h.sql(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE a.application_name='${tag}' AND l.locktype='advisory' AND l.granted) AS held`);
  if(held)break;await new Promise(resolve=>setTimeout(resolve,50));
 }
 assert.equal(held,true,'First native session must demonstrably hold the transaction advisory lock before second starts');
 const second=h.session("BEGIN;SET LOCAL request.jwt.claim.role='service_role';SET LOCAL ROLE service_role;"+sqlB+'COMMIT;','k6b_'+randomUUID().replaceAll('-',''));
 t.after(()=>{if(second.child.exitCode===null)second.child.kill();});
 const [a,b]=await Promise.all([first.promise,second.promise]);
 const parse=value=>JSON.parse(value.stdout.split(/\r?\n/).find(line=>line.startsWith('{')));
 const one=parse(a),two=parse(b);assert.notEqual(one.backendPid,two.backendPid);
 return{one,two,lockObserved:true};
}

test('K6 exact hosted acceptance is synthetic rollback with unchanged initial rows',{skip:reason},async()=>{
 const snapshot=()=>h.sql("SELECT json_build_object('customers',(SELECT count(*) FROM core.customers),'logs',(SELECT count(*) FROM core.message_log),'settings',(SELECT md5(coalesce(jsonb_agg(to_jsonb(x) ORDER BY business_id)::text,'')) FROM core.message_send_settings x),'consents',(SELECT count(*) FROM core.consent_events))");
 const before=snapshot();const acceptance=await readFile(new URL('../tools/test-env/k6-acceptance.sql',import.meta.url),'utf8');
 assert.ok(!acceptance.includes('\r'));
 const result=h.sql(`SET k6.test_business_id='${h.config.businessId}';\n`+acceptance);
 assert.equal(result.scope,'K6_SYNTHETIC_ROLLBACK_DB_ACCEPTANCE');assert.equal(result.failed,0);assert.deepEqual(result.missing,[]);
 assert.equal(result.passed,result.checks.length);assert.ok(result.passed>=30);assert.equal(result.provider_calls,0);assert.equal(result.real_sends,0);
 assert.equal(result.account_operations,0);assert.equal(result.auth_http_claimed,false);assert.equal(result.fixtures_rolled_back,true);
 assert.deepEqual(snapshot(),before);
 await writeFile(h.config.acceptanceResultPath,JSON.stringify(result,null,2)+'\n');
});

test('two actual PostgreSQL sessions share one campaign/flow reservation quota',{skip:reason},async t=>{
 const id=h.customer();const a=intent(id),b=intent(id,undefined,'flow');
 const expression=x=>`public.message_send_reserve_v1('${x.businessId}','${x.customerId}','${x.messageKey}','${x.messageKind}','${x.payloadSha256}')`;
 const proof=await race(t,grantSql(expression(a)),grantSql(expression(b)));
 assert.equal(proof.one.decision.allowed,true);assert.equal(proof.two.decision.allowed,false);assert.equal(proof.two.decision.code,'frequency_limited');
 assert.equal(h.sql(`SELECT count(*) FROM core.message_log WHERE customer_id='${id}'`),1);
 await writeFile(h.config.concurrentReserveResultPath,JSON.stringify({...proof,real_sends:0},null,2)+'\n');
});

test('two actual PostgreSQL sessions cannot claim one reservation twice',{skip:reason},async t=>{
 const id=h.customer();const r=h.reserve(intent(id));const statement=grantSql(`public.message_send_claim_v1('${r.reservationId}')`);
 const proof=await race(t,statement,statement);assert.equal(proof.one.decision.allowed,true);assert.equal(proof.two.decision.allowed,false);
 assert.equal(proof.two.decision.code,'not_claimable');
});

test('two actual PostgreSQL sessions cannot consume one dispatch context twice',{skip:reason},async t=>{
 const id=h.customer();const r=h.reserve(intent(id));const q=h.claim(r.reservationId);
 const statement=grantSql(`public.message_send_context_v1('${r.reservationId}','${q.leaseId}')`);
 const proof=await race(t,statement,statement);assert.equal(proof.one.decision.allowed,true);assert.equal(proof.two.decision.allowed,false);
 assert.equal(proof.two.decision.code,'already_dispatched');
});

test('all four RPCs reject stale-snapshot isolation before any grant',{skip:reason},()=>{
 const id=h.customer(),key='repeatable_'+randomUUID();
 const calls=[`public.message_send_reserve_v1('${h.config.businessId}','${id}','${key}','campaign','${'a'.repeat(64)}')`,
  `public.message_send_claim_v1('${randomUUID()}')`,`public.message_send_context_v1('${randomUUID()}','${randomUUID()}')`,
  `public.message_send_finalize_v1('${randomUUID()}','${randomUUID()}','unknown')`];
 for(const isolation of ['REPEATABLE READ','SERIALIZABLE'])for(const call of calls){
  const options=h.options();const result=spawnSync(h.config.psql,h.args,{...options,input:`BEGIN ISOLATION LEVEL ${isolation};SET LOCAL request.jwt.claim.role='service_role';SET LOCAL ROLE service_role;SELECT ${call};ROLLBACK;`});
  assert.notEqual(result.status,0);assert.match(result.stderr,/K6_READ_COMMITTED_REQUIRED/);
 }
 assert.equal(h.sql(`SELECT count(*) FROM core.message_log WHERE customer_id='${id}'`),0);
});

test('expired claim becomes unknown and never regrants or releases quota',{skip:reason},()=>{
 const id=h.customer(),lease=randomUUID(),reservation=randomUUID(),key='expired_'+randomUUID();
 h.sql(`INSERT INTO core.message_log(id,business_id,customer_id,message_key,message_kind,payload_sha256,recipient_sha256,identity_sha256,status,lease_id,
  reserved_at,reservation_expires_at,claimed_at,dispatch_expires_at)
 SELECT '${reservation}','${h.config.businessId}',id,'${key}','flow','${'a'.repeat(64)}',encode(sha256(convert_to(lower(email),'UTF8')),'hex'),
  encode(sha256(convert_to(identity_key,'UTF8')),'hex'),'claimed','${lease}',clock_timestamp()-interval '170 hours',clock_timestamp()-interval '169 hours',
  clock_timestamp()-interval '169 hours',clock_timestamp()-interval '168 hours' FROM core.customers WHERE id='${id}';`);
 const context=h.context(reservation,lease);assert.equal(context.allowed,false);assert.equal(context.status,'unknown');assert.equal(context.code,'lease_expired');
 assert.equal(h.claim(reservation).allowed,false);assert.equal(h.reserve(intent(id)).code,'frequency_limited');
 assert.equal(h.finalize(reservation,lease,'sent').status,'unknown');
});

test('a setting disabled after reserve is rechecked before dispatch',{skip:reason},()=>{
 const id=h.customer();const r=h.reserve(intent(id));
 h.sql(`UPDATE core.message_send_settings SET enabled=false WHERE business_id='${h.config.businessId}'`);
 try{const q=h.claim(r.reservationId);assert.equal(q.allowed,false);assert.equal(q.status,'blocked');assert.equal(q.code,'settings_disabled');}
 finally{h.sql(`UPDATE core.message_send_settings SET enabled=true WHERE business_id='${h.config.businessId}'`);}
});
