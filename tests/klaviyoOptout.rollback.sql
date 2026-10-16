-- Synthetic, no API calls, no email. Every business-data change rolls back.
BEGIN;
SET LOCAL statement_timeout='20s';
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.installation WHERE declared_project_ref='khgczybubufouraqyrcj') THEN RAISE EXCEPTION 'Wrong project'; END IF;
END $guard$;
DO $test$
DECLARE id1 uuid:='05dc64af-2846-4540-99d1-d368026d888b';
 id2 uuid:='93b4aa43-109b-463f-9214-9e09703d1ba7'; r jsonb; v_time timestamptz:=clock_timestamp();
 v_events integer;
BEGIN
 IF has_function_privilege('anon','public.record_klaviyo_status_v1(uuid,text,text,timestamptz,timestamptz)','EXECUTE')
 OR has_function_privilege('authenticated','public.record_klaviyo_status_v1(uuid,text,text,timestamptz,timestamptz)','EXECUTE')
 OR NOT has_function_privilege('service_role','public.record_klaviyo_status_v1(uuid,text,text,timestamptz,timestamptz)','EXECUTE')
 OR has_table_privilege('authenticated','core.klaviyo_email_observations','SELECT') THEN RAISE EXCEPTION 'Unexpected privileges'; END IF;
 INSERT INTO core.customers(id,business_id,identity_key,name,email,email_status)
 VALUES(id1,'a358eba4-b197-4309-805b-46f43a718454','email:optout-a@example.invalid','INTERNAL TEST optout rollback A','optout-a@example.invalid','pending_review'),
 (id2,'a358eba4-b197-4309-805b-46f43a718454','email:optout-b@example.invalid','INTERNAL TEST optout rollback B','optout-b@example.invalid','pending_review');
 r:=public.record_klaviyo_status_v1(id1,'optout-a@example.invalid','unsubscribed',v_time,NULL);
 IF r->>'blocked'<>'true' OR (SELECT email_status FROM core.customers WHERE id=id1)<>'unsubscribed' THEN RAISE EXCEPTION 'Optout not blocked'; END IF;
 PERFORM public.record_klaviyo_status_v1(id1,'optout-a@example.invalid','unsubscribed',v_time+interval '1 second',NULL);
 SELECT count(*) INTO v_events FROM core.consent_events WHERE customer_id=id1 AND source='klaviyo_readback';
 IF v_events<>1 THEN RAISE EXCEPTION 'Repeated read duplicated evidence'; END IF;
 r:=public.record_klaviyo_status_v1(id1,'optout-a@example.invalid','confirmed',v_time+interval '2 seconds',NULL);
 IF r->>'blocked'<>'true' OR (SELECT email_status FROM core.customers WHERE id=id1)<>'unsubscribed' THEN RAISE EXCEPTION 'Positive cleared block'; END IF;
 PERFORM public.record_klaviyo_status_v1(id1,'optout-a@example.invalid','not_on_list',v_time+interval '3 seconds',NULL);
 IF (SELECT email_suppressed_at FROM core.customers WHERE id=id1) IS DISTINCT FROM v_time THEN RAISE EXCEPTION 'Block time changed'; END IF;
 -- New form consent requests must not resurrect an unsubscribe.
 PERFORM public.submit_signup_once('5dfcb235-2dfb-4fcf-9e84-cda03c9b7252',
  'a358eba4-b197-4309-805b-46f43a718454','INTERNAL TEST optout rollback A','optout-a@example.invalid','',
  'website_vip_page',true,false,'{}'::jsonb,'{}'::jsonb);
 IF (SELECT email_status FROM core.customers WHERE id=id1)<>'unsubscribed' THEN RAISE EXCEPTION 'Signup cleared optout'; END IF;
 -- Missing membership grants neither opt-in nor opt-out.
 r:=public.record_klaviyo_status_v1(id2,'optout-b@example.invalid','not_on_list',v_time,NULL);
 IF r->>'blocked'<>'false' OR (SELECT email_status FROM core.customers WHERE id=id2)<>'pending_review' THEN RAISE EXCEPTION 'Missing profile inferred consent'; END IF;
 PERFORM public.record_klaviyo_status_v1(id2,'optout-b@example.invalid','confirmed',v_time+interval '3 seconds',NULL);
 r:=public.record_klaviyo_status_v1(id2,'optout-b@example.invalid','suppressed',v_time+interval '1 second',NULL);
 IF r->>'blocked'<>'true' OR r->>'status'<>'confirmed' OR (SELECT email_status FROM core.customers WHERE id=id2)<>'unsubscribed' THEN RAISE EXCEPTION 'Late negative lost'; END IF;
 BEGIN
  PERFORM public.record_klaviyo_status_v1(id1,'different@example.invalid','confirmed',v_time,NULL);
  RAISE EXCEPTION 'Mismatched email accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 BEGIN
  PERFORM public.record_klaviyo_status_v1(id1,'optout-a@example.invalid','unknown',v_time,NULL);
  RAISE EXCEPTION 'Unknown status accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 -- Authenticated but not allowlisted cannot read this evidence.
 PERFORM set_config('request.jwt.claim.sub','4a536404-5605-49e7-b5dd-b138cda02b48',true);
 BEGIN
  PERFORM public.crm_klaviyo_status_v1(id1);
  RAISE EXCEPTION 'Nonstaff read accepted';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
SELECT set_config('request.jwt.claim.sub',(SELECT auth_user_id::text FROM core.crm_staff WHERE active LIMIT 1),true);
SET LOCAL ROLE authenticated;
DO $test$ DECLARE r jsonb; BEGIN
 r:=public.crm_klaviyo_status_v1('05dc64af-2846-4540-99d1-d368026d888b');
 IF r->>'localStatus'<>'unsubscribed' OR r->'saved'->>'blocked'<>'true' THEN RAISE EXCEPTION 'Staff cannot read durable block'; END IF;
 BEGIN
  PERFORM public.record_klaviyo_status_v1('05dc64af-2846-4540-99d1-d368026d888b','optout-a@example.invalid','confirmed',clock_timestamp(),NULL);
  RAISE EXCEPTION 'Staff forged provider state';
 EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
RESET ROLE;
SELECT 'PASS: optout, suppression, dedup, no opt-in inference, late response, signup persistence, matching email, status and staff guards' AS result;
ROLLBACK;
