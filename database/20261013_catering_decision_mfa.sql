-- Apply to Nazar-production after confirming the two Auth identities:
-- ctnazarbakery@gmail.com = Yücel decision login; info@nazarrestaurantandbakery.com = Talip staff login.
-- The mailboxes forward to the same inbox; only Yücel's authenticator can raise his session to AAL2.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.installation
                 WHERE declared_project_ref = 'khgczybubufouraqyrcj')
     OR to_regclass('core.catering_decision_makers') IS NULL
     OR to_regclass('core.crm_staff') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected Nazar-production CRM decision tables are missing';
  END IF;
  IF (SELECT count(*) FROM auth.users WHERE lower(email) = 'ctnazarbakery@gmail.com') <> 1
     OR (SELECT count(*) FROM auth.users WHERE lower(email) = 'info@nazarrestaurantandbakery.com') <> 1 THEN
    RAISE EXCEPTION 'STOP: expected Yucel and Talip Auth accounts are missing or duplicated';
  END IF;
END
$guard$;

INSERT INTO core.crm_staff(auth_user_id, role, active)
SELECT id, 'staff', true FROM auth.users WHERE lower(email) = 'info@nazarrestaurantandbakery.com'
ON CONFLICT (auth_user_id) DO UPDATE SET active = true;

INSERT INTO core.catering_decision_makers(auth_user_id, active)
SELECT id, true FROM auth.users WHERE lower(email) = 'ctnazarbakery@gmail.com'
ON CONFLICT (auth_user_id) DO UPDATE SET active = true;

CREATE OR REPLACE FUNCTION public.crm_decision_maker_status_v1()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_eligible boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM core.crm_staff s
    JOIN core.catering_decision_makers d ON d.auth_user_id = s.auth_user_id
    WHERE s.auth_user_id = auth.uid() AND s.active AND d.active
  ) INTO v_eligible;
  RETURN jsonb_build_object('eligible', v_eligible,
    'verified', v_eligible AND coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2');
END;
$fn$;
REVOKE ALL ON FUNCTION public.crm_decision_maker_status_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_decision_maker_status_v1() TO authenticated;

CREATE OR REPLACE FUNCTION public.crm_record_catering_decision_v1(
  p_decision_id uuid, p_decision text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff
                 WHERE auth_user_id = auth.uid() AND active)
     OR NOT EXISTS (SELECT 1 FROM core.catering_decision_makers
                    WHERE auth_user_id = auth.uid() AND active)
     OR coalesce(auth.jwt()->>'aal', 'aal1') <> 'aal2' THEN
    RAISE EXCEPTION 'Verified decision maker access required' USING ERRCODE = '42501';
  END IF;
  IF length(trim(coalesce(p_decision, ''))) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Invalid decision' USING ERRCODE = '22023';
  END IF;
  UPDATE core.catering_decisions q
  SET decision = trim(p_decision), recorded_by = auth.uid(), recorded_at = now()
  FROM core.catering_requests r
  JOIN core.customers c ON c.id = r.customer_id
  WHERE q.id = p_decision_id AND q.request_id = r.id AND q.recorded_at IS NULL
    AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid;
  RETURN FOUND;
END;
$fn$;
REVOKE ALL ON FUNCTION public.crm_record_catering_decision_v1(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_record_catering_decision_v1(uuid,text) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
