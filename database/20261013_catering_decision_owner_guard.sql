-- Restrict price/menu answer recording to a separately authenticated decision maker.
-- No person is added here. A verified Yucel account must be linked later.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.installation
                 WHERE declared_project_ref = 'khgczybubufouraqyrcj')
     OR to_regclass('core.catering_decisions') IS NULL
     OR to_regclass('core.crm_staff') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected Nazar-production decision queue is missing';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS core.catering_decision_makers (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  added_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE core.catering_decision_makers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.catering_decision_makers FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.crm_record_catering_decision_v1(
  p_decision_id uuid, p_decision text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff
                 WHERE auth_user_id = auth.uid() AND active)
     OR NOT EXISTS (SELECT 1 FROM core.catering_decision_makers
                    WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Decision maker access required' USING ERRCODE = '42501';
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
