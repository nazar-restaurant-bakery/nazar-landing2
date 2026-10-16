-- Additive, Nazar-production only. Contains no customer contact fields.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $guard$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.installation WHERE declared_project_ref = 'khgczybubufouraqyrcj')
     OR to_regclass('core.crm_staff') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected Nazar-production CRM';
  END IF;
END $guard$;

CREATE TABLE IF NOT EXISTS core.form_errors (
  id uuid PRIMARY KEY,
  request_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  form_kind text NOT NULL CHECK (form_kind IN ('vip','catering','unknown')),
  stage text NOT NULL CHECK (stage IN ('configuration','challenge','database')),
  error_code text NOT NULL CHECK (error_code IN ('missing_server_configuration','challenge_unavailable','database_unavailable','upstream_timeout','upstream_network_error')),
  http_status integer NOT NULL CHECK (http_status = 503),
  resolved_at timestamptz,
  resolved_by uuid,
  alert_status text NOT NULL DEFAULT 'not_requested' CHECK (alert_status IN ('not_requested','suppressed','claimed','accepted','failed')),
  alert_accepted_at timestamptz
);
CREATE INDEX IF NOT EXISTS form_errors_open_time ON core.form_errors(occurred_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS form_errors_request ON core.form_errors(request_id) WHERE resolved_at IS NULL;
CREATE TABLE IF NOT EXISTS core.form_error_alert_gate (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_attempt_at timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO core.form_error_alert_gate(singleton) VALUES(true) ON CONFLICT DO NOTHING;
ALTER TABLE core.form_errors ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.form_error_alert_gate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.form_errors, core.form_error_alert_gate FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_form_error_v1(
  p_id uuid, p_request_id uuid, p_kind text, p_stage text, p_code text, p_status integer,
  p_claim_alert boolean DEFAULT false
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_inserted integer; v_claimed integer := 0;
BEGIN
  IF p_request_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text, 0));
  END IF;
  INSERT INTO core.form_errors(id,request_id,form_kind,stage,error_code,http_status)
    VALUES(p_id,p_request_id,p_kind,p_stage,p_code,p_status) ON CONFLICT(id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN RETURN false; END IF;
  -- A delayed background logger must not reopen an already accepted retry.
  IF EXISTS (SELECT 1 FROM core.signup_request_keys WHERE request_id = p_request_id) THEN
    UPDATE core.form_errors SET resolved_at = now() WHERE id = p_id;
    RETURN false;
  END IF;
  IF p_claim_alert THEN
    -- One atomic account-wide gate, including failed delivery attempts.
    UPDATE core.form_error_alert_gate SET last_attempt_at = now()
      WHERE singleton AND last_attempt_at <= now() - interval '15 minutes';
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    UPDATE core.form_errors SET alert_status = CASE WHEN v_claimed = 1 THEN 'claimed' ELSE 'suppressed' END
      WHERE id = p_id;
  END IF;
  RETURN v_claimed = 1;
END $fn$;

CREATE OR REPLACE FUNCTION public.finish_form_error_alert_v1(p_id uuid, p_accepted boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  UPDATE core.form_errors SET alert_status = CASE WHEN p_accepted THEN 'accepted' ELSE 'failed' END,
    alert_accepted_at = CASE WHEN p_accepted THEN now() ELSE NULL END
    WHERE id = p_id AND alert_status = 'claimed';
END $fn$;

CREATE OR REPLACE FUNCTION public.resolve_form_errors_v1(p_request_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  -- Success of the same idempotent submission resolves its earlier failures only.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text, 0));
  UPDATE core.form_errors SET resolved_at = now() WHERE request_id = p_request_id AND resolved_at IS NULL;
END $fn$;

CREATE OR REPLACE FUNCTION public.crm_form_errors_v1()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_items jsonb; v_total bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_total FROM core.form_errors WHERE resolved_at IS NULL;
  SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_items FROM (
    SELECT id,occurred_at,form_kind,stage,error_code,http_status,alert_status
    FROM core.form_errors WHERE resolved_at IS NULL ORDER BY occurred_at DESC LIMIT 50
  ) x;
  RETURN jsonb_build_object('total_open',v_total,'items',v_items);
END $fn$;

CREATE OR REPLACE FUNCTION public.crm_resolve_form_error_v1(p_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_changed integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  UPDATE core.form_errors SET resolved_at = now(), resolved_by = auth.uid() WHERE id = p_id AND resolved_at IS NULL;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END $fn$;

REVOKE ALL ON FUNCTION public.record_form_error_v1(uuid,uuid,text,text,text,integer,boolean),
  public.finish_form_error_alert_v1(uuid,boolean),public.resolve_form_errors_v1(uuid),
  public.crm_form_errors_v1(),public.crm_resolve_form_error_v1(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_form_error_v1(uuid,uuid,text,text,text,integer,boolean),
  public.finish_form_error_alert_v1(uuid,boolean),public.resolve_form_errors_v1(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.crm_form_errors_v1(),public.crm_resolve_form_error_v1(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
