-- Enable the existing shared Nazar CRM login to record signed catering decisions.
-- This does not create another user or grant access to all CRM staff.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
DECLARE
  v_user_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.installation
                 WHERE declared_project_ref = 'khgczybubufouraqyrcj')
     OR to_regclass('core.catering_decision_makers') IS NULL
     OR to_regclass('core.catering_decisions') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected Nazar-production decision queue is missing';
  END IF;

  SELECT id INTO STRICT v_user_id
  FROM auth.users
  WHERE lower(email) = 'ctnazarbakery@gmail.com';

  IF NOT EXISTS (SELECT 1 FROM core.crm_staff
                 WHERE auth_user_id = v_user_id AND active) THEN
    RAISE EXCEPTION 'STOP: shared Nazar login is not active CRM staff';
  END IF;

  INSERT INTO core.catering_decision_makers (auth_user_id, active)
  VALUES (v_user_id, true)
  ON CONFLICT (auth_user_id) DO UPDATE SET active = true;
END
$guard$;

CREATE OR REPLACE FUNCTION public.crm_decision_maker_authorized_v1()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM core.crm_staff s
    JOIN core.catering_decision_makers m ON m.auth_user_id = s.auth_user_id
    WHERE s.auth_user_id = auth.uid() AND s.active AND m.active
  );
$fn$;

REVOKE ALL ON FUNCTION public.crm_decision_maker_authorized_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_decision_maker_authorized_v1() TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
