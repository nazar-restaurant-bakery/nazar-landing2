-- K4: local email suppression is lifted only by evidence-bound staff approval.
-- Apply this exact LF-only file with the same psql runner in test and production.
-- No provider writes, provider unblock, account changes, or fixed business IDs.
-- A database administrator who can redefine/disable these objects remains trusted.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('crm_suppression_consent_offers_v1', 0)
);

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('core.customers') IS NULL
    OR pg_catalog.to_regclass('core.consent_events') IS NULL
    OR pg_catalog.to_regclass('core.crm_staff') IS NULL
    OR pg_catalog.to_regclass('core.offers') IS NULL
    OR pg_catalog.to_regclass('core.businesses') IS NULL
    OR pg_catalog.to_regprocedure('auth.uid()') IS NULL
    OR pg_catalog.to_regprocedure('auth.role()') IS NULL THEN
    RAISE EXCEPTION 'K4_BASELINE_OR_AUTH_CONTRACT_MISSING';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c
    WHERE c.oid IN ('core.customers'::regclass, 'core.consent_events'::regclass,
      'core.crm_staff'::regclass, 'core.offers'::regclass)
      AND NOT c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'K4_PRIVATE_CORE_RLS_REQUIRED';
  END IF;
  IF pg_catalog.has_schema_privilege('anon', 'core', 'USAGE')
    OR pg_catalog.has_schema_privilege('authenticated', 'core', 'USAGE')
    OR pg_catalog.has_schema_privilege('service_role', 'core', 'USAGE') THEN
    RAISE EXCEPTION 'K4_PRIVATE_CORE_MUST_ALREADY_BE_CLOSED';
  END IF;
  IF pg_catalog.current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'K4_ORIGIN_REPLICATION_ROLE_REQUIRED';
  END IF;
END
$preflight$;

LOCK TABLE core.customers, core.consent_events IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE core.consent_events
  DROP CONSTRAINT consent_events_event_type_check,
  DROP CONSTRAINT consent_events_evidence_status_check,
  ADD CONSTRAINT consent_events_event_type_check
    CHECK (event_type IN ('request', 'suppression', 'reconsent')),
  ADD CONSTRAINT consent_events_evidence_status_check
    CHECK (evidence_status IN (
      'pending_review', 'not_marketing', 'admin_suppression', 'staff_approved'
    )),
  ADD CONSTRAINT consent_events_reconsent_consistency_check
    CHECK (
      (event_type = 'reconsent') = (evidence_status = 'staff_approved')
      AND (event_type <> 'reconsent' OR
        (email_requested AND NOT sms_requested AND signup_id IS NULL))
    );

