-- LOCAL SYNTHETIC FIXTURE ONLY. Never apply this file to hosted Supabase.
-- Faithful minimum of baseline core shapes; two businesses are a fixture only.
-- This neither alters the historical baseline nor proves hosted multitenancy.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE SCHEMA auth;
CREATE SCHEMA core;
-- Auth UUID existence only: no login/session/provider fixture is manufactured.
CREATE TABLE auth.users(id uuid PRIMARY KEY);
REVOKE ALL ON SCHEMA core FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
 AS $$SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role',true),''),NULLIF(current_setting('test.jwt_role',true),''))$$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
 AS $$SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),NULLIF(current_setting('test.uid',true),''))::uuid$$;
GRANT USAGE ON SCHEMA auth TO service_role,authenticated;
GRANT EXECUTE ON FUNCTION auth.role(),auth.uid() TO service_role,authenticated;
CREATE TABLE core.businesses(id uuid PRIMARY KEY,name text NOT NULL);
CREATE TABLE core.customers(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL REFERENCES core.businesses(id),
 identity_key text NOT NULL,name text,email text,phone text,
 email_status text NOT NULL DEFAULT 'not_subscribed' CHECK(email_status IN ('not_subscribed','pending_review','subscribed','unsubscribed')),
 email_suppressed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(email IS NOT NULL OR phone IS NOT NULL),CHECK(email_suppressed_at IS NULL OR email_status='unsubscribed'),
 UNIQUE(identity_key));
CREATE TABLE core.crm_staff(auth_user_id uuid PRIMARY KEY,role text NOT NULL CHECK(role IN('owner','staff')),active boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.crm_staff_authorized_v1() RETURNS boolean LANGUAGE sql SECURITY DEFINER
 SET search_path='' AS $$SELECT EXISTS(SELECT 1 FROM core.crm_staff WHERE auth_user_id=auth.uid() AND active)$$;
REVOKE ALL ON FUNCTION public.crm_staff_authorized_v1() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.crm_staff_authorized_v1() TO authenticated;
CREATE TABLE core.offers(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL REFERENCES core.businesses(id),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),description text,code text,
 channel_target text NOT NULL DEFAULT 'clover' CHECK(channel_target='clover'),starts_at date NOT NULL,ends_at date NOT NULL,
 active boolean NOT NULL DEFAULT false,CHECK(ends_at>=starts_at));
CREATE TABLE core.consent_events(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES core.customers(id),signup_id uuid,
 event_type text NOT NULL CHECK(event_type IN('request','suppression')),source text NOT NULL,
 email_requested boolean NOT NULL DEFAULT false,sms_requested boolean NOT NULL DEFAULT false,
 evidence_status text NOT NULL CHECK(evidence_status IN('pending_review','not_marketing','admin_suppression')),
 note text,created_at timestamptz NOT NULL DEFAULT now());
