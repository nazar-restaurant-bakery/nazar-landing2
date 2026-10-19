-- Synthetic sandbox only. No Auth/account creation; existing test staff is reused.
-- JWT claims below exercise database authorization, not an HTTP login proof.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $gate$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='core' AND table_name='businesses' AND column_name='is_test') THEN
    RAISE EXCEPTION 'K4_TEST_MARKERS_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.businesses)
     OR EXISTS (SELECT 1 FROM core.businesses b WHERE NOT coalesce((to_jsonb(b)->>'is_test')::boolean,false)) THEN
    RAISE EXCEPTION 'K4_SYNTHETIC_BUSINESS_ONLY';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff s JOIN auth.users u ON u.id=s.auth_user_id WHERE s.active) THEN
    RAISE EXCEPTION 'K4_EXISTING_TEST_STAFF_REQUIRED';
  END IF;
END $gate$;
CREATE TEMP TABLE k4_checks(name text PRIMARY KEY, passed boolean NOT NULL);
DO $test$
DECLARE
  b uuid := (SELECT id FROM core.businesses ORDER BY id LIMIT 1);
  staff uuid := (SELECT auth_user_id FROM core.crm_staff WHERE active ORDER BY auth_user_id LIMIT 1);
  blocked uuid := gen_random_uuid();
  identity_id uuid := gen_random_uuid();
  event_id uuid;
  failed boolean;
  suppressed timestamptz := clock_timestamp()-interval '2 days';
  requested timestamptz := clock_timestamp()-interval '1 day';
  email text := 'k4.'||gen_random_uuid()::text||'@example.invalid';
  q text;
  n integer;
  status text;
