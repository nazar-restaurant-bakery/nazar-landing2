-- Run in Nazar-production SQL editor. No email API is called. All writes roll back.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';
DO $test$
DECLARE a uuid := 'c338ef23-6b59-4f7c-b045-dce578ea5001';
 b uuid := 'c338ef23-6b59-4f7c-b045-dce578ea5002';
 c uuid := 'c338ef23-6b59-4f7c-b045-dce578ea5003';
 r uuid := 'c338ef23-6b59-4f7c-b045-dce578ea5091';
 accepted_request uuid;
BEGIN
 IF (SELECT declared_project_ref FROM core.installation LIMIT 1) <> 'khgczybubufouraqyrcj' THEN RAISE EXCEPTION 'Wrong project'; END IF;
 IF has_table_privilege('authenticated','core.form_errors','SELECT') OR has_table_privilege('anon','core.form_errors','SELECT') THEN RAISE EXCEPTION 'Direct table access'; END IF;
 IF has_function_privilege('anon','public.crm_form_errors_v1()','EXECUTE') OR has_function_privilege('authenticated','public.record_form_error_v1(uuid,uuid,text,text,text,integer,boolean)','EXECUTE') THEN RAISE EXCEPTION 'Wrong execute privilege'; END IF;
 IF NOT has_function_privilege('service_role','public.record_form_error_v1(uuid,uuid,text,text,text,integer,boolean)','EXECUTE') THEN RAISE EXCEPTION 'Missing server privilege'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='core.form_errors'::regclass) THEN RAISE EXCEPTION 'RLS off'; END IF;
 UPDATE core.form_error_alert_gate SET last_attempt_at='-infinity' WHERE singleton;
 IF NOT public.record_form_error_v1(a,r,'catering','database','database_unavailable',503,true) THEN RAISE EXCEPTION 'First alert not claimed'; END IF;
 IF public.record_form_error_v1(a,r,'catering','database','database_unavailable',503,true) THEN RAISE EXCEPTION 'Duplicate claimed'; END IF;
 IF public.record_form_error_v1(b,NULL,'vip','challenge','challenge_unavailable',503,true) THEN RAISE EXCEPTION 'Gate did not suppress'; END IF;
 PERFORM public.finish_form_error_alert_v1(a,true);
 PERFORM public.finish_form_error_alert_v1(a,false);
 IF (SELECT alert_status FROM core.form_errors WHERE id=a) <> 'accepted' THEN RAISE EXCEPTION 'Finish not idempotent'; END IF;
 IF (SELECT alert_status FROM core.form_errors WHERE id=b) <> 'suppressed' THEN RAISE EXCEPTION 'Suppressed metadata missing'; END IF;
 PERFORM public.resolve_form_errors_v1(r);
 IF (SELECT resolved_at FROM core.form_errors WHERE id=a) IS NULL OR (SELECT resolved_at FROM core.form_errors WHERE id=b) IS NOT NULL THEN RAISE EXCEPTION 'Resolution crossed request'; END IF;
 SELECT request_id INTO accepted_request FROM core.signup_request_keys LIMIT 1;
 IF accepted_request IS NULL THEN RAISE EXCEPTION 'No existing accepted receipt for late-log check'; END IF;
 IF public.record_form_error_v1(c,accepted_request,'vip','database','upstream_timeout',503,true) THEN RAISE EXCEPTION 'Late logger claimed an alert'; END IF;
 IF (SELECT resolved_at FROM core.form_errors WHERE id=c) IS NULL THEN RAISE EXCEPTION 'Late logger reopened accepted request'; END IF;
 BEGIN
  PERFORM public.record_form_error_v1(gen_random_uuid(),NULL,'vip','database','raw_secret_not_allowed',503,false);
  RAISE EXCEPTION 'Unsafe error code accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $test$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000999","role":"authenticated"}',true);
DO $test$ BEGIN
 BEGIN PERFORM public.crm_form_errors_v1(); RAISE EXCEPTION 'Nonstaff read allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
 BEGIN PERFORM public.crm_resolve_form_error_v1('c338ef23-6b59-4f7c-b045-dce578ea5002'); RAISE EXCEPTION 'Nonstaff resolution allowed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $test$;
RESET ROLE;
SELECT set_config('request.jwt.claims',jsonb_build_object('sub',(SELECT auth_user_id FROM core.crm_staff WHERE active LIMIT 1),'role','authenticated')::text,true);
SET LOCAL ROLE authenticated;
DO $test$ DECLARE result jsonb; BEGIN
 result := public.crm_form_errors_v1();
 IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(result->'items') x WHERE x->>'id'='c338ef23-6b59-4f7c-b045-dce578ea5002') THEN RAISE EXCEPTION 'Staff record missing'; END IF;
 IF NOT public.crm_resolve_form_error_v1('c338ef23-6b59-4f7c-b045-dce578ea5002') THEN RAISE EXCEPTION 'Staff resolve failed'; END IF;
 IF public.crm_resolve_form_error_v1('c338ef23-6b59-4f7c-b045-dce578ea5002') THEN RAISE EXCEPTION 'Resolution not idempotent'; END IF;
END $test$;
RESET ROLE;
ROLLBACK;
