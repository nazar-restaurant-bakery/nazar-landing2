-- LOCAL full-baseline synthetic proof only. No hosted connection or provider.
BEGIN;
CREATE FUNCTION pg_temp.policy_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
RAISE NOTICE 'PASS %',label; END $$;
DO $seed$
DECLARE a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); sa uuid:=gen_random_uuid(); pb uuid:=gen_random_uuid(); lu uuid:=gen_random_uuid();
BEGIN
  INSERT INTO core.businesses(id,name,is_test) VALUES(a,'Synthetic Storage A',true),(b,'Synthetic Storage B',true);
  INSERT INTO auth.users(id) VALUES(sa),(pb),(lu);
  INSERT INTO core.business_staff(business_id,staff_id,role,active) VALUES(a,sa,'staff',true);
  INSERT INTO core.platform_operators(staff_id,active) VALUES(pb,true);
  INSERT INTO core.crm_staff(auth_user_id,role,active) VALUES(lu,'owner',true);
  INSERT INTO storage.objects(bucket_id,name) VALUES
    ('nazar-ops',a::text||'/ops/commission/2026-10-'||gen_random_uuid()::text||'.pdf'),
    ('nazar-ops',b::text||'/ops/commission/2026-10-'||gen_random_uuid()::text||'.pdf'),
    ('nazar-ops','------------------------------------/ops/commission/2026-10-'||gen_random_uuid()::text||'.pdf');
  PERFORM set_config('test.staff_a',sa::text,true);
  PERFORM set_config('test.platform',pb::text,true);
  PERFORM set_config('test.legacy_only',lu::text,true);
END $seed$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub',current_setting('test.staff_a'),true);
SELECT pg_temp.policy_assert((SELECT count(*) FROM storage.objects)=1,'actual Storage RLS own-business only');
SELECT set_config('request.jwt.claim.sub',current_setting('test.platform'),true);
SELECT pg_temp.policy_assert((SELECT count(*) FROM storage.objects)=2,'actual Storage RLS platform read excludes malformed path');
SELECT set_config('request.jwt.claim.sub',current_setting('test.legacy_only'),true);
SELECT pg_temp.policy_assert((SELECT count(*) FROM storage.objects)=0,'actual Storage RLS legacy-only denied');
RESET ROLE;
ROLLBACK;

BEGIN;
CREATE FUNCTION pg_temp.execution_assert(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL %',label; END IF;
RAISE NOTICE 'PASS %',label; END $$;
DO $execution$
DECLARE a uuid; staff_user uuid:=gen_random_uuid(); wrong_user uuid:=gen_random_uuid(); action_id uuid:=gen_random_uuid();
  second_action uuid:=gen_random_uuid(); customer_id uuid:=gen_random_uuid(); event_id uuid; result jsonb;
BEGIN
  SELECT business_id INTO a FROM core.ops_connections LIMIT 1;
  INSERT INTO core.businesses(id,name,is_test) VALUES(a,'Synthetic execution A',true);
  INSERT INTO auth.users(id) VALUES(staff_user),(wrong_user);
  INSERT INTO core.business_staff(business_id,staff_id,role,active) VALUES(a,staff_user,'staff',true);
  INSERT INTO core.ops_actions(id,business_id,request_key,request_fingerprint,action,requested_by)
    VALUES(action_id,a,gen_random_uuid(),'synthetic-one','collect',staff_user);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('request.jwt.claim.sub','',true);
  BEGIN
    PERFORM public.ops_claim_action(action_id,wrong_user);
    RAISE EXCEPTION 'FAIL forged requester unexpectedly claimed';
  EXCEPTION WHEN SQLSTATE '42501' THEN RAISE NOTICE 'PASS Ops claim rejects caller-supplied wrong actor'; END;
  result:=public.ops_claim_action(action_id,staff_user);
  PERFORM pg_temp.execution_assert(result->>'requested_by'=staff_user::text,'Ops claim uses persisted requester with active membership');
  UPDATE core.ops_actions SET status='done',finished_at=now() WHERE id=action_id;
  UPDATE core.business_staff SET active=false WHERE business_id=a AND staff_id=staff_user;
  INSERT INTO core.ops_actions(id,business_id,request_key,request_fingerprint,action,requested_by)
    VALUES(second_action,a,gen_random_uuid(),'synthetic-two','collect',staff_user);
  BEGIN
    PERFORM public.ops_claim_action(second_action,staff_user);
    RAISE EXCEPTION 'FAIL inactive requester unexpectedly claimed';
  EXCEPTION WHEN SQLSTATE '42501' THEN RAISE NOTICE 'PASS Ops claim rejects revoked membership'; END;
  UPDATE core.business_staff SET active=true WHERE business_id=a AND staff_id=staff_user;
  INSERT INTO core.customers(id,business_id,identity_key,name,email,email_status,email_suppressed_at,is_test)
    VALUES(customer_id,a,'synthetic:'||customer_id::text,'INTERNAL TEST',customer_id::text||'@example.invalid','unsubscribed',now()-interval '2 minutes',true);
  INSERT INTO core.consent_events(customer_id,event_type,source,evidence_status,created_at)
    VALUES(customer_id,'suppression','synthetic','admin_suppression',now()-interval '2 minutes');
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claim.sub',staff_user::text,true);
  event_id:=public.crm_restore_email_consent_v1(customer_id,now()-interval '1 minute','customer_web','synthetic retained evidence',repeat('b',64),true,true);
  PERFORM pg_temp.execution_assert(event_id IS NOT NULL AND EXISTS(SELECT 1 FROM core.consent_events WHERE id=event_id AND event_type='reconsent'),'K4 restore preserves customer-origin evidence event');
  PERFORM pg_temp.execution_assert((SELECT email_status='subscribed' FROM core.customers WHERE id=customer_id),'K4 restore succeeds with shared membership without legacy crm_staff');
END $execution$;
ROLLBACK;
