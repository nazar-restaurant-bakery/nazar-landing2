// Synthetic records, in-memory database, no production connection or email.
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const source=JSON.parse(await fs.readFile(new URL('./fixtures/cateringStatus.before.json',import.meta.url),'utf8'));
const migration=await fs.readFile(new URL('../database/20261016_catering_assignee_whitespace.sql',import.meta.url),'utf8');
assert.equal(source.project_ref,'khgczybubufouraqyrcj');assert.equal(source.read_only,'on');
const db=new PGlite(), passed=[], failed=[];
const run=async(label,fn)=>{try{await fn();passed.push(label)}catch(e){failed.push({label,message:e.message,code:e.code})}};
const rows=async(sql,args=[])=>(await db.query(sql,args)).rows;
const business='a358eba4-b197-4309-805b-46f43a718454', other='22222222-2222-4222-8222-222222222222';
const staff='11111111-1111-4111-8111-111111111111', owner='33333333-3333-4333-8333-333333333333', inactive='44444444-4444-4444-8444-444444444444', guest='55555555-5555-4555-8555-555555555555';
const customer='66666666-6666-4666-8666-666666666666', req='77777777-7777-4777-8777-777777777777', foreignCustomer='88888888-8888-4888-8888-888888888888', foreignReq='99999999-9999-4999-8999-999999999999';
const future='2027-01-20T15:00:00.000Z', statuses=['new','contacted','quoted','won','lost','closed'], open=s=>['new','contacted','quoted'].includes(s);
const identity=async(id=staff,role='authenticated')=>{await db.exec('RESET ROLE');await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id??'']);await db.exec(`SET ROLE ${role}`)};
const update=(status,assignee='Synthetic Staff',due=future,id=req)=>db.query('SELECT public.crm_update_catering($1,$2,$3,$4) ok',[id,status,assignee,due]);
const queue=async()=>(await rows("SELECT public.crm_follow_up_queue_v1('open_catering',0) result"))[0].result;
try{
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA core;
 CREATE TABLE core.installation(declared_project_ref text);INSERT INTO core.installation VALUES('khgczybubufouraqyrcj');
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE TABLE core.crm_staff(auth_user_id uuid PRIMARY KEY,role text,active boolean);
 CREATE TABLE core.customers(id uuid PRIMARY KEY,business_id uuid,name text);
 CREATE TABLE core.signups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid,is_test boolean NOT NULL DEFAULT false);
 CREATE TABLE core.catering_requests(id uuid PRIMARY KEY,customer_id uuid REFERENCES core.customers(id),status text,assigned_to text,follow_up_at timestamptz,created_at timestamptz DEFAULT now(),is_test boolean NOT NULL DEFAULT false);
 CREATE TABLE core.customer_follow_up_tasks(id uuid,customer_id uuid,title text,assigned_to text,due_at timestamptz,created_at timestamptz,completed_at timestamptz);
 CREATE TABLE core.catering_decisions(id uuid,request_id uuid,question text,requested_at timestamptz,recorded_at timestamptz);
 REVOKE ALL ON ALL TABLES IN SCHEMA core FROM PUBLIC,anon,authenticated,service_role;
 INSERT INTO core.crm_staff VALUES('${staff}','staff',true),('${owner}','owner',true),('${inactive}','staff',false);
 `);
 const statusConstraint=source.constraints.find(c=>c.name==='catering_requests_status_check');
 await db.exec('ALTER TABLE core.catering_requests ADD CONSTRAINT request_status_check '+statusConstraint.definition);
 for(const fn of source.functions){
  let definition=fn.definition;
  if(process.env.CATERING_UPDATE_OVERRIDE && fn.name==='crm_update_catering')definition=await fs.readFile(process.env.CATERING_UPDATE_OVERRIDE,'utf8');
  await db.exec(definition);
  const signature=fn.name==='crm_update_catering'?'uuid,text,text,timestamptz':'text,integer';
  await db.exec(`REVOKE ALL ON FUNCTION public.${fn.name}(${signature}) FROM PUBLIC,anon,authenticated,service_role`);
  for(const [role,allowed] of [['anon',fn.anon_execute],['authenticated',fn.authenticated_execute],['service_role',fn.service_execute]])if(allowed)await db.exec(`GRANT EXECUTE ON FUNCTION public.${fn.name}(${signature}) TO ${role}`);
 }
 if(process.env.SKIP_CATERING_FIX!=='true')await db.exec(migration);
 await db.exec(`BEGIN;INSERT INTO core.customers VALUES('${customer}','${business}','Synthetic local'),('${foreignCustomer}','${other}','Synthetic other business');
 INSERT INTO core.signups(customer_id,is_test) VALUES('${customer}',false),('${foreignCustomer}',false);
 INSERT INTO core.catering_requests(id,customer_id,status,assigned_to,follow_up_at) VALUES('${req}','${customer}','new','Synthetic Staff','${future}'),('${foreignReq}','${foreignCustomer}','new','Other staff','${future}');`);
 for(const from of statuses)for(const to of statuses)await run(`${from} -> ${to}: fields persist and queue matches`,async()=>{
  await db.exec('RESET ROLE');await db.query('UPDATE core.catering_requests SET status=$1,is_test=false WHERE id=$2',[from,req]);await identity();
  const due=open(to)?future:null;assert.equal((await update(to,'  Synthetic Staff  ',due)).rows[0].ok,true);
  const q=await queue();assert.equal(q.total,open(to)?1:0);if(open(to))assert.equal(q.items[0].request_status,to);
  await db.exec('RESET ROLE');const saved=(await rows('SELECT status,assigned_to,follow_up_at FROM core.catering_requests WHERE id=$1',[req]))[0];
  assert.equal(saved.status,to);assert.equal(saved.assigned_to,'Synthetic Staff');assert.equal(saved.follow_up_at?.toISOString()??null,due);
 });
 const rejected=async(label,status,assignee,due,expected='22023')=>run(label,async()=>{
  await identity();await db.exec('SAVEPOINT reject_input');
  try{await assert.rejects(update(status,assignee,due),e=>e.code===expected)}finally{await db.exec('ROLLBACK TO SAVEPOINT reject_input;RELEASE SAVEPOINT reject_input')}
 });
 for(const s of ['new','contacted','quoted'])await rejected(`${s}: follow-up required`,s,'Synthetic Staff',null);
 for(const [label,value] of [['null',null],['empty',''],['spaces','   '],['tabs','\t\t'],['newlines','\r\n'],['oversized','x'.repeat(101)]])await rejected(`assignee ${label} rejected`,'closed',value,null);
 await rejected('unknown status rejected','pending','Synthetic Staff',null);
 await rejected('null status rejected',null,'Synthetic Staff',null);
 await rejected('invalid timestamp rejected','new','Synthetic Staff','not-a-date','22007');
 await run('tabs and newlines around a real assignee are trimmed',async()=>{await identity();assert.equal((await update('closed','\t Synthetic Staff \r\n',null)).rows[0].ok,true);await db.exec('RESET ROLE');assert.equal((await rows('SELECT assigned_to FROM core.catering_requests WHERE id=$1',[req]))[0].assigned_to,'Synthetic Staff')});
 await run('100-character assignee is accepted',async()=>{await identity();assert.equal((await update('closed','x'.repeat(100),null)).rows[0].ok,true)});
 await run('past valid follow-up stays allowed and overdue',async()=>{await identity();assert.equal((await update('contacted','Synthetic Staff','2020-01-01T10:00:00Z')).rows[0].ok,true);const q=await queue();assert.equal(q.items[0].flags.includes('overdue'),true)});
 await run('missing request returns false',async()=>{await identity();assert.equal((await update('closed','Synthetic Staff',null,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).rows[0].ok,false)});
 await run('other business request cannot change',async()=>{await identity();assert.equal((await update('closed','Synthetic Staff',null,foreignReq)).rows[0].ok,false);await db.exec('RESET ROLE');assert.equal((await rows('SELECT status FROM core.catering_requests WHERE id=$1',[foreignReq]))[0].status,'new')});
 for(const [label,id,role] of [['unlisted account',guest,'authenticated'],['inactive staff',inactive,'authenticated'],['no identity',null,'authenticated'],['anonymous role',null,'anon']])await run(`${label}: update denied`,async()=>{
  await identity(id,role);await db.exec('SAVEPOINT deny');try{await assert.rejects(update('closed','Synthetic Staff',null),e=>e.code==='42501')}finally{await db.exec('ROLLBACK TO SAVEPOINT deny;RELEASE SAVEPOINT deny')}
 });
 await run('owner role can update valid request',async()=>{await identity(owner);assert.equal((await update('quoted')).rows[0].ok,true)});
 await run('authenticated cannot directly update table',async()=>{await identity();await db.exec('SAVEPOINT direct_write');try{await assert.rejects(db.query('UPDATE core.catering_requests SET status=$1 WHERE id=$2',['closed',req]),e=>e.code==='42501')}finally{await db.exec('ROLLBACK TO SAVEPOINT direct_write;RELEASE SAVEPOINT direct_write')}
 });
 await run('test request stays outside real queue',async()=>{await db.exec('RESET ROLE');await db.query('UPDATE core.catering_requests SET is_test=true WHERE id=$1',[req]);await identity();assert.equal((await queue()).total,0)});
 await db.exec('RESET ROLE;ROLLBACK');
 const remaining=(await rows('SELECT (SELECT count(*) FROM core.customers)::int customers,(SELECT count(*) FROM core.signups)::int signups,(SELECT count(*) FROM core.catering_requests)::int requests'))[0];
 await run('rollback leaves no synthetic business records',async()=>assert.ok(Object.values(remaining).every(n=>n===0)));
 const result={task:'07.05',checked_at_utc:new Date().toISOString(),source_checked_at_utc:source.checked_at_utc,environment:'isolated in-memory PostgreSQL/PGlite',production_writes:0,emails_sent:0,migration_applied:process.env.SKIP_CATERING_FIX!=='true',migration_sha256:crypto.createHash('sha256').update(migration).digest('hex'),override_used:!!process.env.CATERING_UPDATE_OVERRIDE,passed:passed.length,failed:failed.length,checks:passed,failures:failed,remaining,source_function_hashes:source.functions.map(f=>({name:f.name,sha256:crypto.createHash('sha256').update(f.definition).digest('hex')})),scope:'Database role simulation and saved field/queue checks; no real browser login test or payment.'};
 if(process.env.CATERING_RESULT_FILE)await fs.writeFile(process.env.CATERING_RESULT_FILE,JSON.stringify(result,null,2));
 console.log(JSON.stringify({passed:result.passed,failed:result.failed,failures:failed,remaining},null,2));if(failed.length)process.exitCode=1;
}finally{await db.close()}
