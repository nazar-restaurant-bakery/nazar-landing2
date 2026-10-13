-- Customer follow-up tasks, separate from catering request statuses.
-- No existing records are modified.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.installation
                 WHERE declared_project_ref = 'khgczybubufouraqyrcj')
     OR to_regclass('core.crm_staff') IS NULL
     OR to_regclass('core.customers') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected Nazar-production CRM foundation is missing';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS core.customer_follow_up_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 300),
  assigned_to text NOT NULL CHECK (length(trim(assigned_to)) BETWEEN 1 AND 100),
  due_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_follow_up_tasks_due
  ON core.customer_follow_up_tasks(customer_id, completed_at, due_at);
ALTER TABLE core.customer_follow_up_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.customer_follow_up_tasks FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.crm_customer_tasks_v1(p_customer_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_tasks jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.customers WHERE id = p_customer_id
                 AND business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid) THEN
    RAISE EXCEPTION 'Customer not found' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tasks FROM (
    SELECT id, title, assigned_to, due_at, completed_at, created_at
    FROM core.customer_follow_up_tasks WHERE customer_id = p_customer_id
    ORDER BY completed_at NULLS FIRST, due_at ASC LIMIT 50
  ) t;
  RETURN v_tasks;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.crm_create_task_v1(
  p_customer_id uuid, p_title text, p_assigned_to text, p_due_at timestamptz
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  IF length(trim(coalesce(p_title, ''))) NOT BETWEEN 1 AND 300
     OR length(trim(coalesce(p_assigned_to, ''))) NOT BETWEEN 1 AND 100
     OR p_due_at IS NULL THEN
    RAISE EXCEPTION 'Invalid task' USING ERRCODE = '22023';
  END IF;
  INSERT INTO core.customer_follow_up_tasks(customer_id, created_by, title, assigned_to, due_at)
  SELECT id, auth.uid(), trim(p_title), trim(p_assigned_to), p_due_at
  FROM core.customers WHERE id = p_customer_id
    AND business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'Customer not found' USING ERRCODE = '22023'; END IF;
  RETURN v_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.crm_complete_task_v1(p_task_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  UPDATE core.customer_follow_up_tasks t SET completed_at = now()
  FROM core.customers c WHERE t.id = p_task_id AND t.customer_id = c.id
    AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
    AND t.completed_at IS NULL;
  RETURN FOUND;
END;
$fn$;

REVOKE ALL ON FUNCTION public.crm_customer_tasks_v1(uuid),
  public.crm_create_task_v1(uuid,text,text,timestamptz),
  public.crm_complete_task_v1(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_customer_tasks_v1(uuid),
  public.crm_create_task_v1(uuid,text,text,timestamptz),
  public.crm_complete_task_v1(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
