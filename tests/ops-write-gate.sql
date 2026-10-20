-- Synthetic two-tenant local PostgreSQL test only; never run against hosted DB.
INSERT INTO auth.users VALUES ('33333333-3333-4333-8333-333333333333'),('44444444-4444-4444-8444-444444444444'),('55555555-5555-4555-8555-555555555555');
INSERT INTO core.businesses VALUES ('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
INSERT INTO core.crm_staff VALUES ('33333333-3333-4333-8333-333333333333',true),('44444444-4444-4444-8444-444444444444',true);
INSERT INTO core.ops_write_staff(business_id,staff_id) VALUES ('11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333'),('22222222-2222-4222-8222-222222222222','44444444-4444-4444-8444-444444444444');
INSERT INTO core.ops_write_settings VALUES ('11111111-1111-4111-8111-111111111111',false),('22222222-2222-4222-8222-222222222222',false);
CREATE FUNCTION pg_temp.expect_error(statement text,expected text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN IF SQLSTATE=expected THEN RETURN; ELSE RAISE; END IF; END;
 RAISE EXCEPTION 'Expected SQLSTATE %',expected;
END; $$;
DO $$
DECLARE b uuid:='11111111-1111-4111-8111-111111111111'; t uuid:='66666666-6666-4666-8666-666666666666';
 u uuid:='33333333-3333-4333-8333-333333333333'; h text:=repeat('a',64); r jsonb; c jsonb; action uuid;
BEGIN
 PERFORM set_config('request.jwt.claim.sub',u::text,false);
 r:=public.ops_write_preview(b,t,h,'77777777-7777-4777-8777-777777777777');action:=(r->>'id')::uuid;
 ASSERT r->>'status'='previewed';
 ASSERT public.ops_write_preview(b,t,h,'77777777-7777-4777-8777-777777777777')->>'id'=action::text;
 PERFORM pg_temp.expect_error(format('SELECT public.ops_write_preview(%L,%L,%L,%L)',b,t,repeat('b',64),'77777777-7777-4777-8777-777777777777'),'22023');
 r:=public.ops_write_approve(b,action,t,h);ASSERT r->>'status'='approved';
 PERFORM pg_temp.expect_error(format('SELECT public.ops_write_claim(%L,%L,%L,%L,%L)',b,action,u,'88888888-8888-4888-8888-888888888888',h),'22023');
 PERFORM pg_temp.expect_error(format('SELECT public.ops_write_claim(%L,%L,%L,%L,%L)',b,action,u,t,repeat('b',64)),'22023');
 c:=public.ops_write_claim(b,action,u,t,h);ASSERT c->>'status'='executing';
 ASSERT public.ops_write_claim(b,action,u,t,h) IS NULL;
 ASSERT public.ops_write_finalize(b,action,u,'88888888-8888-4888-8888-888888888888',true) IS NULL;
 r:=public.ops_write_finalize(b,action,u,(c->>'claim_token')::uuid,true);ASSERT r->>'status'='succeeded';ASSERT NOT r?'claim_token';
 ASSERT public.ops_write_finalize(b,action,u,(c->>'claim_token')::uuid,true) IS NULL;
 ASSERT public.ops_write_approve(b,action,t,h)->>'status'='succeeded';
 -- Preview and approval expiration, including persistent expired state.
 r:=public.ops_write_preview(b,t,h,gen_random_uuid());action:=(r->>'id')::uuid;
 UPDATE core.ops_write_actions SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE business_id=b AND id=action;
 ASSERT public.ops_write_approve(b,action,t,h)->>'status'='expired';
 r:=public.ops_write_preview(b,t,h,gen_random_uuid());action:=(r->>'id')::uuid;
 PERFORM public.ops_write_approve(b,action,t,h);
 UPDATE core.ops_write_actions SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE business_id=b AND id=action;
 ASSERT public.ops_write_claim(b,action,u,t,h) IS NULL;
 ASSERT public.ops_write_status(b,action)->>'status'='expired';
 -- Kill switch before claim, and again between claim and finalize.
 r:=public.ops_write_preview(b,t,h,gen_random_uuid());action:=(r->>'id')::uuid;PERFORM public.ops_write_approve(b,action,t,h);
 UPDATE core.ops_write_settings SET kill_switch=true WHERE business_id=b;
 PERFORM pg_temp.expect_error(format('SELECT public.ops_write_claim(%L,%L,%L,%L,%L)',b,action,u,t,h),'55000');
 UPDATE core.ops_write_settings SET kill_switch=false WHERE business_id=b;
 c:=public.ops_write_claim(b,action,u,t,h);
 UPDATE core.ops_write_settings SET kill_switch=true WHERE business_id=b;
 r:=public.ops_write_finalize(b,action,u,(c->>'claim_token')::uuid,true);ASSERT r->>'safe_result_code'='disabled';ASSERT r->>'status'='failed';
 UPDATE core.ops_write_settings SET kill_switch=false WHERE business_id=b;
 -- Another staff member has only tenant B membership, not tenant A.
 PERFORM set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
 PERFORM pg_temp.expect_error(format('SELECT public.ops_write_status(%L,%L)',b,action),'42501');
 PERFORM pg_temp.expect_error(format('SELECT public.ops_write_preview(%L,%L,%L,%L)',b,t,h,gen_random_uuid()),'42501');
 r:=public.ops_write_preview('22222222-2222-4222-8222-222222222222',t,h,gen_random_uuid());ASSERT r->>'business_id'='22222222-2222-4222-8222-222222222222';
 PERFORM set_config('request.jwt.claim.sub','55555555-5555-4555-8555-555555555555',false);
 PERFORM pg_temp.expect_error(format('SELECT public.ops_write_preview(%L,%L,%L,%L)',b,t,h,gen_random_uuid()),'42501');
 ASSERT NOT has_table_privilege('authenticated','core.ops_write_actions','INSERT');
 ASSERT NOT has_table_privilege('service_role','core.ops_write_actions','UPDATE');
 ASSERT NOT has_function_privilege('authenticated','public.ops_write_claim(uuid,uuid,uuid,uuid,text)','EXECUTE');
 ASSERT NOT has_function_privilege('anon','public.ops_write_preview(uuid,uuid,text,uuid)','EXECUTE');
 ASSERT has_function_privilege('authenticated','public.ops_write_approve(uuid,uuid,uuid,text)','EXECUTE');
 ASSERT has_function_privilege('service_role','public.ops_write_finalize(uuid,uuid,uuid,uuid,boolean)','EXECUTE');
END; $$;
-- Real caller role verifies the SECURITY DEFINER wrapper works without table access.
SELECT set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
SET ROLE authenticated;
SELECT public.ops_write_preview('11111111-1111-4111-8111-111111111111','66666666-6666-4666-8666-666666666666',repeat('a',64),'99999999-9999-4999-8999-999999999999');
RESET ROLE;
