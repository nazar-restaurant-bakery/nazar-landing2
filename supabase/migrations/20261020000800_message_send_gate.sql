-- K6: shared campaign/flow email quota and one-time dispatch authorization.
-- No provider adapter, send, key, cron, identity/consent update or fixed tenant.
-- Apply identical LF bytes test-first, only after reviewed Ops (3) and K7 (4).
-- Unknown/blocked/unresolved attempts require manual review; never auto retry.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('message_send_gate_v1',0));
DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('core.ops_metrics') IS NULL
    OR pg_catalog.to_regclass('core.ops_actions') IS NULL
    OR pg_catalog.to_regclass('core.ops_connections') IS NULL
    OR pg_catalog.to_regclass('core.orders') IS NULL
    OR pg_catalog.to_regclass('core.order_items') IS NULL
    OR pg_catalog.to_regclass('core.payments') IS NULL
    OR pg_catalog.to_regclass('core.refunds') IS NULL
    OR pg_catalog.to_regclass('core.order_match_review') IS NULL
    OR pg_catalog.to_regprocedure('core.clover_order_status_v1(uuid)') IS NULL
    OR pg_catalog.to_regprocedure('public.clover_order_ingest_v1(uuid,text,jsonb)') IS NULL
    OR pg_catalog.to_regprocedure('public.clover_order_day_totals_v1(uuid,timestamptz,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'K6_REVIEWED_OPS_AND_K7_REQUIRED';
  END IF;
  IF pg_catalog.to_regprocedure('core.guard_email_suppression_v1()') IS NULL
    OR pg_catalog.to_regprocedure('core.klaviyo_profile_sync_eligible_v1(uuid,uuid)') IS NULL
    OR pg_catalog.to_regprocedure('auth.role()') IS NULL THEN
    RAISE EXCEPTION 'K6_REVIEWED_K4_K5_REQUIRED';
  END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
    OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='core.customers'::regclass)
    OR pg_catalog.current_setting('session_replication_role')<>'origin' THEN
    RAISE EXCEPTION 'K6_PRIVATE_CORE_RLS_AND_ORIGIN_REQUIRED';
  END IF;
END $preflight$;

