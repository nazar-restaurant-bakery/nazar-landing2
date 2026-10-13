-- Authorize the staff-only Klaviyo read endpoint without exposing customer rows.
-- Apply only to Nazar-production after a separate owner/unlisted-user check.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.installation
                 WHERE declared_project_ref = 'khgczybubufouraqyrcj')
     OR to_regclass('core.crm_staff') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected Nazar-production CRM staff table is missing';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.crm_staff_authorized_v1()
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT EXISTS (SELECT 1 FROM core.crm_staff
                 WHERE auth_user_id = auth.uid() AND active);
$fn$;
REVOKE ALL ON FUNCTION public.crm_staff_authorized_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_staff_authorized_v1() TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
