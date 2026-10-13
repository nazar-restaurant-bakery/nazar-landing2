-- Mail-based catering decisions. Does not grant the shared CRM login decision-writing access.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.installation
                 WHERE declared_project_ref = 'khgczybubufouraqyrcj')
     OR to_regclass('core.catering_decisions') IS NULL
     OR to_regclass('core.crm_staff') IS NULL
     OR to_regclass('core.catering_decision_makers') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected Nazar-production decision queue is missing';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS core.catering_decision_email_tokens (
  decision_id uuid PRIMARY KEY REFERENCES core.catering_decisions(id) ON DELETE CASCADE,
  token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE core.catering_decision_email_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.catering_decision_email_tokens FROM PUBLIC, anon, authenticated;

ALTER TABLE core.catering_decisions
  ADD COLUMN IF NOT EXISTS source_email text,
  ADD COLUMN IF NOT EXISTS source_message_id text;
CREATE UNIQUE INDEX IF NOT EXISTS catering_decision_source_message_id
  ON core.catering_decisions(source_message_id) WHERE source_message_id IS NOT NULL;
ALTER TABLE core.catering_decisions DROP CONSTRAINT IF EXISTS decision_consistency;
ALTER TABLE core.catering_decisions ADD CONSTRAINT decision_consistency CHECK (
  (decision IS NULL AND recorded_by IS NULL AND recorded_at IS NULL
    AND source_email IS NULL AND source_message_id IS NULL)
  OR
  (decision IS NOT NULL AND recorded_at IS NOT NULL AND
    ((recorded_by IS NOT NULL AND source_email IS NULL AND source_message_id IS NULL)
     OR (recorded_by IS NULL AND source_email IS NOT NULL AND source_message_id IS NOT NULL)))
);

CREATE OR REPLACE FUNCTION public.crm_decision_email_token_v1(p_decision_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_token uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM core.catering_decisions q
    JOIN core.catering_requests r ON r.id = q.request_id
    JOIN core.customers c ON c.id = r.customer_id
    WHERE q.id = p_decision_id AND q.recorded_at IS NULL
      AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
  ) THEN
    RAISE EXCEPTION 'Pending decision not found' USING ERRCODE = '22023';
  END IF;
  INSERT INTO core.catering_decision_email_tokens(decision_id)
  VALUES (p_decision_id) ON CONFLICT (decision_id) DO NOTHING;
  SELECT token INTO v_token FROM core.catering_decision_email_tokens
  WHERE decision_id = p_decision_id;
  RETURN v_token;
END;
$fn$;
REVOKE ALL ON FUNCTION public.crm_decision_email_token_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_decision_email_token_v1(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.crm_import_catering_decision_email_v1(
  p_decision_id uuid, p_token uuid, p_sender text,
  p_message_id text, p_answer text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service role required' USING ERRCODE = '42501';
  END IF;
  IF lower(trim(coalesce(p_sender, ''))) <> 'ctnazarbakery@gmail.com'
     OR length(trim(coalesce(p_message_id, ''))) NOT BETWEEN 5 AND 255
     OR length(trim(coalesce(p_answer, ''))) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Invalid decision email' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM core.catering_decisions
             WHERE id = p_decision_id AND source_message_id = trim(p_message_id)) THEN
    RETURN true; -- Delivery retry of the same message.
  END IF;
  UPDATE core.catering_decisions q
  SET decision = trim(p_answer), recorded_by = NULL, recorded_at = now(),
      source_email = 'ctnazarbakery@gmail.com', source_message_id = trim(p_message_id)
  FROM core.catering_decision_email_tokens t, core.catering_requests r,
       core.customers c
  WHERE q.id = p_decision_id AND q.recorded_at IS NULL
    AND t.decision_id = q.id AND t.token = p_token
    AND r.id = q.request_id AND c.id = r.customer_id
    AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid;
  RETURN FOUND;
END;
$fn$;
REVOKE ALL ON FUNCTION public.crm_import_catering_decision_email_v1(uuid,uuid,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_import_catering_decision_email_v1(uuid,uuid,text,text,text)
  TO service_role;

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
           q.decision, q.recorded_at, q.source_email,
           r.status AS request_status, c.name AS customer_name
    FROM core.catering_decisions q
    JOIN core.catering_requests r ON r.id = q.request_id
    JOIN core.customers c ON c.id = r.customer_id
    WHERE c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
    ORDER BY q.recorded_at NULLS FIRST, q.requested_at DESC LIMIT 100
  ) d;
  RETURN jsonb_build_object('items', v_rows);
END;
$fn$;
REVOKE ALL ON FUNCTION public.crm_catering_decisions_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_catering_decisions_v1() TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