-- No setting/disabled means deny. Operator provisions an explicitly reviewed
-- business row; 168 hours is the default, not a hard-coded business identity.
CREATE TABLE core.message_send_settings (
  business_id uuid PRIMARY KEY REFERENCES core.businesses(id),
  enabled boolean NOT NULL DEFAULT false,
  min_interval_hours integer NOT NULL DEFAULT 168 CHECK(min_interval_hours BETWEEN 1 AND 8760),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE core.message_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  customer_id uuid NOT NULL REFERENCES core.customers(id),
  message_key text NOT NULL CHECK(message_key ~ '^[A-Za-z0-9_.:-]{8,120}$'),
  message_kind text NOT NULL CHECK(message_kind IN('campaign','flow')),
  channel text NOT NULL DEFAULT 'email' CHECK(channel='email'),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[0-9a-f]{64}$'),
  recipient_sha256 text NOT NULL CHECK(recipient_sha256 ~ '^[0-9a-f]{64}$'),
  identity_sha256 text NOT NULL CHECK(identity_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK(status IN('reserved','claimed','sending','sent','unknown','blocked')),
  lease_id uuid,
  reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reservation_expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes',
  claimed_at timestamptz,
  dispatch_expires_at timestamptz,
  dispatch_authorized_at timestamptz,
  sent_at timestamptz,
  finished_at timestamptz,
  last_code text CHECK(last_code IN('reservation_expired','lease_expired','settings_disabled',
    'customer_ineligible','identity_changed','frequency_limited','unknown','blocked')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(business_id,message_key),
  CHECK(reservation_expires_at>reserved_at),
  CHECK((status IN('claimed','sending','sent','unknown'))= (lease_id IS NOT NULL)
    OR status='blocked'),
  CHECK((status='sent')=(sent_at IS NOT NULL)),
  CHECK(sent_at IS NULL OR (dispatch_authorized_at IS NOT NULL AND sent_at>=dispatch_authorized_at)),
  CHECK(dispatch_authorized_at IS NULL OR claimed_at IS NOT NULL)
);
CREATE INDEX message_log_person_quota ON core.message_log(business_id,customer_id,status,sent_at);
ALTER TABLE core.message_send_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.message_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE core.message_send_settings,core.message_log FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION core.message_log_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF ROW(NEW.id,NEW.business_id,NEW.customer_id,NEW.message_key,NEW.message_kind,NEW.channel,
    NEW.payload_sha256,NEW.recipient_sha256,NEW.identity_sha256,NEW.reserved_at,NEW.reservation_expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.business_id,OLD.customer_id,OLD.message_key,OLD.message_kind,OLD.channel,
    OLD.payload_sha256,OLD.recipient_sha256,OLD.identity_sha256,OLD.reserved_at,OLD.reservation_expires_at)
    OR (OLD.lease_id IS NOT NULL AND NEW.lease_id IS DISTINCT FROM OLD.lease_id)
    OR (OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS DISTINCT FROM OLD.claimed_at)
    OR (OLD.dispatch_authorized_at IS NOT NULL AND NEW.dispatch_authorized_at IS DISTINCT FROM OLD.dispatch_authorized_at)
    OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
    OR (OLD.status IN('sent','unknown','blocked') AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'K6_MESSAGE_LOG_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_log_immutable BEFORE UPDATE ON core.message_log
FOR EACH ROW EXECUTE FUNCTION core.message_log_immutable_v1();
ALTER TABLE core.message_log ENABLE ALWAYS TRIGGER message_log_immutable;

CREATE FUNCTION core.message_send_window_blocked_v1(p_business_id uuid,p_customer_id uuid,p_exclude uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT COALESCE((SELECT NOT s.enabled OR EXISTS(
    SELECT 1 FROM core.message_log m
    WHERE m.business_id=p_business_id AND m.customer_id=p_customer_id
      AND (p_exclude IS NULL OR m.id<>p_exclude)
      AND (m.status IN('reserved','claimed','sending','unknown','blocked')
        OR (m.status='sent' AND m.sent_at>clock_timestamp()-pg_catalog.make_interval(hours=>s.min_interval_hours))))
    FROM core.message_send_settings s WHERE s.business_id=p_business_id),true)
$$;

CREATE FUNCTION public.message_send_reserve_v1(p_business_id uuid,p_customer_id uuid,
  p_message_key text,p_message_kind text,p_payload_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c core.customers%ROWTYPE; m core.message_log%ROWTYPE; v_now timestamptz;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'K6_READ_COMMITTED_REQUIRED' USING ERRCODE='25000'; END IF;
  IF p_business_id IS NULL OR p_customer_id IS NULL OR p_message_key IS NULL
    OR p_message_key !~ '^[A-Za-z0-9_.:-]{8,120}$' OR p_message_kind IS NULL
    OR p_message_kind NOT IN('campaign','flow') OR p_payload_sha256 IS NULL
    OR p_payload_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid message intent' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_business_id::text||':'||p_customer_id::text,6008));
  SELECT * INTO c FROM core.customers WHERE id=p_customer_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'code','customer_ineligible'); END IF;
  PERFORM 1 FROM core.message_send_settings WHERE business_id=p_business_id FOR SHARE;
  SELECT * INTO m FROM core.message_log WHERE business_id=p_business_id AND message_key=p_message_key FOR UPDATE;
  IF FOUND THEN
    IF m.customer_id<>p_customer_id OR m.message_kind<>p_message_kind OR m.payload_sha256<>p_payload_sha256 THEN
      RETURN jsonb_build_object('allowed',false,'code','idempotency_conflict');
    END IF;
    IF m.status<>'reserved' THEN RETURN jsonb_build_object('allowed',false,'code','already_processed','reservationId',m.id,'status',m.status); END IF;
    IF m.reservation_expires_at<=clock_timestamp() THEN
      UPDATE core.message_log SET status='blocked',last_code='reservation_expired',finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=m.id;
      RETURN jsonb_build_object('allowed',false,'code','reservation_expired','reservationId',m.id,'status','blocked');
    END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM core.message_send_settings WHERE business_id=p_business_id AND enabled) THEN
    RETURN jsonb_build_object('allowed',false,'code','settings_disabled'); END IF;
  IF NOT core.klaviyo_profile_sync_eligible_v1(p_business_id,p_customer_id) THEN
    RETURN jsonb_build_object('allowed',false,'code','customer_ineligible'); END IF;
  IF m.id IS NOT NULL AND (m.recipient_sha256<>encode(sha256(convert_to(lower(btrim(c.email)),'UTF8')),'hex')
    OR m.identity_sha256<>encode(sha256(convert_to(c.identity_key,'UTF8')),'hex')) THEN
    UPDATE core.message_log SET status='blocked',last_code='identity_changed',finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=m.id;
    RETURN jsonb_build_object('allowed',false,'code','identity_changed','reservationId',m.id,'status','blocked');
  END IF;
  IF core.message_send_window_blocked_v1(p_business_id,p_customer_id,m.id) THEN
    RETURN jsonb_build_object('allowed',false,'code','frequency_limited'); END IF;
  IF m.id IS NOT NULL THEN RETURN jsonb_build_object('allowed',true,'code','already_reserved','reservationId',m.id,'status','reserved','idempotent',true); END IF;
  v_now:=clock_timestamp();
  INSERT INTO core.message_log(business_id,customer_id,message_key,message_kind,payload_sha256,recipient_sha256,identity_sha256,status,reserved_at,reservation_expires_at)
    VALUES(p_business_id,p_customer_id,p_message_key,p_message_kind,p_payload_sha256,
      encode(sha256(convert_to(lower(btrim(c.email)),'UTF8')),'hex'),encode(sha256(convert_to(c.identity_key,'UTF8')),'hex'),'reserved',v_now,v_now+interval '5 minutes') RETURNING * INTO m;
  RETURN jsonb_build_object('allowed',true,'code','reserved','reservationId',m.id,'status','reserved','idempotent',false);
END $$;

CREATE FUNCTION public.message_send_claim_v1(p_reservation_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE m core.message_log%ROWTYPE; c core.customers%ROWTYPE; v_code text; v_now timestamptz;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'K6_READ_COMMITTED_REQUIRED' USING ERRCODE='25000'; END IF;
  SELECT * INTO m FROM core.message_log WHERE id=p_reservation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'code','not_found'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(m.business_id::text||':'||m.customer_id::text,6008));
  SELECT * INTO c FROM core.customers WHERE id=m.customer_id AND business_id=m.business_id FOR UPDATE;
  PERFORM 1 FROM core.message_send_settings WHERE business_id=m.business_id FOR SHARE;
  SELECT * INTO m FROM core.message_log WHERE id=p_reservation_id FOR UPDATE;
  IF m.status<>'reserved' THEN RETURN jsonb_build_object('allowed',false,'code','not_claimable','reservationId',m.id,'status',m.status); END IF;
  IF m.reservation_expires_at<=clock_timestamp() THEN v_code:='reservation_expired';
  ELSIF NOT EXISTS(SELECT 1 FROM core.message_send_settings WHERE business_id=m.business_id AND enabled) THEN v_code:='settings_disabled';
  ELSIF NOT core.klaviyo_profile_sync_eligible_v1(m.business_id,m.customer_id) THEN v_code:='customer_ineligible';
  ELSIF m.recipient_sha256<>encode(sha256(convert_to(lower(btrim(c.email)),'UTF8')),'hex')
    OR m.identity_sha256<>encode(sha256(convert_to(c.identity_key,'UTF8')),'hex') THEN v_code:='identity_changed';
  ELSIF core.message_send_window_blocked_v1(m.business_id,m.customer_id,m.id) THEN v_code:='frequency_limited'; END IF;
  IF v_code IS NOT NULL THEN
    UPDATE core.message_log SET status='blocked',last_code=v_code,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=m.id;
    RETURN jsonb_build_object('allowed',false,'code',v_code,'reservationId',m.id,'status','blocked');
  END IF;
  v_now:=clock_timestamp();
  UPDATE core.message_log SET status='claimed',lease_id=gen_random_uuid(),claimed_at=v_now,
    dispatch_expires_at=v_now+interval '2 minutes',updated_at=v_now WHERE id=m.id RETURNING * INTO m;
  RETURN jsonb_build_object('allowed',true,'code','claimed','reservationId',m.id,'status','claimed',
    'leaseId',m.lease_id,'dispatchExpiresAt',m.dispatch_expires_at);
END $$;

CREATE FUNCTION public.message_send_context_v1(p_reservation_id uuid,p_lease_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE m core.message_log%ROWTYPE; c core.customers%ROWTYPE; v_code text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'K6_READ_COMMITTED_REQUIRED' USING ERRCODE='25000'; END IF;
  SELECT * INTO m FROM core.message_log WHERE id=p_reservation_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'code','not_found'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(m.business_id::text||':'||m.customer_id::text,6008));
  SELECT * INTO c FROM core.customers WHERE id=m.customer_id AND business_id=m.business_id FOR UPDATE;
  PERFORM 1 FROM core.message_send_settings WHERE business_id=m.business_id FOR SHARE;
  SELECT * INTO m FROM core.message_log WHERE id=p_reservation_id FOR UPDATE;
  IF p_lease_id IS NULL OR m.lease_id IS DISTINCT FROM p_lease_id OR m.status NOT IN('claimed','sending') THEN
    RETURN jsonb_build_object('allowed',false,'code','not_claimed','reservationId',m.id,'status',m.status); END IF;
  IF m.status='sending' THEN RETURN jsonb_build_object('allowed',false,'code','already_dispatched','reservationId',m.id,'status',m.status); END IF;
  IF m.dispatch_expires_at<=clock_timestamp() THEN
    UPDATE core.message_log SET status='unknown',last_code='lease_expired',finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=m.id;
    RETURN jsonb_build_object('allowed',false,'code','lease_expired','reservationId',m.id,'status','unknown'); END IF;
  IF NOT EXISTS(SELECT 1 FROM core.message_send_settings WHERE business_id=m.business_id AND enabled) THEN v_code:='settings_disabled';
  ELSIF NOT core.klaviyo_profile_sync_eligible_v1(m.business_id,m.customer_id) THEN v_code:='customer_ineligible';
  ELSIF m.recipient_sha256<>encode(sha256(convert_to(lower(btrim(c.email)),'UTF8')),'hex')
    OR m.identity_sha256<>encode(sha256(convert_to(c.identity_key,'UTF8')),'hex') THEN v_code:='identity_changed';
  ELSIF core.message_send_window_blocked_v1(m.business_id,m.customer_id,m.id) THEN v_code:='frequency_limited'; END IF;
  IF v_code IS NOT NULL THEN
    UPDATE core.message_log SET status='blocked',last_code=v_code,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=m.id;
    RETURN jsonb_build_object('allowed',false,'code',v_code,'reservationId',m.id,'status','blocked'); END IF;
  UPDATE core.message_log SET status='sending',dispatch_authorized_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=m.id RETURNING * INTO m;
  RETURN jsonb_build_object('allowed',true,'code','dispatch_authorized','reservationId',m.id,'status','sending',
    'context',jsonb_build_object('businessId',m.business_id,'customerId',m.customer_id,'messageKey',m.message_key,
      'messageKind',m.message_kind,'payloadSha256',m.payload_sha256,'leaseId',m.lease_id,
      'dispatchExpiresAt',m.dispatch_expires_at,'email',lower(btrim(c.email)),'emailStatus',c.email_status,
      'isTest',false,'suppressedAt',c.email_suppressed_at,'providerBlockedStatus',NULL));
END $$;

CREATE FUNCTION public.message_send_finalize_v1(p_reservation_id uuid,p_lease_id uuid,p_outcome text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE m core.message_log%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'K6_READ_COMMITTED_REQUIRED' USING ERRCODE='25000'; END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN('sent','unknown','blocked') THEN RAISE EXCEPTION 'Invalid final outcome' USING ERRCODE='22023'; END IF;
  SELECT * INTO m FROM core.message_log WHERE id=p_reservation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown reservation' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(m.business_id::text||':'||m.customer_id::text,6008));
  PERFORM 1 FROM core.customers WHERE id=m.customer_id AND business_id=m.business_id FOR UPDATE;
  SELECT * INTO m FROM core.message_log WHERE id=p_reservation_id FOR UPDATE;
  IF p_lease_id IS NULL OR m.lease_id IS DISTINCT FROM p_lease_id THEN RAISE EXCEPTION 'Invalid lease' USING ERRCODE='42501'; END IF;
  IF m.status IN('sent','unknown','blocked') THEN RETURN jsonb_build_object('status',m.status,'idempotent',true); END IF;
  IF m.status NOT IN('claimed','sending') OR (p_outcome='sent' AND m.status<>'sending') THEN
    RAISE EXCEPTION 'Dispatch not authorized' USING ERRCODE='22023'; END IF;
  UPDATE core.message_log SET status=p_outcome,sent_at=CASE WHEN p_outcome='sent' THEN clock_timestamp() ELSE NULL END,
    finished_at=clock_timestamp(),last_code=CASE WHEN p_outcome='sent' THEN NULL ELSE p_outcome END,
    updated_at=clock_timestamp() WHERE id=m.id;
  RETURN jsonb_build_object('status',p_outcome,'idempotent',false);
END $$;

REVOKE ALL ON FUNCTION core.message_log_immutable_v1() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION core.message_send_window_blocked_v1(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.message_send_reserve_v1(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.message_send_claim_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.message_send_context_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.message_send_finalize_v1(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.message_send_reserve_v1(uuid,uuid,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.message_send_claim_v1(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.message_send_context_v1(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.message_send_finalize_v1(uuid,uuid,text) TO service_role;
COMMIT;
