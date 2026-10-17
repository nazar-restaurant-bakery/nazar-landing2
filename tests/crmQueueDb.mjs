import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db=new PGlite();
const passed=[];const check=(v,label)=>{assert.ok(v,label);passed.push(label)};
const staff='11111111-1111-4111-8111-111111111111', guest='22222222-2222-4222-8222-222222222222';
const c='44444444-4444-4444-8444-444444444444', testCustomer='55555555-5555-4555-8555-555555555555', other='66666666-6666-4666-8666-666666666666';
const business='a358eba4-b197-4309-805b-46f43a718454';
const migration=await fs.readFile(new URL('../database/20261016_crm_follow_up_queue.sql',import.meta.url),'utf8');
const rows=async(sql,args)=>(await db.query(sql,args)).rows;
const queue=async(name='open_catering',offset=0)=>(await rows('SELECT public.crm_follow_up_queue_v1($1,$2) data',[name,offset]))[0].data;
try {
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA core;CREATE SCHEMA auth;
 CREATE TABLE core.installation(declared_project_ref text);INSERT INTO core.installation VALUES('khgczybubufouraqyrcj');
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 CREATE TABLE auth.users(id uuid PRIMARY KEY);INSERT INTO auth.users VALUES('${staff}'),('${guest}');
 CREATE TABLE core.crm_staff(auth_user_id uuid,active boolean);INSERT INTO core.crm_staff VALUES('${staff}',true);
 CREATE TABLE core.customers(id uuid PRIMARY KEY,business_id uuid,name text);
 CREATE TABLE core.signups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid,is_test boolean NOT NULL DEFAULT false);
 CREATE TABLE core.catering_requests(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid,status text,assigned_to text,follow_up_at timestamptz,created_at timestamptz DEFAULT now(),is_test boolean NOT NULL DEFAULT false);
 INSERT INTO core.customers VALUES('${c}','${business}','Synthetic real-scope'),('${testCustomer}','${business}','Synthetic test-only'),('${other}','77777777-7777-4777-8777-777777777777','Other business');
 INSERT INTO core.signups(customer_id,is_test) VALUES('${c}',false),('${c}',true),('${testCustomer}',true),('${other}',false);
 `);
 await db.exec(await fs.readFile(new URL('../database/20261013_crm_follow_up_tasks.sql',import.meta.url),'utf8'));
 await db.exec(await fs.readFile(new URL('../database/20261013_catering_decision_queue.sql',import.meta.url),'utf8'));
 await db.exec(migration);
 await db.exec(`SET request.jwt.claim.sub='${staff}';SET ROLE authenticated`);
 check((await queue()).total===0,'Empty queue returns a valid explicit zero');
 await db.exec(`RESET ROLE;
 INSERT INTO core.catering_requests(customer_id,status,assigned_to,follow_up_at,created_at)
 SELECT '${c}','new','Synthetic staff',now()+interval '1 day',now()+n*interval '1 second' FROM generate_series(1,130) n;
 INSERT INTO core.catering_requests(customer_id,status,assigned_to,follow_up_at,created_at)
 VALUES('${c}','contacted','   ',NULL,now()-interval '4 days'),('${c}','quoted','Synthetic staff',now()-interval '2 days',now()-interval '5 days'),
 ('${c}','closed',NULL,NULL,now()),('${c}','won',NULL,NULL,now()),('${c}','lost',NULL,NULL,now());
 INSERT INTO core.catering_requests(customer_id,status,is_test) VALUES('${c}','new',true),('${testCustomer}','new',true),('${other}','new',false);
 INSERT INTO core.customer_follow_up_tasks(customer_id,created_by,title,assigned_to,due_at)
 SELECT '${c}','${staff}','Synthetic task '||n,'Synthetic staff',now()+n*interval '1 minute' FROM generate_series(1,63) n;
 INSERT INTO core.customer_follow_up_tasks(customer_id,created_by,title,assigned_to,due_at,completed_at)
 VALUES('${c}','${staff}','Synthetic overdue','Synthetic staff',now()-interval '2 days',NULL),
 ('${c}','${staff}','Synthetic completed','Synthetic staff',now()-interval '2 days',now()),
 ('${testCustomer}','${staff}','Synthetic test-only task','Synthetic staff',now()-interval '1 day',NULL),
 ('${other}','${staff}','Synthetic other business task','Synthetic staff',now()-interval '1 day',NULL);
 INSERT INTO core.catering_decisions(request_id,question,requested_by)
 SELECT id,'Synthetic decision','${staff}' FROM core.catering_requests WHERE customer_id='${c}' AND status IN ('new','closed') LIMIT 105;
 SET ROLE authenticated;
 `);
 const first=await queue();
 check(first.total===132&&first.items.length===25,'Counts exceed 100 and pages are bounded at 25');
 check(first.counts.missing_owner===1&&first.counts.missing_followup===1&&first.counts.overdue_catering===1,'Missing owner, missing time and overdue counts are independent');
 check(first.items[0].flags.includes('overdue')&&first.items[1].flags.includes('missing_followup'),'Overdue items sort before undated and scheduled items');
 const ids=[];for(let offset=0;offset<first.total;offset+=25)ids.push(...(await queue('open_catering',offset)).items.map(x=>x.id));
 check(ids.length===132&&new Set(ids).size===132,'Every request beyond 100 is reachable once across pages');
 check((await queue('open_catering',150)).items.length===0,'An exhausted page does not change the full total');
 check((await queue('missing_followup')).items.every(x=>x.due_at===null&&!x.flags.includes('overdue')),'Undated requests are not mislabeled overdue');
 check((await queue('open_tasks')).total===64&&(await queue('overdue_tasks')).total===1,'General tasks include more than the per-customer 50 limit and exclude completed/test-only/other-business items');
 check((await queue('open_tasks')).items[0].title==='Synthetic overdue','General overdue tasks are first');
 const decisionCount=(await queue('pending_decisions')).total;
 check(decisionCount>100,'Pending decisions are not limited to 100');
 check((await queue('pending_decisions',100)).items.length===decisionCount-100,'Pending-decision pages cover the remainder');
 await db.exec('BEGIN');
 const late=first.items.find(x=>x.flags.includes('overdue'));
 check((await rows('SELECT public.crm_complete_task_v1($1) ok',[(await queue('overdue_tasks')).items[0].id]))[0].ok,'Existing completion API remains usable');
 check((await queue('overdue_tasks')).total===0,'Completing a task removes it from the queue');
 await db.query("UPDATE core.catering_requests SET status='closed' WHERE id=$1",[late.id]).then(()=>assert.fail('direct write allowed'),e=>check(e.code==='42501','Authenticated users still cannot update core tables directly'));
 await db.exec('ROLLBACK;RESET ROLE');
 await db.query("UPDATE core.catering_requests SET status='closed' WHERE id=$1",[late.id]);
 await db.exec('SET ROLE authenticated');
 check((await queue()).total===131&&(await queue()).counts.overdue_catering===0,'Closing a request persists and removes it from active categories');
 await db.exec(`RESET ROLE;SET ROLE anon`);await assert.rejects(queue(),e=>e.code==='42501');check(true,'Anonymous invocation denied');
 await db.exec(`RESET ROLE;SET ROLE authenticated;SET request.jwt.claim.sub='${guest}'`);await assert.rejects(queue(),e=>e.code==='42501');check(true,'Authenticated nonstaff denied');
 await db.exec(`RESET ROLE;UPDATE core.crm_staff SET active=false;SET ROLE authenticated;SET request.jwt.claim.sub='${staff}'`);await assert.rejects(queue(),e=>e.code==='42501');check(true,'Inactive staff denied');
 await db.exec('RESET ROLE;UPDATE core.crm_staff SET active=true;SET ROLE authenticated');
 for(const args of [['bad',0],['open_catering',-1],[null,0],['open_catering',null]])await assert.rejects(()=>queue(...args),e=>e.code==='22023');
 check(true,'Invalid category and offsets are rejected');
 await db.exec('RESET ROLE');
 const definition=(await rows("SELECT pg_get_functiondef('public.crm_follow_up_queue_v1(text,integer)'::regprocedure) def"))[0].def;
 check(/SECURITY DEFINER/.test(definition)&&/SET search_path TO ''/.test(definition),'Function uses a fixed empty search path');
 await assert.rejects(()=>db.exec(migration),/already exists/);await db.exec('ROLLBACK');
 check(true,'Repeated migration stops safely instead of overwriting an installed function');
 check((await queue()).total===131,'Guard rejection leaves installed queue intact');
 await db.exec(`UPDATE core.installation SET declared_project_ref='wrong-project'`);
 await assert.rejects(()=>db.exec(migration),/expected Nazar/);await db.exec('ROLLBACK');check(true,'Wrong installation is rejected');
 console.log(JSON.stringify({passed:passed.length,failed:0,engine:'isolated PostgreSQL/PGlite',production_writes:0,checks:passed},null,2));
} catch(error) {console.error(JSON.stringify({failed:true,message:error.message,code:error.code,passed:passed.length}));process.exitCode=1;}
finally{await db.close();}
