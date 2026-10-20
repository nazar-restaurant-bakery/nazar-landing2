-- K5 test-database acceptance only. PGOPTIONS supplies k5.test_business_id.
-- All fixtures and session claims are rolled back; no Auth/account/provider action.
-- Unmarked eligible fixtures exist only inside this isolated test transaction,
-- because the real queue correctly refuses records marked is_test=true.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='45s';
DO $gate$
DECLARE b uuid;
BEGIN
  BEGIN b:=NULLIF(current_setting('k5.test_business_id',true),'')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'K5_TEST_BUSINESS_REQUIRED';
  END;
  IF b IS NULL OR NOT EXISTS(SELECT 1 FROM core.businesses WHERE id=b) THEN
    RAISE EXCEPTION 'K5_TEST_BUSINESS_REQUIRED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='core' AND table_name='businesses' AND column_name='is_test')
    OR NOT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='core' AND table_name='customers' AND column_name='is_test') THEN
    RAISE EXCEPTION 'K5_TEST_MARKERS_REQUIRED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM core.businesses x WHERE x.id=b
       AND COALESCE((to_jsonb(x)->>'is_test')::boolean,false))
     OR EXISTS(SELECT 1 FROM core.businesses x
       WHERE NOT COALESCE((to_jsonb(x)->>'is_test')::boolean,false)) THEN
    RAISE EXCEPTION 'K5_SYNTHETIC_BUSINESS_ONLY';
  END IF;
END
$gate$;
CREATE TEMP TABLE k5_checks(name text PRIMARY KEY,passed boolean NOT NULL);
CREATE TEMP TABLE k5_missing(name text PRIMARY KEY);
DO $accept$
DECLARE
  b uuid:=current_setting('k5.test_business_id')::uuid;
  staff uuid:=(SELECT s.auth_user_id FROM core.crm_staff s
    JOIN auth.users u ON u.id=s.auth_user_id WHERE s.active ORDER BY s.auth_user_id LIMIT 1);
  eligible_id uuid:=gen_random_uuid(); test_id uuid:=gen_random_uuid();
  unsub_id uuid:=gen_random_uuid(); negative_id uuid:=gen_random_uuid(); retry_id uuid:=gen_random_uuid();
  account text:='k5_acceptance_'||replace(gen_random_uuid()::text,'-','');
  result jsonb; lease jsonb; context jsonb; denied boolean; role_name text;
  negative_email text; has_expected boolean;
