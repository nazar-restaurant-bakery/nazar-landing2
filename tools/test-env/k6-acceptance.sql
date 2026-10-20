-- K6 isolated TEST-only rollback acceptance. No Auth/account/provider/send action.
-- k6.test_business_id must select an already marked synthetic business.
-- Positive eligibility fixtures are unmarked only within this rolled-back local
-- transaction, since the actual gate correctly refuses is_test=true customers.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='45s';
DO $gate$
DECLARE b uuid;
BEGIN
  BEGIN b:=NULLIF(current_setting('k6.test_business_id',true),'')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'K6_TEST_BUSINESS_REQUIRED'; END;
  IF b IS NULL OR NOT EXISTS(SELECT 1 FROM core.businesses x WHERE x.id=b
      AND COALESCE((to_jsonb(x)->>'is_test')::boolean,false))
    OR EXISTS(SELECT 1 FROM core.businesses x WHERE NOT COALESCE((to_jsonb(x)->>'is_test')::boolean,false))
    OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='core'
      AND table_name='customers' AND column_name='is_test') THEN
    RAISE EXCEPTION 'K6_SYNTHETIC_TEST_BUSINESS_ONLY'; END IF;
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'K6_READ_COMMITTED_REQUIRED'; END IF;
END $gate$;
CREATE TEMP TABLE k6_checks(name text PRIMARY KEY,passed boolean NOT NULL);
CREATE TEMP TABLE k6_missing(name text PRIMARY KEY);
DO $accept$
DECLARE b uuid:=current_setting('k6.test_business_id')::uuid;
  a uuid:=gen_random_uuid(); w167 uuid:=gen_random_uuid(); w169 uuid:=gen_random_uuid();
  marked uuid:=gen_random_uuid(); unsub uuid:=gen_random_uuid(); neg uuid:=gen_random_uuid();
  changed uuid:=gen_random_uuid(); late uuid:=gen_random_uuid(); disabled uuid:=gen_random_uuid();
  future_claim uuid:=gen_random_uuid(); pending uuid:=gen_random_uuid();
  key_prefix text:='k6_'||replace(gen_random_uuid()::text,'-','');
  r jsonb; q jsonb; ctx jsonb; f jsonb; role_name text; denied boolean; fn text;
  before_consents bigint; stamp timestamptz:=clock_timestamp();
