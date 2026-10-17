-- 07.05: normalize surrounding whitespace before validating the assignee.
-- No row changes and no privilege changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20s';
DO $guard$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM core.installation WHERE declared_project_ref = 'khgczybubufouraqyrcj') THEN
  RAISE EXCEPTION 'STOP: wrong project';
 END IF;
 IF md5(pg_get_functiondef('public.crm_update_catering(uuid,text,text,timestamptz)'::regprocedure)) IS DISTINCT FROM '6964b069513cb32409e80319ce490131' THEN
  RAISE EXCEPTION 'STOP: catering update function changed; inspect before replacing';
 END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.crm_update_catering(p_request_id uuid, p_status text, p_assigned_to text, p_follow_up_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_assigned_to text := regexp_replace(coalesce(p_assigned_to, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
BEGIN
 IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
  RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
 END IF;
 IF p_status IS NULL OR p_status NOT IN ('new','contacted','quoted','won','lost','closed')
  OR length(v_assigned_to) NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'Invalid input' USING ERRCODE = '22023';
 END IF;
 IF p_status IN ('new','contacted','quoted') AND p_follow_up_at IS NULL THEN
  RAISE EXCEPTION 'Open requests require a follow-up time' USING ERRCODE = '22023';
 END IF;
 UPDATE core.catering_requests r
 SET status = p_status, assigned_to = v_assigned_to, follow_up_at = p_follow_up_at
 FROM core.customers c
 WHERE r.id = p_request_id AND c.id = r.customer_id
  AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid;
 RETURN FOUND;
END;
$function$
;
NOTIFY pgrst, 'reload schema';
COMMIT;
