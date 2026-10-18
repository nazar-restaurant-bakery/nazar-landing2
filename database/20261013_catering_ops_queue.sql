-- Nazar-production: read-only catering operations queue for existing CRM staff.
-- Apply after 20261013_catering_structured_selection.sql; do not invite users here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.installation WHERE declared_project_ref = 'khgczybubufouraqyrcj')
     OR to_regclass('core.catering_requests') IS NULL
     OR to_regclass('core.signups') IS NULL
     OR to_regclass('core.customers') IS NULL
     OR to_regclass('core.crm_staff') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected Nazar-production catering tables are missing';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.catering_ops_requests_v1()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_items jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff
                 WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Catering operations access required' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(item)), '[]'::jsonb) INTO v_items FROM (
    SELECT r.id, r.created_at, r.event_date, r.guests, r.status,
           r.assigned_to, r.follow_up_at,
           c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone,
           s.meta->'menu_selection' AS menu_selection,
           coalesce(s.meta->>'customer_message', r.message) AS customer_message,
           r.message AS original_request_text
    FROM core.catering_requests r
    JOIN core.signups s ON s.id = r.signup_id
    JOIN core.customers c ON c.id = r.customer_id
    WHERE c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
    ORDER BY CASE WHEN r.status IN ('new', 'contacted', 'quoted') THEN 0 ELSE 1 END,
             r.created_at DESC
    LIMIT 100
  ) item;
  RETURN jsonb_build_object('items', v_items);
END;
$fn$;
REVOKE ALL ON FUNCTION public.catering_ops_requests_v1() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.catering_ops_requests_v1() TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