-- The artifact reference/hash identifies retained customer-origin evidence.
-- It does not itself authenticate the external artifact or send an email.
CREATE TABLE core.email_reconsent_evidence (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  consent_event_id uuid NOT NULL UNIQUE
    REFERENCES core.consent_events(id),
  customer_id uuid NOT NULL REFERENCES core.customers(id),
  identity_key_at_approval text NOT NULL,
  previous_suppressed_at timestamptz NOT NULL,
  customer_requested_at timestamptz NOT NULL,
  evidence_source text NOT NULL,
  evidence_reference text NOT NULL,
  evidence_sha256 text NOT NULL,
  customer_initiated boolean NOT NULL CHECK (customer_initiated),
  approved_by uuid NOT NULL,
  staff_approved boolean NOT NULL CHECK (staff_approved),
  approved_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT email_reconsent_evidence_source_check CHECK (evidence_source IN (
    'customer_email', 'customer_web', 'customer_in_person', 'customer_signed_document'
  )),
  CONSTRAINT email_reconsent_evidence_reference_check CHECK (
    pg_catalog.length(pg_catalog.btrim(evidence_reference)) BETWEEN 1 AND 1000
    AND pg_catalog.octet_length(evidence_reference) <= 4000
    AND evidence_reference ~ '[^[:space:]]'
  ),
  CONSTRAINT email_reconsent_evidence_sha256_check CHECK (
    evidence_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT email_reconsent_evidence_dates_check CHECK (
    pg_catalog.isfinite(previous_suppressed_at)
    AND pg_catalog.isfinite(customer_requested_at)
    AND pg_catalog.isfinite(approved_at)
    AND customer_requested_at > previous_suppressed_at
    AND approved_at >= customer_requested_at
  )
);

-- No application role may insert a capability. It is created only after the
-- special function validates and records approval, and is consumed by the guard
-- in the same transaction. A caller-set custom GUC is never an authorization.
CREATE TABLE core.email_reconsent_authorizations (
  customer_id uuid NOT NULL REFERENCES core.customers(id),
  transaction_id bigint NOT NULL,
  evidence_id uuid NOT NULL UNIQUE REFERENCES core.email_reconsent_evidence(id),
  consent_event_id uuid NOT NULL UNIQUE REFERENCES core.consent_events(id),
  previous_suppressed_at timestamptz NOT NULL,
  PRIMARY KEY (customer_id, transaction_id)
);

ALTER TABLE core.email_reconsent_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.email_reconsent_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA core FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE core.email_reconsent_evidence,
  core.email_reconsent_authorizations, core.consent_events
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION core.reject_consent_evidence_mutation_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Consent evidence is append-only' USING ERRCODE = '42501';
END
$function$;

CREATE TRIGGER consent_events_immutable
  BEFORE UPDATE OR DELETE ON core.consent_events
  FOR EACH ROW EXECUTE FUNCTION core.reject_consent_evidence_mutation_v1();
CREATE TRIGGER consent_events_no_truncate
  BEFORE TRUNCATE ON core.consent_events
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_consent_evidence_mutation_v1();
CREATE TRIGGER email_reconsent_evidence_immutable
  BEFORE UPDATE OR DELETE ON core.email_reconsent_evidence
  FOR EACH ROW EXECUTE FUNCTION core.reject_consent_evidence_mutation_v1();
CREATE TRIGGER email_reconsent_evidence_no_truncate
  BEFORE TRUNCATE ON core.email_reconsent_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_consent_evidence_mutation_v1();
ALTER TABLE core.consent_events ENABLE ALWAYS TRIGGER consent_events_immutable;
ALTER TABLE core.consent_events ENABLE ALWAYS TRIGGER consent_events_no_truncate;
ALTER TABLE core.email_reconsent_evidence
  ENABLE ALWAYS TRIGGER email_reconsent_evidence_immutable;
ALTER TABLE core.email_reconsent_evidence
  ENABLE ALWAYS TRIGGER email_reconsent_evidence_no_truncate;

CREATE FUNCTION core.guard_email_suppression_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_latest_suppression timestamptz;
  v_consumed integer;
BEGIN
  IF OLD.email_status <> 'unsubscribed' AND OLD.email_suppressed_at IS NULL THEN
    IF NEW.email_status = 'unsubscribed' THEN
      -- Provider observations may carry an older checked_at and now() is the
      -- transaction-start time. A newly recorded block must create a server
      -- boundary after any earlier approval in this same transaction. Preserve
      -- a later supplied boundary, without changing unrelated blocked updates.
      NEW.email_suppressed_at := greatest(
        NEW.email_suppressed_at, pg_catalog.clock_timestamp()
      );
    END IF;
    RETURN NEW;
  END IF;

  -- Keeping the block or recording another later block remains valid. This
  -- preserves suppress_email() and negative provider readback behavior.
  IF NEW.email_status = 'unsubscribed'
    AND (OLD.email_suppressed_at IS NULL OR
      (NEW.email_suppressed_at IS NOT NULL
        AND NEW.email_suppressed_at >= OLD.email_suppressed_at)) THEN
    RETURN NEW;
  END IF;

  -- Do not allow a two-step exit through not_subscribed/pending_review or
  -- clearing/backdating the block while it remains unsubscribed.
  IF NEW.email_status <> 'subscribed' OR NEW.email_suppressed_at IS NOT NULL
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.business_id IS DISTINCT FROM OLD.business_id
    OR NEW.identity_key IS DISTINCT FROM OLD.identity_key
    OR NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'Suppression requires approved new customer consent'
      USING ERRCODE = '42501';
  END IF;

  SELECT greatest(OLD.email_suppressed_at, pg_catalog.max(e.created_at))
    INTO v_latest_suppression
  FROM core.consent_events e
  WHERE e.customer_id = OLD.id AND e.event_type = 'suppression';

  DELETE FROM core.email_reconsent_authorizations a
  USING core.email_reconsent_evidence e, core.consent_events event
  WHERE a.customer_id = OLD.id
    AND a.transaction_id = pg_catalog.txid_current()
    AND a.previous_suppressed_at = v_latest_suppression
    AND e.id = a.evidence_id AND e.customer_id = OLD.id
    AND e.consent_event_id = a.consent_event_id
    AND e.identity_key_at_approval = OLD.identity_key
    AND e.previous_suppressed_at = v_latest_suppression
    AND e.customer_requested_at > v_latest_suppression
    AND e.customer_requested_at <= e.approved_at
    AND e.approved_by = auth.uid()
    AND e.customer_initiated AND e.staff_approved
    AND event.id = a.consent_event_id AND event.customer_id = OLD.id
    AND event.event_type = 'reconsent'
    AND event.evidence_status = 'staff_approved'
    AND event.email_requested AND NOT event.sms_requested;
  GET DIAGNOSTICS v_consumed = ROW_COUNT;
  IF v_consumed <> 1 THEN
    RAISE EXCEPTION 'Suppression requires approved new customer consent'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER customers_guard_email_suppression
  BEFORE UPDATE ON core.customers
  FOR EACH ROW EXECUTE FUNCTION core.guard_email_suppression_v1();
ALTER TABLE core.customers ENABLE ALWAYS TRIGGER customers_guard_email_suppression;

-- Keep the existing suppression API and reason/event contract. now() would
-- reuse one transaction-start timestamp for approval -> suppression -> approval
-- batches, allowing a differently named but stale artifact through freshness.
-- Use the actual server boundary, and store the returned row boundary on the
-- event too (the entry guard can advance it for a newly blocked customer).
CREATE OR REPLACE FUNCTION core.suppress_email(p_email text, p_reason text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_row record;
  v_count integer := 0;
  v_suppressed_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF nullif(pg_catalog.btrim(p_reason), '') IS NULL
    OR pg_catalog.length(p_reason) > 1000 THEN
    RAISE EXCEPTION 'Suppression reason required (max 1000 characters)';
  END IF;
  FOR v_row IN
    UPDATE core.customers SET email_status = 'unsubscribed',
      email_suppressed_at = greatest(email_suppressed_at, v_suppressed_at),
      updated_at = v_suppressed_at
    WHERE pg_catalog.lower(email) = pg_catalog.lower(pg_catalog.btrim(p_email))
    RETURNING id, email_suppressed_at
  LOOP
    INSERT INTO core.consent_events(
      customer_id, event_type, source, evidence_status, note, created_at
    ) VALUES (
      v_row.id, 'suppression', 'admin', 'admin_suppression', p_reason,
      v_row.email_suppressed_at
    );
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$function$;

CREATE FUNCTION public.crm_restore_email_consent_v1(
  p_customer_id uuid,
  p_customer_requested_at timestamptz,
  p_evidence_source text,
  p_evidence_reference text,
  p_evidence_sha256 text,
  p_customer_initiated boolean,
  p_staff_approved boolean
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_staff uuid := auth.uid();
  v_customer core.customers%ROWTYPE;
  v_latest_suppression timestamptz;
  v_approved_at timestamptz;
  v_event_id uuid;
  v_evidence_id uuid;
  v_source text := pg_catalog.btrim(p_evidence_source);
  v_reference text := pg_catalog.btrim(p_evidence_reference);
  v_sha256 text := pg_catalog.lower(pg_catalog.btrim(p_evidence_sha256));
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR v_staff IS NULL THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM core.crm_staff s
    WHERE s.auth_user_id = v_staff AND s.active FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  IF p_customer_id IS NULL OR p_customer_requested_at IS NULL
    OR NOT pg_catalog.isfinite(p_customer_requested_at)
    OR p_customer_initiated IS NOT TRUE OR p_staff_approved IS NOT TRUE
    OR v_source IS NULL OR v_source NOT IN (
      'customer_email', 'customer_web', 'customer_in_person', 'customer_signed_document'
    )
    OR v_reference IS NULL OR pg_catalog.length(v_reference) NOT BETWEEN 1 AND 1000
    OR pg_catalog.octet_length(v_reference) > 4000 OR v_reference !~ '[^[:space:]]'
    OR v_sha256 IS NULL OR v_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Dated customer-origin evidence and staff approval are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO v_customer FROM core.customers c
    WHERE c.id = p_customer_id FOR UPDATE;
  IF NOT FOUND OR v_customer.email IS NULL
    OR v_customer.email_status <> 'unsubscribed' THEN
    RAISE EXCEPTION 'Suppressed email customer required' USING ERRCODE = '22023';
  END IF;

  SELECT greatest(v_customer.email_suppressed_at, pg_catalog.max(e.created_at))
    INTO v_latest_suppression
  FROM core.consent_events e
  WHERE e.customer_id = v_customer.id AND e.event_type = 'suppression';
  v_approved_at := pg_catalog.clock_timestamp();
  IF v_latest_suppression IS NULL OR NOT pg_catalog.isfinite(v_latest_suppression)
    OR p_customer_requested_at <= v_latest_suppression
    OR p_customer_requested_at > v_approved_at THEN
    RAISE EXCEPTION 'Customer consent must follow the latest dated suppression'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM core.email_reconsent_evidence e
    WHERE e.customer_id = v_customer.id
      AND (e.evidence_sha256 = v_sha256 OR
        (e.evidence_source = v_source AND e.evidence_reference = v_reference))
  ) THEN
    RAISE EXCEPTION 'Consent evidence has already been used' USING ERRCODE = '22023';
  END IF;

  INSERT INTO core.consent_events(
    customer_id, event_type, source, email_requested, sms_requested,
    evidence_status, note, created_at
  ) VALUES (
    v_customer.id, 'reconsent', v_source, true, false, 'staff_approved',
    'New customer-origin email consent approved by authorized staff.', v_approved_at
  ) RETURNING id INTO v_event_id;

  INSERT INTO core.email_reconsent_evidence(
    consent_event_id, customer_id, identity_key_at_approval,
    previous_suppressed_at, customer_requested_at, evidence_source,
    evidence_reference, evidence_sha256, customer_initiated,
    approved_by, staff_approved, approved_at
  ) VALUES (
    v_event_id, v_customer.id, v_customer.identity_key,
    v_latest_suppression, p_customer_requested_at, v_source,
    v_reference, v_sha256, true, v_staff, true, v_approved_at
  ) RETURNING id INTO v_evidence_id;

  INSERT INTO core.email_reconsent_authorizations(
    customer_id, transaction_id, evidence_id, consent_event_id, previous_suppressed_at
  ) VALUES (
    v_customer.id, pg_catalog.txid_current(), v_evidence_id, v_event_id, v_latest_suppression
  );

  UPDATE core.customers SET email_status = 'subscribed',
    email_suppressed_at = NULL, updated_at = v_approved_at
  WHERE id = v_customer.id;
  IF EXISTS (
    SELECT 1 FROM core.email_reconsent_authorizations a
    WHERE a.customer_id = v_customer.id AND a.transaction_id = pg_catalog.txid_current()
  ) THEN
    RAISE EXCEPTION 'Consent authorization was not consumed' USING ERRCODE = '42501';
  END IF;

  -- Provider observations and provider suppressions are deliberately untouched.
  RETURN v_event_id;
END
$function$;

CREATE FUNCTION public.list_offers(p_business_id uuid)
RETURNS TABLE(
  id uuid, name text, description text, code text, channel_target text,
  starts_at date, ends_at date, active boolean, offer_status text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM core.crm_staff s WHERE s.auth_user_id = auth.uid() AND s.active
    ) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'Business ID required' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT o.id, o.name, o.description, o.code, o.channel_target,
    o.starts_at, o.ends_at, o.active,
    CASE
      WHEN NOT o.active THEN 'inactive'
      WHEN (pg_catalog.now() AT TIME ZONE b.timezone)::date < o.starts_at THEN 'scheduled'
      WHEN (pg_catalog.now() AT TIME ZONE b.timezone)::date > o.ends_at THEN 'ended'
      ELSE 'live'
    END::text
  FROM core.offers o JOIN core.businesses b ON b.id = o.business_id
  WHERE o.business_id = p_business_id
  ORDER BY o.starts_at DESC, o.id;
END
$function$;

REVOKE ALL ON FUNCTION core.reject_consent_evidence_mutation_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION core.guard_email_suppression_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION core.suppress_email(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.crm_restore_email_consent_v1(
  uuid, timestamptz, text, text, text, boolean, boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_offers(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_restore_email_consent_v1(
  uuid, timestamptz, text, text, text, boolean, boolean
) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_offers(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
