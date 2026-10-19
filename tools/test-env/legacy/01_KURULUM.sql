-- NAZAR v1.0 - NEW EMPTY PROJECT ONLY. Run the WHOLE file as postgres.
-- Talip executes this; no source-project connection or data migration.
-- Project name: Nazar-production; ref observed in Talip's screenshot:
-- khgczybubufouraqyrcj. Compare with dashboard URL before running.
-- The declaration below is a HUMAN confirmation, NOT server identity detection.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL nazar.confirm_project_ref = 'REPLACE_WITH_NEW_PROJECT_REF';

DO $guard$
BEGIN
  IF current_setting('nazar.confirm_project_ref', true) IS DISTINCT FROM
     'khgczybubufouraqyrcj' THEN
    RAISE EXCEPTION 'STOP: confirm NEW Nazar dashboard ref before running.';
  END IF;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'STOP: use the postgres role in the NEW project SQL Editor.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'core') OR
     EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname IN ('submit_signup','get_active_offers')) THEN
    RAISE EXCEPTION 'STOP: existing core/schema or site functions found. Do not overwrite.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') OR
     NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') OR
     NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    RAISE EXCEPTION 'STOP: expected Supabase roles missing.';
  END IF;
END $guard$;

CREATE SCHEMA core AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA core FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA core REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA core REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA core REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE core.installation (
  version text PRIMARY KEY,
  declared_project_ref text NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE core.businesses (
  id uuid PRIMARY KEY CHECK (id='a358eba4-b197-4309-805b-46f43a718454'::uuid),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'America/New_York',
  intake_enabled boolean NOT NULL DEFAULT false
);
-- Reusing the known Nazar UUID is an identifier choice, not an external link.
INSERT INTO core.businesses(id,name) VALUES
 ('a358eba4-b197-4309-805b-46f43a718454','Nazar Restaurant & Bakery');

CREATE TABLE core.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  identity_key text NOT NULL UNIQUE,
  name text,
  email text,
  phone text,
  email_status text NOT NULL DEFAULT 'not_subscribed'
    CHECK (email_status IN ('not_subscribed','pending_review','subscribed','unsubscribed')),
  email_suppressed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CHECK (email_suppressed_at IS NULL OR email_status='unsubscribed')
);
CREATE UNIQUE INDEX customers_email_unique ON core.customers(lower(email)) WHERE email IS NOT NULL;

CREATE TABLE core.signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  customer_id uuid NOT NULL REFERENCES core.customers(id),
  name text, email text, phone text,
  source text NOT NULL CHECK(source IN ('website_vip_form','website_vip_page','catering')),
  consent_email boolean NOT NULL DEFAULT false,
  consent_sms boolean NOT NULL DEFAULT false,
  utm jsonb NOT NULL DEFAULT '{}'::jsonb,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint text NOT NULL,
  processed boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX signups_retry_lookup ON core.signups(fingerprint,created_at);

CREATE TABLE core.consent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES core.customers(id),
  signup_id uuid REFERENCES core.signups(id),
  event_type text NOT NULL CHECK(event_type IN ('request','suppression')),
  source text NOT NULL,
  email_requested boolean NOT NULL DEFAULT false,
  sms_requested boolean NOT NULL DEFAULT false,
  evidence_status text NOT NULL CHECK(evidence_status IN ('pending_review','not_marketing','admin_suppression')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE core.catering_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signup_id uuid NOT NULL UNIQUE REFERENCES core.signups(id),
  customer_id uuid NOT NULL REFERENCES core.customers(id),
  event_date date,
  guests integer CHECK(guests>0 AND guests<=10000),
  message text,
  status text NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','quoted','won','lost','closed')),
  assigned_to text NOT NULL DEFAULT 'Yücel Otay',
  follow_up_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE core.offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
  description text,
  code text,
  channel_target text NOT NULL DEFAULT 'clover' CHECK(channel_target='clover'),
  starts_at date NOT NULL,
  ends_at date NOT NULL,
  active boolean NOT NULL DEFAULT false,
  CHECK(ends_at>=starts_at)
);

CREATE FUNCTION public.submit_signup(
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
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE k NOT IN ('event_date','guests','message')) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Unsupported metadata';
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
END $fn$;

CREATE FUNCTION public.get_active_offers(p_business_id uuid)
RETURNS TABLE(id uuid,name text,description text,code text,channel_target text,starts_at date,ends_at date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT o.id,o.name,o.description,o.code,o.channel_target,o.starts_at,o.ends_at
  FROM core.offers o JOIN core.businesses b ON b.id=o.business_id
  WHERE o.business_id=p_business_id AND o.active
    AND (now() AT TIME ZONE b.timezone)::date BETWEEN o.starts_at AND o.ends_at
  ORDER BY o.starts_at DESC,o.id
$fn$;

-- ADMIN ONLY. Klaviyo unsubscribe integration is a later step, not implemented here.
CREATE FUNCTION core.suppress_email(p_email text,p_reason text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_id uuid; v_count integer:=0;
BEGIN
  IF nullif(btrim(p_reason),'') IS NULL OR length(p_reason)>1000 THEN
    RAISE EXCEPTION 'Suppression reason required (max 1000 characters)';
  END IF;
  FOR v_id IN UPDATE core.customers SET email_status='unsubscribed',
    email_suppressed_at=now(),updated_at=now() WHERE lower(email)=lower(btrim(p_email)) RETURNING id
  LOOP
    INSERT INTO core.consent_events(customer_id,event_type,source,evidence_status,note)
      VALUES(v_id,'suppression','admin','admin_suppression',p_reason);
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $fn$;

ALTER TABLE core.installation ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.signups ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.catering_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.offers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA core FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA core FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA core FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_active_offers(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE ON SCHEMA public TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_active_offers(uuid) TO anon,authenticated;
INSERT INTO core.installation(version,declared_project_ref)
 VALUES('nazar-foundation-1.0',current_setting('nazar.confirm_project_ref'));
NOTIFY pgrst,'reload schema';
COMMIT;
SELECT version,declared_project_ref FROM core.installation;
-- Expected: nazar-foundation-1.0 | khgczybubufouraqyrcj
-- Intake remains DISABLED. No offers, historical records, accounts or messages created.