BEGIN
  SELECT count(*) INTO before_consents FROM core.consent_events;
  INSERT INTO k6_checks SELECT 'private_core_and_new_table_rls',
    NOT has_schema_privilege('anon','core','USAGE') AND NOT has_schema_privilege('authenticated','core','USAGE')
    AND NOT has_schema_privilege('service_role','core','USAGE')
    AND (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN('core.message_log'::regclass,'core.message_send_settings'::regclass));
  INSERT INTO k6_checks SELECT 'service_only_four_rpc_acl',bool_and(
    has_function_privilege('service_role',p.oid,'EXECUTE')
    AND NOT has_function_privilege('anon',p.oid,'EXECUTE')
    AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE'))
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN('message_send_reserve_v1','message_send_claim_v1','message_send_context_v1','message_send_finalize_v1');
  INSERT INTO k6_checks SELECT 'immutable_log_trigger_always',EXISTS(SELECT 1 FROM pg_trigger
    WHERE tgrelid='core.message_log'::regclass AND tgname='message_log_immutable' AND tgenabled='A');
  INSERT INTO core.customers(id,business_id,identity_key,name,email,email_status,email_suppressed_at,is_test)
  SELECT x.id,b,'email:k6.'||x.id::text||'@fixture.test','Synthetic send gate fixture',
    'k6.'||x.id::text||'@fixture.test',x.status,
    CASE WHEN x.status='unsubscribed' THEN stamp-interval '1 day' ELSE NULL END,x.marked
  FROM (VALUES(a,'subscribed',false),(w167,'subscribed',false),(w169,'subscribed',false),
    (marked,'subscribed',true),(unsub,'unsubscribed',false),(neg,'subscribed',false),
    (changed,'subscribed',false),(late,'subscribed',false),(disabled,'subscribed',false),
    (future_claim,'subscribed',false),(pending,'pending_review',false)) x(id,status,marked);
  INSERT INTO core.klaviyo_email_observations(customer_id,status,checked_at,blocked_status,blocked_at)
    VALUES(neg,'unsubscribed',stamp,'unsubscribed',stamp);
  DELETE FROM core.message_send_settings WHERE business_id=b;
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  r:=public.message_send_reserve_v1(b,a,key_prefix||'_missing','campaign',repeat('a',64));
  INSERT INTO k6_checks VALUES('missing_tenant_setting_denies',NOT (r->>'allowed')::boolean AND r->>'code'='settings_disabled');
  INSERT INTO core.message_send_settings(business_id) VALUES(b);
  INSERT INTO k6_checks SELECT 'default_window_168_and_disabled',min_interval_hours=168 AND NOT enabled FROM core.message_send_settings WHERE business_id=b;
  r:=public.message_send_reserve_v1(b,a,key_prefix||'_disabled','campaign',repeat('a',64));
  INSERT INTO k6_checks VALUES('disabled_tenant_denies',NOT (r->>'allowed')::boolean);
  UPDATE core.message_send_settings SET enabled=true WHERE business_id=b;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    EXECUTE 'SET LOCAL ROLE '||quote_ident(role_name); denied:=false;
    BEGIN PERFORM 1 FROM core.message_log LIMIT 1; EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
    EXECUTE 'RESET ROLE'; INSERT INTO k6_checks VALUES('direct_message_log_denied_'||role_name,denied);
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    PERFORM set_config('request.jwt.claim.role',role_name,true);EXECUTE 'SET LOCAL ROLE '||quote_ident(role_name);denied:=false;
    BEGIN PERFORM public.message_send_reserve_v1(b,a,key_prefix||'_unauth','campaign',repeat('a',64));
    EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
    EXECUTE 'RESET ROLE';INSERT INTO k6_checks VALUES('reserve_denied_'||role_name,denied);
  END LOOP;
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  r:=public.message_send_reserve_v1(b,marked,key_prefix||'_marked','flow',repeat('a',64));
  INSERT INTO k6_checks VALUES('test_customer_denied',NOT (r->>'allowed')::boolean AND r->>'code'='customer_ineligible');
  r:=public.message_send_reserve_v1(b,unsub,key_prefix||'_unsub','campaign',repeat('a',64));
  INSERT INTO k6_checks VALUES('unsubscribed_customer_denied',NOT (r->>'allowed')::boolean AND r->>'code'='customer_ineligible');
  r:=public.message_send_reserve_v1(b,neg,key_prefix||'_negative','flow',repeat('a',64));
  INSERT INTO k6_checks VALUES('known_provider_negative_denied',NOT (r->>'allowed')::boolean AND r->>'code'='customer_ineligible');
  r:=public.message_send_reserve_v1(b,pending,key_prefix||'_pending','campaign',repeat('a',64));
  INSERT INTO k6_checks VALUES('pending_consent_denied',NOT (r->>'allowed')::boolean);

  INSERT INTO core.message_log(business_id,customer_id,message_key,message_kind,payload_sha256,recipient_sha256,identity_sha256,status,lease_id,
    reserved_at,reservation_expires_at,claimed_at,dispatch_expires_at,dispatch_authorized_at,sent_at,finished_at)
  SELECT b,c.id,key_prefix||'_history_'||x.hours,'campaign',repeat('a',64),encode(sha256(convert_to(lower(c.email),'UTF8')),'hex'),
    encode(sha256(convert_to(c.identity_key,'UTF8')),'hex'),'sent',gen_random_uuid(),
    stamp-make_interval(hours=>x.hours)-interval '10 seconds',stamp-make_interval(hours=>x.hours)+interval '5 minutes',
    stamp-make_interval(hours=>x.hours)-interval '2 seconds',stamp-make_interval(hours=>x.hours)+interval '2 minutes',
    stamp-make_interval(hours=>x.hours)-interval '1 second',stamp-make_interval(hours=>x.hours),stamp-make_interval(hours=>x.hours)
  FROM (VALUES(w167,167),(w169,169)) x(id,hours) JOIN core.customers c ON c.id=x.id;
  r:=public.message_send_reserve_v1(b,w167,key_prefix||'_167','flow',repeat('a',64));
  INSERT INTO k6_checks VALUES('rolling_167_hours_denied_across_campaign_flow',NOT (r->>'allowed')::boolean AND r->>'code'='frequency_limited');
  r:=public.message_send_reserve_v1(b,w169,key_prefix||'_169','flow',repeat('a',64));
  INSERT INTO k6_checks VALUES('rolling_169_hours_allowed',(r->>'allowed')::boolean AND r->>'status'='reserved');
  r:=public.message_send_reserve_v1(b,a,key_prefix||'_main','campaign',repeat('a',64));
  q:=public.message_send_reserve_v1(b,a,key_prefix||'_main','campaign',repeat('a',64));
  INSERT INTO k6_checks VALUES('unchanged_reservation_idempotent',(q->>'allowed')::boolean AND (q->>'idempotent')::boolean AND r->>'reservationId'=q->>'reservationId');
  q:=public.message_send_reserve_v1(b,a,key_prefix||'_flow','flow',repeat('b',64));
  INSERT INTO k6_checks VALUES('all_message_types_share_one_quota',NOT (q->>'allowed')::boolean AND q->>'code'='frequency_limited');
  q:=public.message_send_reserve_v1(b,a,key_prefix||'_main','campaign',repeat('b',64));
  INSERT INTO k6_checks VALUES('idempotency_payload_conflict_denied',NOT (q->>'allowed')::boolean AND q->>'code'='idempotency_conflict');
  q:=public.message_send_claim_v1((r->>'reservationId')::uuid);
  INSERT INTO k6_checks VALUES('first_claim_granted',(q->>'allowed')::boolean AND q->>'status'='claimed');
  ctx:=public.message_send_claim_v1((r->>'reservationId')::uuid);
  INSERT INTO k6_checks VALUES('second_claim_never_granted',NOT (ctx->>'allowed')::boolean AND ctx->>'code'='not_claimable');
  ctx:=public.message_send_context_v1((r->>'reservationId')::uuid,(q->>'leaseId')::uuid);
  INSERT INTO k6_checks VALUES('consuming_dispatch_context_granted',(ctx->>'allowed')::boolean AND ctx->>'status'='sending'
    AND ctx->'context'->>'emailStatus'='subscribed' AND ctx->'context'->>'isTest'='false');
  ctx:=public.message_send_context_v1((r->>'reservationId')::uuid,(q->>'leaseId')::uuid);
  INSERT INTO k6_checks VALUES('consuming_context_cannot_be_replayed',NOT (ctx->>'allowed')::boolean AND ctx->>'code'='already_dispatched');
  f:=public.message_send_finalize_v1((r->>'reservationId')::uuid,(q->>'leaseId')::uuid,'sent');
  INSERT INTO k6_checks VALUES('synthetic_accepted_receipt_logged',f->>'status'='sent' AND NOT (f->>'idempotent')::boolean);
  f:=public.message_send_finalize_v1((r->>'reservationId')::uuid,(q->>'leaseId')::uuid,'unknown');
  INSERT INTO k6_checks VALUES('sent_finalize_lost_ack_repeat_is_stable',f->>'status'='sent' AND (f->>'idempotent')::boolean);
  q:=public.message_send_reserve_v1(b,a,key_prefix||'_main','campaign',repeat('a',64));
  INSERT INTO k6_checks VALUES('completed_message_key_cannot_resend',NOT (q->>'allowed')::boolean AND q->>'code'='already_processed');

  r:=public.message_send_reserve_v1(b,changed,key_prefix||'_changed','campaign',repeat('a',64));
  q:=public.message_send_claim_v1((r->>'reservationId')::uuid);
  UPDATE core.customers SET email='k6.changed.'||changed::text||'@fixture.test' WHERE id=changed;
  ctx:=public.message_send_context_v1((r->>'reservationId')::uuid,(q->>'leaseId')::uuid);
  INSERT INTO k6_checks VALUES('email_change_before_dispatch_denied',NOT (ctx->>'allowed')::boolean AND ctx->>'code'='identity_changed' AND ctx->>'status'='blocked');
  r:=public.message_send_reserve_v1(b,late,key_prefix||'_late','flow',repeat('a',64));
  q:=public.message_send_claim_v1((r->>'reservationId')::uuid);
  UPDATE core.customers SET email_status='unsubscribed',email_suppressed_at=clock_timestamp() WHERE id=late;
  ctx:=public.message_send_context_v1((r->>'reservationId')::uuid,(q->>'leaseId')::uuid);
  INSERT INTO k6_checks VALUES('last_moment_suppression_denied',NOT (ctx->>'allowed')::boolean AND ctx->>'code'='customer_ineligible' AND ctx->>'status'='blocked');
  denied:=false;BEGIN UPDATE core.customers SET email_status='subscribed',email_suppressed_at=NULL WHERE id=unsub;
  EXCEPTION WHEN insufficient_privilege THEN denied:=true;END;
  INSERT INTO k6_checks VALUES('k4_suppression_guard_preserved',denied);
  r:=public.message_send_reserve_v1(b,disabled,key_prefix||'_unknown','campaign',repeat('a',64));
  q:=public.message_send_claim_v1((r->>'reservationId')::uuid);
  f:=public.message_send_finalize_v1((r->>'reservationId')::uuid,(q->>'leaseId')::uuid,'unknown');
  r:=public.message_send_reserve_v1(b,disabled,key_prefix||'_unknown_flow','flow',repeat('a',64));
  INSERT INTO k6_checks VALUES('uncertain_ack_holds_shared_quota',f->>'status'='unknown' AND NOT (r->>'allowed')::boolean AND r->>'code'='frequency_limited');
  INSERT INTO k6_checks SELECT 'no_consent_created',count(*)=before_consents FROM core.consent_events;
  INSERT INTO k6_checks SELECT 'log_metadata_contains_no_email',NOT EXISTS(SELECT 1 FROM core.message_log WHERE message_key LIKE key_prefix||'%' AND to_jsonb(message_log)::text LIKE '%@fixture.test%');
END $accept$;
SELECT jsonb_build_object('scope','K6_SYNTHETIC_ROLLBACK_DB_ACCEPTANCE',
  'passed',count(*) FILTER(WHERE passed),'failed',count(*) FILTER(WHERE NOT passed),
  'checks',jsonb_agg(jsonb_build_object('name',name,'passed',passed) ORDER BY name),
  'missing',(SELECT coalesce(jsonb_agg(name),'[]') FROM k6_missing),
  'provider_calls',0,'real_sends',0,'account_operations',0,'auth_http_claimed',false,'fixtures_rolled_back',true) AS acceptance FROM k6_checks;
ROLLBACK;
