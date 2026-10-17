-- Nazar only. Adds a read-only, paginated staff queue; no customer rows are changed.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.installation WHERE declared_project_ref = 'khgczybubufouraqyrcj')
    OR to_regclass('core.customer_follow_up_tasks') IS NULL
    OR to_regclass('core.catering_decisions') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected Nazar CRM foundation is missing';
  END IF;
  IF to_regprocedure('public.crm_follow_up_queue_v1(text,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'STOP: queue function already exists; inspect the installed definition before replacing it';
  END IF;
END
$guard$;

CREATE FUNCTION public.crm_follow_up_queue_v1(p_queue text DEFAULT 'open_catering', p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  IF p_queue IS NULL OR p_queue NOT IN ('open_catering','missing_owner','missing_followup',
    'overdue_catering','open_tasks','overdue_tasks','pending_decisions')
    OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid queue or offset' USING ERRCODE = '22023';
  END IF;
  WITH customers AS MATERIALIZED (
    SELECT c.id, c.name FROM core.customers c
    WHERE c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
      AND (EXISTS (SELECT 1 FROM core.signups s WHERE s.customer_id = c.id AND NOT s.is_test)
        OR NOT EXISTS (SELECT 1 FROM core.signups s WHERE s.customer_id = c.id))
  ), requests AS MATERIALIZED (
    SELECT r.id, r.customer_id, c.name AS customer_name, r.status AS request_status,
      r.assigned_to, r.follow_up_at AS due_at, r.created_at,
      r.follow_up_at < now() AS overdue,
      nullif(btrim(r.assigned_to), '') IS NULL AS missing_owner,
      r.follow_up_at IS NULL AS missing_followup
    FROM core.catering_requests r JOIN customers c ON c.id = r.customer_id
    WHERE NOT r.is_test AND r.status IN ('new','contacted','quoted')
  ), tasks AS MATERIALIZED (
    SELECT t.id, t.customer_id, c.name AS customer_name, t.title, t.assigned_to,
      t.due_at, t.created_at, t.due_at < now() AS overdue
    FROM core.customer_follow_up_tasks t JOIN customers c ON c.id = t.customer_id
    WHERE t.completed_at IS NULL
  ), decisions AS MATERIALIZED (
    SELECT d.id, r.id AS request_id, r.customer_id, r.customer_name, d.question AS title,
      r.request_status, r.assigned_to, r.due_at, d.requested_at AS created_at
    FROM core.catering_decisions d JOIN requests r ON r.id = d.request_id
    WHERE d.recorded_at IS NULL
  ), entries AS (
    SELECT 'request'::text AS kind, r.id, r.id AS request_id, r.customer_id, r.customer_name,
      'Catering follow-up'::text AS title, r.request_status, r.assigned_to, r.due_at, r.created_at,
      array_remove(ARRAY[CASE WHEN r.overdue THEN 'overdue' END,
        CASE WHEN r.missing_owner THEN 'missing_owner' END,
        CASE WHEN r.missing_followup THEN 'missing_followup' END], NULL) AS flags,
      CASE WHEN r.overdue THEN 0 WHEN r.missing_followup THEN 1 WHEN r.missing_owner THEN 2 ELSE 3 END AS priority
    FROM requests r
    WHERE p_queue = 'open_catering' OR (p_queue = 'missing_owner' AND r.missing_owner)
      OR (p_queue = 'missing_followup' AND r.missing_followup)
      OR (p_queue = 'overdue_catering' AND r.overdue)
    UNION ALL
    SELECT 'task', t.id, NULL::uuid, t.customer_id, t.customer_name, t.title, NULL::text,
      t.assigned_to, t.due_at, t.created_at,
      CASE WHEN t.overdue THEN ARRAY['overdue'] ELSE ARRAY[]::text[] END,
      CASE WHEN t.overdue THEN 0 ELSE 3 END
    FROM tasks t WHERE p_queue = 'open_tasks' OR (p_queue = 'overdue_tasks' AND t.overdue)
    UNION ALL
    SELECT 'decision', d.id, d.request_id, d.customer_id, d.customer_name, d.title,
      d.request_status, d.assigned_to, d.due_at, d.created_at, ARRAY['decision'], 1
    FROM decisions d WHERE p_queue = 'pending_decisions'
  ), page AS (
    SELECT * FROM entries ORDER BY priority, due_at ASC NULLS LAST, created_at, id
    LIMIT 25 OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'generated_at', now(), 'queue', p_queue, 'offset', p_offset, 'page_size', 25,
    'total', (SELECT count(*) FROM entries),
    'counts', jsonb_build_object(
      'open_catering', (SELECT count(*) FROM requests),
      'missing_owner', (SELECT count(*) FROM requests WHERE missing_owner),
      'missing_followup', (SELECT count(*) FROM requests WHERE missing_followup),
      'overdue_catering', (SELECT count(*) FROM requests WHERE overdue),
      'open_tasks', (SELECT count(*) FROM tasks),
      'overdue_tasks', (SELECT count(*) FROM tasks WHERE overdue),
      'pending_decisions', (SELECT count(*) FROM decisions)),
    'items', coalesce((SELECT jsonb_agg(to_jsonb(p) - 'priority'
      ORDER BY p.priority, p.due_at ASC NULLS LAST, p.created_at, p.id) FROM page p), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.crm_follow_up_queue_v1(text,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_follow_up_queue_v1(text,integer) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
