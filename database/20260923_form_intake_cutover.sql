-- Run only in Nazar-production AFTER the Pages Function, both secrets,
-- the Turnstile site key, and preview/production tests are verified.
-- This is the final cutover: public callers lose submit_signup access and
-- only the server-side secret key may call it. It also enables intake.
BEGIN;
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.installation
    WHERE version = 'nazar-foundation-1.0'
      AND declared_project_ref = 'khgczybubufouraqyrcj'
  ) THEN
    RAISE EXCEPTION 'Wrong Nazar project or installation';
  END IF;
END $check$;
REVOKE EXECUTE ON FUNCTION public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)
  TO service_role;
UPDATE core.businesses
SET intake_enabled = true
WHERE id = 'a358eba4-b197-4309-805b-46f43a718454';
DO $check$
BEGIN
  IF (SELECT count(*) FROM core.businesses WHERE intake_enabled) <> 1 THEN
    RAISE EXCEPTION 'Unexpected intake state';
  END IF;
  IF has_function_privilege('anon', 'public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected function permissions';
  END IF;
END $check$;
COMMIT;