BEGIN
  INSERT INTO core.customers(id,business_id,identity_key,name,email,email_status,email_suppressed_at,is_test)
  VALUES(blocked,b,'email:'||email,'INTERNAL TEST K4 suppression',email,'unsubscribed',suppressed,true);

  FOREACH q IN ARRAY ARRAY[
    format('UPDATE core.customers SET email_status=''subscribed'',email_suppressed_at=NULL WHERE id=%L',blocked),
    format('UPDATE core.customers SET email_status=''pending_review'',email_suppressed_at=NULL WHERE id=%L',blocked),
    format('UPDATE core.customers SET email_status=''not_subscribed'',email_suppressed_at=NULL WHERE id=%L',blocked),
    format('UPDATE core.customers SET email_suppressed_at=NULL WHERE id=%L',blocked),
    format('UPDATE core.customers SET email_suppressed_at=email_suppressed_at-interval ''1 second'' WHERE id=%L',blocked)
  ] LOOP
    failed := false;
    BEGIN EXECUTE q; EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
    IF NOT failed THEN RAISE EXCEPTION 'K4_DIRECT_CHANGE_WAS_ACCEPTED'; END IF;
  END LOOP;
  INSERT INTO k4_checks VALUES('direct_update_and_indirect_timestamp_bypasses_rejected',true);
  PERFORM set_config('app.allow_resubscribe','true',true);
  failed:=false;
  BEGIN UPDATE core.customers SET email_status='subscribed',email_suppressed_at=NULL WHERE id=blocked;
  EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'K4_GUC_BYPASS'; END IF;
  INSERT INTO k4_checks VALUES('caller_guc_is_not_authority',true);

  PERFORM public.submit_signup_once(gen_random_uuid(),b,'INTERNAL TEST K4 request',email,NULL,'website_vip_page',true,false,'{}',NULL);
  IF (SELECT email_status FROM core.customers WHERE id=blocked)<>'unsubscribed' THEN RAISE EXCEPTION 'K4_FORM_UNBLOCKED'; END IF;
  INSERT INTO k4_checks VALUES('actual_vip_form_cannot_lift_suppression',true);
  -- Repeated suppression remains permitted and establishes the latest boundary.
  PERFORM core.suppress_email(email,'INTERNAL TEST K4 repeated suppression');
  SELECT email_suppressed_at INTO suppressed FROM core.customers WHERE id=blocked;
  INSERT INTO k4_checks VALUES('repeat_suppression_preserved',true);
  INSERT INTO core.klaviyo_email_observations(customer_id,status,checked_at,blocked_status,blocked_at)
  VALUES(blocked,'suppressed',clock_timestamp(),'suppressed',suppressed);

  PERFORM set_config('request.jwt.claim.sub',staff::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  FOREACH q IN ARRAY ARRAY[
    format('SELECT public.crm_restore_email_consent_v1(%L,%L,''customer_email'',''synthetic://k4/stale'',%L,true,true)',blocked,suppressed-interval '1 second',repeat('a',64)),
    format('SELECT public.crm_restore_email_consent_v1(%L,%L,''customer_email'',''synthetic://k4/future'',%L,true,true)',blocked,clock_timestamp()+interval '1 day',repeat('a',64)),
    format('SELECT public.crm_restore_email_consent_v1(%L,''infinity'',''customer_email'',''synthetic://k4/infinite'',%L,true,true)',blocked,repeat('a',64)),
    format('SELECT public.crm_restore_email_consent_v1(%L,%L,''provider_import'',''synthetic://k4/import'',%L,true,true)',blocked,clock_timestamp(),repeat('a',64)),
    format('SELECT public.crm_restore_email_consent_v1(%L,%L,''customer_email'','' '',%L,true,true)',blocked,clock_timestamp(),repeat('a',64)),
    format('SELECT public.crm_restore_email_consent_v1(%L,%L,''customer_email'',''synthetic://k4/no-approval'',%L,true,false)',blocked,clock_timestamp(),repeat('a',64)),
    format('SELECT public.crm_restore_email_consent_v1(%L,%L,''customer_email'',''synthetic://k4/not-self'',%L,false,true)',blocked,clock_timestamp(),repeat('a',64))
    ,format('SELECT public.crm_restore_email_consent_v1(%L,NULL,''customer_email'',''synthetic://k4/null-date'',%L,true,true)',blocked,repeat('a',64))
    ,format('SELECT public.crm_restore_email_consent_v1(%L,%L,''customer_email'',''synthetic://k4/bad-hash'',''not-a-hash'',true,true)',blocked,clock_timestamp())
    ,format('SELECT public.crm_restore_email_consent_v1(%L,%L,''customer_email'',%L,%L,true,true)',blocked,clock_timestamp(),chr(9)||chr(10),repeat('a',64))
  ] LOOP
    failed:=false;
    BEGIN EXECUTE q; EXCEPTION WHEN invalid_parameter_value THEN failed:=true; END;
    IF NOT failed THEN RAISE EXCEPTION 'K4_INVALID_EVIDENCE_ACCEPTED'; END IF;
  END LOOP;
  INSERT INTO k4_checks VALUES('dated_self_evidence_and_staff_approval_required',true);

  PERFORM set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  failed:=false;
  BEGIN PERFORM public.list_offers(b); EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'K4_NONSTAFF_OFFERS_ALLOWED'; END IF;
  failed:=false;
  BEGIN PERFORM public.crm_restore_email_consent_v1(blocked,clock_timestamp(),'customer_email','synthetic://k4/nonstaff',repeat('a',64),true,true);
  EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'K4_NONSTAFF_CONSENT_ALLOWED'; END IF;
  EXECUTE 'RESET ROLE';
  INSERT INTO k4_checks VALUES('authenticated_nonstaff_denied',true);
  FOREACH q IN ARRAY ARRAY['anon','service_role'] LOOP
    EXECUTE 'SET LOCAL ROLE '||quote_ident(q);
    failed:=false;
    BEGIN PERFORM public.list_offers(b); EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
    IF NOT failed THEN RAISE EXCEPTION 'K4_NONSTAFF_ROLE_ALLOWED'; END IF;
    failed:=false;
    BEGIN PERFORM public.crm_restore_email_consent_v1(blocked,clock_timestamp(),'customer_email','synthetic://k4/role',repeat('a',64),true,true);
    EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
    IF NOT failed THEN RAISE EXCEPTION 'K4_SERVICE_OR_ANON_CONSENT_ALLOWED'; END IF;
    EXECUTE 'RESET ROLE';
  END LOOP;
  INSERT INTO k4_checks VALUES('anon_and_service_role_rpc_denied',true);

  PERFORM set_config('request.jwt.claim.sub',staff::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  requested:=clock_timestamp();
  EXECUTE 'SET LOCAL ROLE authenticated';
  event_id:=public.crm_restore_email_consent_v1(blocked,requested,'customer_email','synthetic://k4/customer-evidence',repeat('b',64),true,true);
  EXECUTE 'RESET ROLE';
  IF (SELECT email_status<>'subscribed' OR email_suppressed_at IS NOT NULL FROM core.customers WHERE id=blocked)
     OR NOT EXISTS(SELECT 1 FROM core.consent_events WHERE id=event_id AND customer_id=blocked AND event_type='reconsent') THEN
    RAISE EXCEPTION 'K4_VALID_APPROVAL_NOT_ATOMIC';
  END IF;
  INSERT INTO k4_checks VALUES('staff_approved_fresh_evidence_and_subscription_atomic',true);
  IF EXISTS(SELECT 1 FROM core.email_reconsent_authorizations WHERE customer_id=blocked)
    OR NOT EXISTS(SELECT 1 FROM core.email_reconsent_evidence WHERE consent_event_id=event_id AND customer_id=blocked AND approved_by=staff AND customer_requested_at=requested)
    OR NOT EXISTS(SELECT 1 FROM core.klaviyo_email_observations WHERE customer_id=blocked AND blocked_status='suppressed') THEN
    RAISE EXCEPTION 'K4_EVIDENCE_GATE_OR_PROVIDER_BLOCK_CHANGED';
  END IF;
  INSERT INTO k4_checks VALUES('capability_consumed_evidence_bound_provider_block_retained',true);
  FOREACH q IN ARRAY ARRAY[
    format('UPDATE core.consent_events SET note=''tamper'' WHERE id=%L',event_id),
    format('DELETE FROM core.consent_events WHERE id=%L',event_id),
    format('UPDATE core.email_reconsent_evidence SET evidence_reference=''tamper'' WHERE consent_event_id=%L',event_id),
    format('DELETE FROM core.email_reconsent_evidence WHERE consent_event_id=%L',event_id),
    'TRUNCATE core.email_reconsent_evidence CASCADE'
  ] LOOP
    failed:=false;
    BEGIN EXECUTE q; EXCEPTION WHEN insufficient_privilege THEN failed:=true; END;
    IF NOT failed THEN RAISE EXCEPTION 'K4_EVIDENCE_MUTABLE'; END IF;
  END LOOP;
  INSERT INTO k4_checks VALUES('accepted_evidence_update_delete_truncate_denied',true);
  PERFORM core.suppress_email(email,'INTERNAL TEST K4 later suppression');
  failed:=false;
  BEGIN PERFORM public.crm_restore_email_consent_v1(blocked,requested,'customer_email','synthetic://k4/different-but-stale-evidence',repeat('c',64),true,true);
  EXCEPTION WHEN invalid_parameter_value THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'K4_STALE_EVIDENCE_AFTER_LATER_BLOCK'; END IF;
  INSERT INTO k4_checks VALUES('new_artifact_with_pre_latest_suppression_date_denied',true);
  failed:=false;
  BEGIN PERFORM public.crm_restore_email_consent_v1(blocked,clock_timestamp(),'customer_email','synthetic://k4/customer-evidence',repeat('b',64),true,true);
  EXCEPTION WHEN invalid_parameter_value THEN failed:=true; END;
  IF NOT failed OR (SELECT email_status FROM core.customers WHERE id=blocked)<>'unsubscribed' THEN
    RAISE EXCEPTION 'K4_EVIDENCE_REPLAY_OR_UNBLOCK';
  END IF;
  INSERT INTO k4_checks VALUES('later_suppression_and_evidence_replay_blocked',true);
  -- Reconsent again, then an older provider snapshot suppresses locally.
  PERFORM public.crm_restore_email_consent_v1(blocked,clock_timestamp(),'customer_email','synthetic://k4/second-fresh',repeat('d',64),true,true);
  requested:=clock_timestamp();
  PERFORM public.record_klaviyo_status_v1(blocked,email,'suppressed',clock_timestamp()-interval '1 minute',NULL);
  failed:=false;
  BEGIN PERFORM public.crm_restore_email_consent_v1(blocked,requested,'customer_email','synthetic://k4/pre-provider-block',repeat('e',64),true,true);
  EXCEPTION WHEN invalid_parameter_value THEN failed:=true; END;
  IF NOT failed THEN RAISE EXCEPTION 'K4_PROVIDER_STALE_BOUNDARY_BYPASS'; END IF;
  INSERT INTO k4_checks VALUES('older_provider_snapshot_still_sets_current_local_suppression_boundary',true);

  -- Identity-only ingestion contract, not an implemented/live Clover adapter.
  INSERT INTO core.customers(id,business_id,identity_key,name,email,is_test)
  VALUES(identity_id,b,'email:k4-identity.'||identity_id::text||'@example.invalid','INTERNAL TEST K4 identity','k4-identity.'||identity_id::text||'@example.invalid',true);
  FOR n IN 1..2 LOOP
    INSERT INTO core.customers(business_id,identity_key,name,email,is_test)
    SELECT c.business_id,c.identity_key,'INTERNAL TEST identity-only update',c.email,true FROM core.customers c WHERE c.id=identity_id
    ON CONFLICT(identity_key) DO UPDATE SET name=excluded.name;
  END LOOP;
  PERFORM public.submit_signup_once(gen_random_uuid(),b,'INTERNAL TEST no consent',(SELECT c.email FROM core.customers c WHERE c.id=identity_id),NULL,'website_vip_page',false,false,'{}',NULL);
  SELECT email_status INTO status FROM core.customers WHERE id=identity_id;
  IF status<>'not_subscribed' OR EXISTS(SELECT 1 FROM core.consent_events WHERE customer_id=identity_id AND email_requested) THEN RAISE EXCEPTION 'K4_IDENTITY_GRANTED_CONSENT'; END IF;
  INSERT INTO k4_checks VALUES('matching_identity_and_unconsented_form_remain_not_subscribed',true);

  INSERT INTO core.offers(business_id,name,description,code,starts_at,ends_at,active,is_test)
  SELECT b,'INTERNAL TEST K4 '||x.kind,'Synthetic only','K4-'||x.kind,
    (clock_timestamp() AT TIME ZONE z.timezone)::date+x.start_offset,
    (clock_timestamp() AT TIME ZONE z.timezone)::date+x.end_offset,x.enabled,true
  FROM core.businesses z CROSS JOIN (VALUES('live',-1,1,true),('inactive',-1,1,false),('scheduled',1,2,true),('ended',-2,-1,true)) AS x(kind,start_offset,end_offset,enabled) WHERE z.id=b;
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO n FROM public.list_offers(b) WHERE name LIKE 'INTERNAL TEST K4 %' AND code='K4-'||offer_status;
  EXECUTE 'RESET ROLE';
  IF n<>4 THEN RAISE EXCEPTION 'K4_FULL_OFFERS_MISSING'; END IF;
  SELECT count(*) INTO n FROM public.get_active_offers(b) WHERE name LIKE 'INTERNAL TEST K4 %';
  IF n<>1 THEN RAISE EXCEPTION 'K4_PUBLIC_OFFERS_CHANGED'; END IF;
  INSERT INTO k4_checks VALUES('staff_all_four_offer_states_public_filter_preserved',true);
  IF has_schema_privilege('authenticated','core','USAGE') OR has_schema_privilege('anon','core','USAGE') OR has_schema_privilege('service_role','core','USAGE') THEN RAISE EXCEPTION 'K4_CORE_EXPOSED'; END IF;
  INSERT INTO k4_checks VALUES('core_api_roles_remain_closed',true);
END $test$;
SELECT jsonb_build_object('scope','K4_SYNTHETIC_ROLLBACK_DB_ACCEPTANCE','passed',count(*),'failed',count(*) FILTER(WHERE NOT passed),'checks',jsonb_agg(name ORDER BY name),'account_operations',0,'auth_http_claimed',false,'fixtures_rolled_back',true) FROM k4_checks;
ROLLBACK;
