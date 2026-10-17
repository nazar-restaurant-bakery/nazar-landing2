-- Nazar-production only. Apply before enabling the Pages notification secrets.
-- New catering requests are linked to their idempotent form request ID without
-- changing the existing submit_signup_once() implementation.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.installation
                 WHERE declared_project_ref = 'khgczybubufouraqyrcj')
     OR to_regclass('core.signup_request_keys') IS NULL
     OR to_regclass('core.catering_requests') IS NULL
     OR to_regclass('core.crm_staff') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected Nazar-production intake and CRM are missing';
  END IF;
END
$guard$;

ALTER TABLE core.catering_requests
  ADD COLUMN IF NOT EXISTS form_request_id uuid,
  ADD COLUMN IF NOT EXISTS staff_notification_attempted_at timestamptz,
  ADD COLUMN IF NOT EXISTS staff_notification_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS staff_notification_error text;
CREATE UNIQUE INDEX IF NOT EXISTS catering_requests_form_request_id_unique
  ON core.catering_requests(form_request_id) WHERE form_request_id IS NOT NULL;

CREATE OR REPLACE FUNCTION core.set_form_request_context()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  PERFORM pg_catalog.set_config('nazar.form_request_id', NEW.request_id::text, true);
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION core.set_form_request_context() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS set_form_request_context ON core.signup_request_keys;
CREATE TRIGGER set_form_request_context AFTER INSERT ON core.signup_request_keys
FOR EACH ROW EXECUTE FUNCTION core.set_form_request_context();

CREATE OR REPLACE FUNCTION core.link_catering_form_request()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_request_id text;
BEGIN
  v_request_id := pg_catalog.current_setting('nazar.form_request_id', true);
  IF nullif(v_request_id, '') IS NOT NULL THEN
    NEW.form_request_id := v_request_id::uuid;
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION core.link_catering_form_request() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS link_catering_form_request ON core.catering_requests;
CREATE TRIGGER link_catering_form_request BEFORE INSERT ON core.catering_requests
FOR EACH ROW EXECUTE FUNCTION core.link_catering_form_request();

-- Only the server-side service key can claim or finish a delivery attempt.
CREATE OR REPLACE FUNCTION public.claim_catering_staff_notification_v1(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_row record;
BEGIN
  UPDATE core.catering_requests r
  SET staff_notification_attempted_at = now(), staff_notification_error = NULL
  FROM core.customers c
  WHERE r.form_request_id = p_request_id AND c.id = r.customer_id
    AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
    AND r.staff_notification_sent_at IS NULL
    AND (r.staff_notification_attempted_at IS NULL
         OR r.staff_notification_attempted_at < now() - interval '5 minutes')
  RETURNING r.id, r.created_at, r.event_date, r.guests INTO v_row;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN pg_catalog.jsonb_build_object(
    'requestId', p_request_id, 'requestDate', v_row.created_at,
    'eventDate', v_row.event_date, 'guests', v_row.guests
  );
END
$fn$;
REVOKE ALL ON FUNCTION public.claim_catering_staff_notification_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_catering_staff_notification_v1(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_catering_staff_notification_v1(
  p_request_id uuid, p_sent boolean
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  UPDATE core.catering_requests r
  SET staff_notification_sent_at = CASE WHEN p_sent THEN now() ELSE NULL END,
      staff_notification_error = CASE WHEN p_sent THEN NULL ELSE 'delivery_failed' END
  FROM core.customers c
  WHERE r.form_request_id = p_request_id AND c.id = r.customer_id
    AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
    AND r.staff_notification_attempted_at IS NOT NULL
    AND r.staff_notification_sent_at IS NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.finish_catering_staff_notification_v1(uuid,boolean)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finish_catering_staff_notification_v1(uuid,boolean)
  TO service_role;

CREATE OR REPLACE FUNCTION public.crm_catering_notification_status_v1()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_items jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff
                 WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_items
  FROM (
    SELECT r.id AS request_id, r.form_request_id IS NOT NULL AS tracked,
           r.staff_notification_attempted_at AS attempted_at,
           r.staff_notification_sent_at AS sent_at,
           r.staff_notification_error AS error
    FROM core.catering_requests r
    JOIN core.customers c ON c.id = r.customer_id
    WHERE c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
      AND r.created_at >= now() - interval '30 days'
    ORDER BY r.created_at DESC LIMIT 100
  ) x;
  RETURN pg_catalog.jsonb_build_object('items', v_items);
END
$fn$;
REVOKE ALL ON FUNCTION public.crm_catering_notification_status_v1()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_catering_notification_status_v1()
  TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
