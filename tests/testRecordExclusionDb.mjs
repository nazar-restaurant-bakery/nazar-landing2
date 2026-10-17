const {PGlite}=await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
import fs from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
const migration=fs.readFileSync(new URL('../database/20261013_test_record_exclusion.sql',import.meta.url),'utf8');
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA core; CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE TABLE core.installation(declared_project_ref text); INSERT INTO core.installation VALUES('khgczybubufouraqyrcj');
CREATE TABLE core.crm_staff(auth_user_id uuid,active boolean);
INSERT INTO core.crm_staff VALUES('11111111-1111-4111-8111-111111111111',true);
CREATE TABLE core.customers(id uuid PRIMARY KEY,business_id uuid,name text,email text,phone text,email_status text,created_at timestamptz DEFAULT now());
CREATE TABLE core.signups(id uuid PRIMARY KEY,customer_id uuid,business_id uuid,name text,email text,source text,created_at timestamptz DEFAULT now(),utm jsonb DEFAULT '{}');
CREATE TABLE core.catering_requests(id uuid PRIMARY KEY,signup_id uuid,customer_id uuid,event_date date,guests int,message text,status text,assigned_to text,follow_up_at timestamptz,created_at timestamptz DEFAULT now());
CREATE TABLE core.customer_notes(id uuid,customer_id uuid,body text,created_at timestamptz);
INSERT INTO core.customers(id,business_id,name,email,email_status) VALUES
('22222222-2222-4222-8222-222222222222','a358eba4-b197-4309-805b-46f43a718454','Synthetic','legacy@customer-mail.com','pending_review');
INSERT INTO core.signups(id,customer_id,business_id,name,email,source) VALUES
('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','a358eba4-b197-4309-805b-46f43a718454','Legacy synthetic','legacy@customer-mail.com','catering');
INSERT INTO core.catering_requests(id,signup_id,customer_id,status,assigned_to) VALUES
('44444444-4444-4444-8444-444444444444','33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','new','CRM Test');
`);
await db.exec(migration);
let checks=0;
const check=(v,msg)=>{assert.ok(v,msg);checks++};
let r=await db.query('SELECT is_test,test_reason FROM core.signups');check(r.rows[0].is_test && r.rows[0].test_reason==='legacy_crm_test_assignment','legacy explicit marker backfill');
r=await db.query('SELECT is_test FROM core.catering_requests');check(r.rows[0].is_test,'catering inherits legacy marker');
await db.exec(`SET request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';`);
r=await db.query("SELECT public.crm_overview_v2('', 'all') AS result");check(r.rows[0].result.customers.length===0 && r.rows[0].result.requests.length===0,'default excludes tests');
r=await db.query("SELECT public.crm_overview_v2('', 'test') AS result");check(r.rows[0].result.customers.length===1 && r.rows[0].result.requests.length===1,'tests remain inspectable');
await db.exec(`INSERT INTO core.signups(id,customer_id,business_id,name,email,source) VALUES
('55555555-5555-4555-8555-555555555555','22222222-2222-4222-8222-222222222222','a358eba4-b197-4309-805b-46f43a718454','Testerman','real@customer-mail.com','website_vip_page'),
('66666666-6666-4666-8666-666666666666','22222222-2222-4222-8222-222222222222','a358eba4-b197-4309-805b-46f43a718454','Guest','qa@sub.invalid','website_vip_page');`);
r=await db.query("SELECT is_test FROM core.signups WHERE id='55555555-5555-4555-8555-555555555555'");check(r.rows[0].is_test===false,'ordinary surname not a test');
r=await db.query("SELECT is_test FROM core.signups WHERE id='66666666-6666-4666-8666-666666666666'");check(r.rows[0].is_test===true,'new reserved email flagged');
r=await db.query("SELECT public.crm_overview_v2('', 'vip') AS result");check(r.rows[0].result.customers[0].signup_count===1 && r.rows[0].result.customers[0].vip_signup_count===1,'mixed customer real counts exclude its test signups');
r=await db.query('SELECT count(*)::int AS n FROM core.reporting_signups_v1');check(r.rows[0].n===1,'reporting view excludes tests');
r=await db.query('SELECT count(*)::int AS n FROM core.signups');check(r.rows[0].n===3,'no data deleted');
await db.exec(`INSERT INTO core.customers(id,business_id,name,email,email_status) VALUES
('88888888-8888-4888-8888-888888888888','a358eba4-b197-4309-805b-46f43a718454','Manual synthetic','manual@customer-mail.com','not_subscribed');`);
r=await db.query("SELECT public.crm_overview_v2('', 'all') AS result");check(r.rows[0].result.customers.length===2,'manual customers without signups remain visible');
await db.exec(`INSERT INTO core.catering_requests(id,signup_id,customer_id,status) VALUES
('99999999-9999-4999-8999-999999999999','55555555-5555-4555-8555-555555555555','22222222-2222-4222-8222-222222222222','new');
UPDATE core.signups SET is_test=true,test_reason='reviewed_test' WHERE id='55555555-5555-4555-8555-555555555555';`);
r=await db.query("SELECT is_test,test_reason FROM core.catering_requests WHERE id='99999999-9999-4999-8999-999999999999'");check(r.rows[0].is_test && r.rows[0].test_reason==='reviewed_test','later test classification propagates to linked catering');
await db.exec("SET request.jwt.claim.sub='77777777-7777-4777-8777-777777777777'");
try{await db.query("SELECT public.crm_overview_v2('', 'test')");assert.fail('unauthorized success')}catch(e){check(e.code==='42501','unlisted user remains denied')}
try{await db.query("SELECT public.crm_overview_v2('', 'all')");assert.fail('unauthorized success')}catch(e){check(e.code==='42501','unlisted normal group denied')}
await db.exec(migration);check(true,'migration repeat-safe');
await db.close();
console.log(JSON.stringify({passed:checks,failed:0,engine:'isolated PostgreSQL/PGlite'}));
