-- Nazar-production: allow validated structured catering selections to remain with each signup.
-- Apply before deploying the matching /api/signup change. No existing rows are rewritten.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.installation WHERE declared_project_ref = 'khgczybubufouraqyrcj')
     OR to_regclass('core.signups') IS NULL
     OR to_regclass('core.catering_requests') IS NULL
     OR to_regprocedure('public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)') IS NULL
     OR to_regprocedure('public.submit_signup_once(uuid,uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected Nazar-production catering intake is missing';
  END IF;
  -- Fingerprints captured read-only from Nazar-production on 2026-10-16.
  -- Stop rather than replace form/retry logic if another release changed it.
  IF md5(pg_get_functiondef('public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)'::regprocedure))
       <> '71a8543f121f7499e954bd83c0cbcd99'
     OR md5(pg_get_functiondef('public.submit_signup_once(uuid,uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)'::regprocedure))
       <> '606b291d6f83f39836ee2ea4477af6ed' THEN
    RAISE EXCEPTION 'STOP: live signup function changed; reconcile before installing structured selection';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.submit_signup(
  p_business_id uuid, p_name text, p_email text, p_phone text, p_source text,
  p_consent_email boolean, p_consent_sms boolean, p_utm jsonb,
  p_meta jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_email text := nullif(lower(btrim(p_email)),'');
  v_phone text := nullif(btrim(p_phone),'');
  v_name text := nullif(btrim(p_name),'');
  v_source text := btrim(p_source);
  v_utm jsonb := coalesce(p_utm,'{}'::jsonb);
  v_meta jsonb := coalesce(p_meta,'{}'::jsonb);
  v_key text;
  v_customer uuid;
  v_signup uuid;
  v_fingerprint text;
  v_date date;
  v_guests integer;
  v_email_request boolean;
BEGIN
  IF p_business_id IS DISTINCT FROM 'a358eba4-b197-4309-805b-46f43a718454'::uuid OR
     NOT EXISTS (SELECT 1 FROM core.businesses WHERE id=p_business_id AND intake_enabled) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Intake unavailable';
  END IF;
  IF v_source IS NULL OR v_source NOT IN ('website_vip_form','website_vip_page','catering') THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid source';
  END IF;
  IF v_email IS NULL AND v_phone IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Contact required';
  END IF;
  IF v_email IS NOT NULL AND (length(v_email)>254 OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$') THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid email';
  END IF;
  IF v_phone IS NOT NULL AND v_phone !~ '^\+1[0-9]{10}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid US phone';
  END IF;
  IF length(v_name)>200 OR jsonb_typeof(v_meta)<>'object' OR jsonb_typeof(v_utm)<>'object'
     OR octet_length(v_meta::text)>8192 OR octet_length(v_utm::text)>4096 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid or oversized input';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE k NOT IN ('event_date','guests','message','customer_message','menu_selection')) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Unsupported metadata';
  END IF;
  IF v_meta ? 'customer_message' AND
     (jsonb_typeof(v_meta->'customer_message') <> 'string' OR length(v_meta->>'customer_message') > 2000) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid customer message';
  END IF;
  IF v_meta ? 'menu_selection' AND jsonb_typeof(v_meta->'menu_selection') <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid menu selection';
  END IF;
  IF v_source<>'catering' AND v_meta<>'{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Metadata reserved for catering';
  END IF;
  IF length(v_meta->>'message')>4000 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Message too long';
  END IF;
  IF nullif(v_meta->>'event_date','') IS NOT NULL THEN
    IF (v_meta->>'event_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid date';
    END IF;
    v_date := (v_meta->>'event_date')::date;
  END IF;
  IF v_meta ? 'guests' AND v_meta->>'guests' IS NOT NULL THEN
    IF (v_meta->>'guests') !~ '^[0-9]{1,5}$' THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid guests';
    END IF;
    v_guests := (v_meta->>'guests')::integer;
    IF v_guests<1 OR v_guests>10000 THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid guests';
    END IF;
  END IF;
  -- Transport assertions are not verified marketing consent.
  v_email_request := v_source<>'catering' AND coalesce(p_consent_email,false) AND v_email IS NOT NULL;
  v_key := CASE WHEN v_email IS NOT NULL THEN 'email:'||v_email ELSE 'phone:'||v_phone END;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_key,0));
  v_fingerprint := md5(jsonb_build_array(p_business_id,v_name,v_email,v_phone,v_source,
                      coalesce(p_consent_email,false),coalesce(p_consent_sms,false),v_utm,v_meta)::text);
  IF EXISTS (SELECT 1 FROM core.signups WHERE fingerprint=v_fingerprint
             AND created_at>clock_timestamp()-interval '10 minutes') THEN RETURN; END IF;

  INSERT INTO core.customers(business_id,identity_key,name,email,phone,email_status)
    VALUES(p_business_id,v_key,v_name,v_email,v_phone,
           CASE WHEN v_email_request THEN 'pending_review' ELSE 'not_subscribed' END)
    ON CONFLICT(identity_key) DO UPDATE SET
      updated_at=now(),
      email_status=CASE WHEN core.customers.email_status='not_subscribed' AND v_email_request
                        AND core.customers.email_suppressed_at IS NULL
                        THEN 'pending_review' ELSE core.customers.email_status END
    RETURNING id INTO v_customer;
  -- Existing contact fields are not overwritten by unauthenticated submissions.
  INSERT INTO core.signups(business_id,customer_id,name,email,phone,source,consent_email,
                          consent_sms,utm,meta,fingerprint)
    VALUES(p_business_id,v_customer,v_name,v_email,v_phone,v_source,v_email_request,
           coalesce(p_consent_sms,false) AND v_phone IS NOT NULL,v_utm,v_meta,v_fingerprint)
    RETURNING id INTO v_signup;
  INSERT INTO core.consent_events(customer_id,signup_id,event_type,source,email_requested,
                                  sms_requested,evidence_status)
    VALUES(v_customer,v_signup,'request',v_source,v_email_request,
           coalesce(p_consent_sms,false) AND v_phone IS NOT NULL,
           CASE WHEN v_source='catering' THEN 'not_marketing' ELSE 'pending_review' END);
  IF v_source='catering' THEN
    INSERT INTO core.catering_requests(signup_id,customer_id,event_date,guests,message)
      VALUES(v_signup,v_customer,v_date,v_guests,v_meta->>'message');
  END IF;
END;
$fn$;

-- Preserve retries started before the structured-selection rollout.
CREATE OR REPLACE FUNCTION public.submit_signup_once(
  p_request_id uuid,
  p_business_id uuid, p_name text, p_email text, p_phone text, p_source text,
  p_consent_email boolean, p_consent_sms boolean, p_utm jsonb,
  p_meta jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_hash text;
  v_existing text;
  v_legacy_hash text;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Request ID required';
  END IF;
  v_hash := md5(pg_catalog.jsonb_build_array(
    p_business_id, p_name, p_email, p_phone, p_source,
    p_consent_email, p_consent_sms, p_utm, p_meta
  )::text);

  v_legacy_hash := md5(pg_catalog.jsonb_build_array(
    p_business_id, p_name, p_email, p_phone, p_source,
    p_consent_email, p_consent_sms, p_utm, p_meta - 'menu_selection' - 'customer_message'
  )::text);

  -- The primary key serializes concurrent attempts for the same request ID.
  INSERT INTO core.signup_request_keys(request_id, payload_hash)
  VALUES (p_request_id, v_hash) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT payload_hash INTO v_existing
    FROM core.signup_request_keys WHERE request_id = p_request_id;
    IF v_existing IS DISTINCT FROM v_hash AND v_existing IS DISTINCT FROM v_legacy_hash THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Request ID reused with different content';
    END IF;
    RETURN;
  END IF;

  -- This runs in the same transaction as the key insert. If submission fails,
  -- both roll back and a later retry can safely try again.
  PERFORM public.submit_signup(
    p_business_id, p_name, p_email, p_phone, p_source,
    p_consent_email, p_consent_sms, p_utm, p_meta
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;

