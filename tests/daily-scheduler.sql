-- Local PostgreSQL test; pg_net/Vault are synthetic stubs, no outbound network.
SELECT set_config('fixture.a',:'business_a',false),set_config('fixture.b',:'business_b',false),set_config('fixture.owner',:'user_ownerA',false),set_config('fixture.staffB',:'user_staffB',false),set_config('fixture.platform',:'user_platformOnly',false),set_config('fixture.unauthorized',:'user_legacyOnly',false);
INSERT INTO auth.users VALUES(:'user_ownerA'),(:'user_staffB'),(:'user_platformOnly'),(:'user_legacyOnly');
INSERT INTO core.businesses VALUES(:'business_a'),(:'business_b');
INSERT INTO core.business_staff VALUES(:'business_a',:'user_ownerA','owner',true),(:'business_b',:'user_staffB','staff',true);
INSERT INTO core.platform_operators VALUES(:'user_platformOnly',true);
-- The production migration copies quota only for existing businesses. These
-- generated fixtures are created afterward, so reproduce the same legacy seed.
INSERT INTO core.daily_external_budget SELECT b.id,q.day_ny,q.requests FROM core.businesses b CROSS JOIN core.ops_api_budget q;
INSERT INTO core.daily_scheduler_settings(business_id,clover_url) VALUES(:'business_a','https://a.example/api/internal/daily-clover-pull'),(:'business_b','https://b.example/api/internal/daily-clover-pull');
CREATE FUNCTION pg_temp.expect_error(statement text,expected text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN
 BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN IF SQLSTATE=expected THEN RETURN; ELSE RAISE; END IF; END;
 RAISE EXCEPTION 'Expected SQLSTATE %',expected;
END; $$;
DO $$
DECLARE a uuid:=current_setting('fixture.a')::uuid;b uuid:=current_setting('fixture.b')::uuid;
 r core.daily_scheduler_runs;x jsonb;y jsonb;n bigint;i integer;
BEGIN
 ASSERT core.daily_scheduler_tick('2026-03-08T11:00:00Z')=0; -- default disabled
 UPDATE core.daily_scheduler_settings SET enabled=true;
 ASSERT core.daily_scheduler_tick('2026-03-08T10:59:00Z')=0;
 ASSERT core.daily_scheduler_tick('2026-03-08T11:00:00Z')=2; -- 07:00 EDT
 ASSERT core.daily_scheduler_tick('2026-03-08T11:00:59Z')=0;
 ASSERT (SELECT count(*) FROM net.test_outbox)=2;
 ASSERT core.daily_scheduler_tick('2026-11-01T11:00:00Z')=0; -- 06:00 EST
 ASSERT core.daily_scheduler_tick('2026-11-01T12:00:00Z')=2; -- 07:00 EST
 ASSERT core.daily_scheduler_tick('2026-11-01T12:00:30Z')=0;
 ASSERT core.daily_scheduler_tick('2026-03-09T11:00:00Z')=2;
 SELECT * INTO r FROM core.daily_scheduler_runs WHERE business_id=a AND local_date='2026-03-09';
 UPDATE core.daily_scheduler_runs SET created_at=clock_timestamp() WHERE business_id=a AND id=r.id;
 ASSERT public.daily_scheduler_start(b,r.id,r.nonce) IS NULL;
 x:=public.daily_scheduler_start(a,r.id,r.nonce);ASSERT x IS NOT NULL;
 ASSERT (x->>'end_ms')::bigint-(x->>'start_ms')::bigint=23*3600000;
 ASSERT public.daily_scheduler_start(a,r.id,r.nonce) IS NULL;
 ASSERT public.daily_run_check(b,r.id,(x->>'claim_token')::uuid) IS FALSE;
 ASSERT public.daily_reserve_external_request(b,r.id,(x->>'claim_token')::uuid) IS FALSE;
 ASSERT public.daily_clover_claim(a,r.id,(x->>'claim_token')::uuid) IS TRUE;
 ASSERT public.daily_clover_claim(a,r.id,(x->>'claim_token')::uuid) IS FALSE;
 ASSERT public.daily_clover_finish(a,r.id,(x->>'claim_token')::uuid,'succeeded') IS TRUE;
 -- Legacy aggregate reader must never leak tenant A totals into a multi-tenant project.
 PERFORM pg_temp.expect_error(format('SELECT public.daily_ops_snapshot(%L,%L,%L)',a,r.id,x->>'claim_token'),'55000');
 FOR i IN 1..27 LOOP ASSERT public.daily_reserve_external_request(a,r.id,(x->>'claim_token')::uuid) IS TRUE; END LOOP;
 ASSERT public.daily_reserve_external_request(a,r.id,(x->>'claim_token')::uuid) IS FALSE;
 ASSERT public.daily_reserve_external_request(b) IS TRUE;
 ASSERT (SELECT requests FROM core.daily_external_budget WHERE business_id=b)=4;
 UPDATE core.daily_scheduler_settings SET enabled=false WHERE business_id=a;
 ASSERT public.daily_run_check(a,r.id,(x->>'claim_token')::uuid) IS FALSE;
 ASSERT public.daily_reserve_external_request(a,r.id,(x->>'claim_token')::uuid) IS FALSE;
 y:=public.daily_scheduler_finish(a,r.id,(x->>'claim_token')::uuid,'failed','paused');
 ASSERT y->>'status'='failed';ASSERT (y->>'reconciled')::boolean IS FALSE;
 ASSERT NOT y?'nonce' AND NOT y?'claim_token';
 ASSERT public.daily_scheduler_finish(a,r.id,(x->>'claim_token')::uuid,'failed','paused') IS NULL;
 UPDATE core.daily_scheduler_settings SET enabled=true WHERE business_id=a;
 ASSERT core.daily_scheduler_tick('2026-11-02T12:00:00Z')=2;
 SELECT * INTO r FROM core.daily_scheduler_runs WHERE business_id=a AND local_date='2026-11-02';
 UPDATE core.daily_scheduler_runs SET created_at=clock_timestamp() WHERE business_id=a AND id=r.id;
 x:=public.daily_scheduler_start(a,r.id,r.nonce);
 ASSERT (x->>'end_ms')::bigint-(x->>'start_ms')::bigint=25*3600000;
 SELECT count(*) INTO n FROM net.test_outbox;
 ASSERT core.daily_scheduler_tick('2026-03-10T11:01:00Z')=0;
 ASSERT (SELECT status FROM core.daily_scheduler_runs WHERE business_id=a AND local_date='2026-03-10')='missed';
 ASSERT (SELECT count(*) FROM net.test_outbox)=n;
 DELETE FROM vault.decrypted_secrets WHERE name='SCHEDULER_SIGNING_SECRET';
 ASSERT core.daily_scheduler_tick('2026-03-11T11:00:00Z')=0;
 ASSERT (SELECT safe_code FROM core.daily_scheduler_runs WHERE business_id=a AND local_date='2026-03-11')='dispatch_failed';
 INSERT INTO vault.decrypted_secrets VALUES('SCHEDULER_SIGNING_SECRET','synthetic-machine-key-not-used-anywhere-live-123456');
 PERFORM set_config('request.jwt.claim.sub',current_setting('fixture.owner'),false);
 PERFORM set_config('request.jwt.claim.role','authenticated',false);
 ASSERT public.daily_scheduler_status(a)->'last_run'->>'business_id'=a::text;
 PERFORM pg_temp.expect_error(format('SELECT public.daily_scheduler_status(%L)',b),'42501');
 PERFORM set_config('request.jwt.claim.sub',current_setting('fixture.platform'),false);
 ASSERT public.daily_scheduler_status(b)->'last_run'->>'business_id'=b::text;
 PERFORM set_config('request.jwt.claim.sub',current_setting('fixture.unauthorized'),false);
 PERFORM pg_temp.expect_error(format('SELECT public.daily_scheduler_status(%L)',a),'42501');
 ASSERT NOT has_table_privilege('authenticated','core.daily_scheduler_runs','SELECT');
 ASSERT NOT has_function_privilege('authenticated','public.daily_scheduler_start(uuid,uuid,uuid)','EXECUTE');
 ASSERT NOT has_function_privilege('anon','core.daily_scheduler_tick(timestamptz)','EXECUTE');
 ASSERT has_function_privilege('service_role','public.daily_scheduler_start(uuid,uuid,uuid)','EXECUTE');
END; $$;