BEGIN
  INSERT INTO k5_checks SELECT 'private_core_and_queue_rls',
    NOT has_schema_privilege('anon','core','USAGE')
    AND NOT has_schema_privilege('authenticated','core','USAGE')
    AND NOT has_schema_privilege('service_role','core','USAGE')
    AND (SELECT relrowsecurity FROM pg_class WHERE oid='core.klaviyo_profile_sync_jobs'::regclass);
  INSERT INTO k5_checks SELECT 'service_and_staff_function_acl',
    has_function_privilege('service_role','public.klaviyo_profile_sync_enqueue_v1(uuid,text,integer,uuid)','EXECUTE')
    AND NOT has_function_privilege('authenticated','public.klaviyo_profile_sync_enqueue_v1(uuid,text,integer,uuid)','EXECUTE')
    AND NOT has_function_privilege('anon','public.klaviyo_profile_sync_enqueue_v1(uuid,text,integer,uuid)','EXECUTE')
    AND has_function_privilege('authenticated','public.crm_profile_sync_queue_v1(uuid)','EXECUTE')
    AND NOT has_function_privilege('service_role','public.crm_profile_sync_queue_v1(uuid)','EXECUTE')
    AND NOT has_function_privilege('anon','public.crm_profile_sync_queue_v1(uuid)','EXECUTE');

  INSERT INTO core.customers(id,business_id,identity_key,name,email,email_status,email_suppressed_at,is_test)
  SELECT x.id,b,'email:k5.'||x.id::text||'@fixture.test','Synthetic K5 database fixture',
    'k5.'||x.id::text||'@fixture.test',x.status,
    CASE WHEN x.status='unsubscribed' THEN clock_timestamp()-interval '1 day' ELSE NULL END,x.marked
  FROM (VALUES(eligible_id,'subscribed',false),(test_id,'subscribed',true),
    (unsub_id,'unsubscribed',false),(negative_id,'subscribed',false),(retry_id,'subscribed',false)) AS x(id,status,marked);
  INSERT INTO core.signups(business_id,customer_id,source,fingerprint,utm,is_test)
    VALUES(b,eligible_id,'website_vip_page','k5:'||eligible_id::text,
      '{"utm_source":"synthetic_k5_acceptance"}'::jsonb,false);
  SELECT email INTO negative_email FROM core.customers WHERE id=negative_id;

  denied:=false;
  BEGIN UPDATE core.customers SET email_status='subscribed',email_suppressed_at=NULL WHERE id=unsub_id;
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  INSERT INTO k5_checks VALUES('k4_direct_unsuppress_still_denied',denied);

  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    PERFORM set_config('request.jwt.claim.role',role_name,true);
    EXECUTE 'SET LOCAL ROLE '||quote_ident(role_name);
    denied:=false;
    BEGIN PERFORM 1 FROM core.klaviyo_profile_sync_jobs LIMIT 1;
    EXCEPTION WHEN insufficient_privilege THEN denied:=true;
    END;
    EXECUTE 'RESET ROLE';
    INSERT INTO k5_checks VALUES('direct_queue_read_denied_'||role_name,denied);
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    PERFORM set_config('request.jwt.claim.role',role_name,true);
    EXECUTE 'SET LOCAL ROLE '||quote_ident(role_name);
    denied:=false;
    BEGIN PERFORM public.klaviyo_profile_sync_enqueue_v1(b,account,100,eligible_id);
    EXCEPTION WHEN insufficient_privilege THEN denied:=true;
    END;
    EXECUTE 'RESET ROLE';
    INSERT INTO k5_checks VALUES('service_enqueue_denied_'||role_name,denied);
  END LOOP;

  PERFORM set_config('request.jwt.claim.role','service_role',true);
  EXECUTE 'SET LOCAL ROLE service_role';
  result:=public.klaviyo_profile_sync_enqueue_v1(b,account,100,eligible_id);
  EXECUTE 'RESET ROLE';
  INSERT INTO k5_checks VALUES('eligible_exact_customer_queued_once',result->>'enqueued'='1');
  EXECUTE 'SET LOCAL ROLE service_role';
  result:=public.klaviyo_profile_sync_enqueue_v1(b,account,100,eligible_id);
  lease:=public.klaviyo_profile_sync_claim_v1(b,account,eligible_id);
  context:=public.klaviyo_profile_sync_context_v1((lease->>'jobId')::uuid,(lease->>'leaseId')::uuid);
  EXECUTE 'RESET ROLE';
  INSERT INTO k5_checks VALUES('queue_idempotency_lease_and_current_context',
    result->>'enqueued'='0' AND result->>'unchanged'='1'
    AND lease->>'attempt'='1' AND context->>'eligible'='true'
    AND (context->>'customerId')::uuid=eligible_id
    AND context#>>'{eligibility,emailStatus}'='subscribed'
    AND context#>>'{eligibility,isTest}'='false'
    AND context#>>'{profile,source}'='website_vip_page'
    AND context#>>'{profile,utm,utm_source}'='synthetic_k5_acceptance');
  EXECUTE 'SET LOCAL ROLE service_role';
  result:=public.klaviyo_profile_sync_finish_v1((lease->>'jobId')::uuid,(lease->>'leaseId')::uuid,'{"status":"succeeded"}'::jsonb);
  context:=public.klaviyo_profile_sync_claim_v1(b,account,eligible_id);
  EXECUTE 'RESET ROLE';
  INSERT INTO k5_checks VALUES('success_no_second_claim_or_positive_consent_event',
    result->>'status'='succeeded' AND context IS NULL
    AND (SELECT count(*)=1 FROM core.klaviyo_profile_sync_jobs WHERE business_id=b AND customer_id=eligible_id AND provider_account=account)
    AND NOT EXISTS(SELECT 1 FROM core.consent_events WHERE customer_id=eligible_id));
  EXECUTE 'SET LOCAL ROLE service_role';
  denied:=false;
  BEGIN PERFORM public.klaviyo_profile_sync_finish_v1((lease->>'jobId')::uuid,(lease->>'leaseId')::uuid,'{"status":"succeeded"}'::jsonb);
  EXCEPTION WHEN invalid_parameter_value THEN denied:=true;
  END;
  EXECUTE 'RESET ROLE';
  INSERT INTO k5_checks VALUES('stale_completion_denied',denied);

  EXECUTE 'SET LOCAL ROLE service_role';
  result:=public.klaviyo_profile_sync_enqueue_v1(b,account,100,test_id);
  context:=public.klaviyo_profile_sync_enqueue_v1(b,account,100,unsub_id);
  EXECUTE 'RESET ROLE';
  INSERT INTO k5_checks VALUES('test_and_unsubscribed_never_queued',
    result->>'enqueued'='0' AND context->>'enqueued'='0'
    AND NOT EXISTS(SELECT 1 FROM core.klaviyo_profile_sync_jobs WHERE customer_id IN (test_id,unsub_id)));

  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.klaviyo_profile_sync_enqueue_v1(b,account,100,negative_id);
  lease:=public.klaviyo_profile_sync_claim_v1(b,account,negative_id);
  result:=public.klaviyo_profile_sync_finish_v1((lease->>'jobId')::uuid,(lease->>'leaseId')::uuid,
    '{"status":"provider_blocked","providerStatus":"unsubscribed"}'::jsonb);
  EXECUTE 'RESET ROLE';
  INSERT INTO k5_checks VALUES('negative_outcome_uses_existing_readback_and_k4',
    result->>'status'='blocked'
    AND EXISTS(SELECT 1 FROM core.customers WHERE id=negative_id AND email_status='unsubscribed' AND email_suppressed_at IS NOT NULL)
    AND EXISTS(SELECT 1 FROM core.klaviyo_email_observations WHERE customer_id=negative_id AND blocked_status='unsubscribed')
    AND EXISTS(SELECT 1 FROM core.consent_events WHERE customer_id=negative_id AND event_type='suppression' AND source='klaviyo_readback'));

  EXECUTE 'SET LOCAL ROLE service_role';
  PERFORM public.klaviyo_profile_sync_enqueue_v1(b,account,100,retry_id);
  lease:=public.klaviyo_profile_sync_claim_v1(b,account,retry_id);
  denied:=false;
  BEGIN PERFORM public.klaviyo_profile_sync_finish_v1((lease->>'jobId')::uuid,(lease->>'leaseId')::uuid,
    '{"status":"retry","errorCode":"PRIVATE_RAW_NOT_ALLOWED"}'::jsonb);
  EXCEPTION WHEN invalid_parameter_value THEN denied:=true;
  END;
  result:=public.klaviyo_profile_sync_finish_v1((lease->>'jobId')::uuid,(lease->>'leaseId')::uuid,
    '{"status":"retry","errorCode":"provider_rate_limited","retryAfterSeconds":60}'::jsonb);
  EXECUTE 'RESET ROLE';
  INSERT INTO k5_checks VALUES('safe_retry_metadata_no_raw_provider_error',denied
    AND result->>'status'='retry' AND result->>'lastErrorCode'='provider_rate_limited'
    AND EXISTS(SELECT 1 FROM core.klaviyo_profile_sync_jobs WHERE customer_id=retry_id
      AND attempts=1 AND last_error_code='provider_rate_limited'
      AND next_attempt_at>clock_timestamp()+interval '50 seconds'));

  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  denied:=false;
  BEGIN PERFORM public.crm_profile_sync_queue_v1(b);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;
  END;
  EXECUTE 'RESET ROLE';
  INSERT INTO k5_checks VALUES('authenticated_nonstaff_queue_denied',denied);
  IF staff IS NULL THEN
    INSERT INTO k5_missing VALUES('existing_active_staff');
    INSERT INTO k5_checks VALUES('existing_staff_reads_sanitized_queue',false);
  ELSE
    PERFORM set_config('request.jwt.claim.sub',staff::text,true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    result:=public.crm_profile_sync_queue_v1(b);
    EXECUTE 'RESET ROLE';
    SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') e
      WHERE (e->>'customerId')::uuid=retry_id AND e->>'status'='retry'
        AND e->>'lastErrorCode'='provider_rate_limited') INTO has_expected;
    INSERT INTO k5_checks VALUES('existing_staff_reads_sanitized_queue',has_expected
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') e
        WHERE e ? 'email' OR e ? 'name' OR e ? 'body' OR e ? 'providerResponse'));
  END IF;
END
$accept$;
SELECT jsonb_build_object('scope','K5_SYNTHETIC_ROLLBACK_DB_ACCEPTANCE',
  'passed',count(*) FILTER(WHERE passed),'failed',count(*) FILTER(WHERE NOT passed),
  'checks',jsonb_agg(jsonb_build_object('name',name,'passed',passed) ORDER BY name),
  'missing',(SELECT COALESCE(jsonb_agg(name ORDER BY name),'[]'::jsonb) FROM k5_missing),
  'provider_calls',0,'account_operations',0,'auth_http_claimed',false,'fixtures_rolled_back',true) AS acceptance
FROM k5_checks;
ROLLBACK;
