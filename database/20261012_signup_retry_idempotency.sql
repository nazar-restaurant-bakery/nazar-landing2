-- Nazar-production only. Apply before deploying the /api/signup code that calls
-- submit_signup_once. This migration does not change or delete existing leads.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.installation
    WHERE declared_project_ref = 'khgczybubufouraqyrcj'
  ) OR to_regprocedure('public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected Nazar-production form foundation is missing';
  END IF;
END
$guard$;

CREATE TABLE core.signup_request_keys (
  request_id uuid PRIMARY KEY,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE core.signup_request_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.signup_request_keys FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.submit_signup_once(
  p_request_id uuid,
  p_business_id uuid, p_name text, p_email text, p_phone text, p_source text,
  p_consent_email boolean, p_consent_sms boolean, p_utm jsonb,
  p_meta jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE
  v_hash text;
  v_existing text;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Request ID required';
  END IF;
  v_hash := md5(pg_catalog.jsonb_build_array(
    p_business_id, p_name, p_email, p_phone, p_source,
    p_consent_email, p_consent_sms, p_utm, p_meta
  )::text);

  -- The primary key serializes concurrent attempts for the same request ID.
  INSERT INTO core.signup_request_keys(request_id, payload_hash)
  VALUES (p_request_id, v_hash) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT payload_hash INTO v_existing
    FROM core.signup_request_keys WHERE request_id = p_request_id;
    IF v_existing IS DISTINCT FROM v_hash THEN
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
END
$fn$;

REVOKE ALL ON FUNCTION public.submit_signup_once(uuid,uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_signup_once(uuid,uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)
  TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
