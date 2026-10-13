-- Draft for Nazar-production. Adds a shared price/menu decision queue to the staff CRM.
-- Does not send email, invite a user, or change existing catering requests.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.installation
                 WHERE declared_project_ref = 'khgczybubufouraqyrcj')
     OR to_regclass('core.crm_staff') IS NULL
     OR to_regclass('core.catering_requests') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected Nazar-production CRM is missing';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS core.catering_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES core.catering_requests(id) ON DELETE CASCADE,
  question text NOT NULL CHECK (length(trim(question)) BETWEEN 1 AND 1000),
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decision text CHECK (decision IS NULL OR length(trim(decision)) BETWEEN 1 AND 2000),
  recorded_by uuid REFERENCES auth.users(id),
  recorded_at timestamptz,
  CONSTRAINT decision_consistency CHECK (
    (decision IS NULL AND recorded_by IS NULL AND recorded_at IS NULL)
    OR (decision IS NOT NULL AND recorded_by IS NOT NULL AND recorded_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS catering_one_pending_decision_per_request
  ON core.catering_decisions(request_id) WHERE recorded_at IS NULL;
CREATE INDEX IF NOT EXISTS catering_decisions_queue
  ON core.catering_decisions(recorded_at, requested_at DESC);
ALTER TABLE core.catering_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.catering_decisions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.crm_catering_decisions_v1()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_rows jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff
                 WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) INTO v_rows FROM (
    SELECT q.id, q.request_id, q.question, q.requested_at,
           q.decision, q.recorded_at, r.status AS request_status,
           c.name AS customer_name
    FROM core.catering_decisions q
    JOIN core.catering_requests r ON r.id = q.request_id
    JOIN core.customers c ON c.id = r.customer_id
    WHERE c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
    ORDER BY q.recorded_at NULLS FIRST, q.requested_at DESC LIMIT 100
  ) d;
  RETURN jsonb_build_object('items', v_rows);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.crm_request_catering_decision_v1(
  p_request_id uuid, p_question text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff
                 WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  IF length(trim(coalesce(p_question, ''))) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Invalid question' USING ERRCODE = '22023';
  END IF;
  INSERT INTO core.catering_decisions(request_id, question, requested_by)
  SELECT r.id, trim(p_question), auth.uid()
  FROM core.catering_requests r
  JOIN core.customers c ON c.id = r.customer_id
  WHERE r.id = p_request_id
    AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
  ON CONFLICT (request_id) WHERE recorded_at IS NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Request missing or a decision is already pending' USING ERRCODE = '22023';
  END IF;
  RETURN v_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.crm_record_catering_decision_v1(
  p_decision_id uuid, p_decision text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff
                 WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
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

REVOKE ALL ON FUNCTION public.crm_catering_decisions_v1(),
  public.crm_request_catering_decision_v1(uuid,text),
  public.crm_record_catering_decision_v1(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_catering_decisions_v1(),
  public.crm_request_catering_decision_v1(uuid,text),
  public.crm_record_catering_decision_v1(uuid,text) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
