-- K15 common gate only. Apply manually after K12 closes; no provider writes.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE TABLE core.ops_write_settings (
 business_id uuid PRIMARY KEY REFERENCES core.businesses(id),
 kill_switch boolean NOT NULL DEFAULT true
);
CREATE TABLE core.ops_write_staff (
 business_id uuid NOT NULL REFERENCES core.businesses(id),
 staff_id uuid NOT NULL REFERENCES auth.users(id),
 active boolean NOT NULL DEFAULT true,
 PRIMARY KEY(business_id,staff_id)
);
CREATE TABLE core.ops_write_actions (
 business_id uuid NOT NULL REFERENCES core.businesses(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 action_type text NOT NULL CHECK(action_type='dry_run'),
 target_id uuid NOT NULL,
 preview_hash text NOT NULL CHECK(preview_hash ~ '^[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'previewed' CHECK(status IN('previewed','approved','executing','succeeded','failed','expired')),
 created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 approved_by uuid, approved_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes',
 idempotency_key uuid NOT NULL,
 claim_token uuid, finished_at timestamptz,
 safe_result_code text NOT NULL DEFAULT 'preview_ready' CHECK(safe_result_code IN('preview_ready','approved','executing','dry_run_succeeded','dry_run_failed','expired','disabled')),
 PRIMARY KEY(business_id,id), UNIQUE(business_id,idempotency_key),
 FOREIGN KEY(business_id,created_by) REFERENCES core.ops_write_staff(business_id,staff_id),
 FOREIGN KEY(business_id,approved_by) REFERENCES core.ops_write_staff(business_id,staff_id),
 CHECK((approved_by IS NULL)=(approved_at IS NULL)),
 CHECK(expires_at>created_at)
);
ALTER TABLE core.ops_write_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ops_write_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.ops_write_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.ops_write_settings,core.ops_write_staff,core.ops_write_actions FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION core.ops_write_authorized(p_business_id uuid,p_staff_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT p_staff_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM core.ops_write_staff w JOIN core.crm_staff s ON s.auth_user_id=w.staff_id
  WHERE w.business_id=p_business_id AND w.staff_id=p_staff_id AND w.active AND s.active);
$$;
CREATE FUNCTION core.ops_write_receipt(p_row core.ops_write_actions) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT jsonb_build_object('business_id',p_row.business_id,'id',p_row.id,'action_type',p_row.action_type,
 'target_id',p_row.target_id,'preview_hash',p_row.preview_hash,'status',p_row.status,
 'approved_by',p_row.approved_by,'approved_at',p_row.approved_at,'expires_at',p_row.expires_at,
 'idempotency_key',p_row.idempotency_key,'safe_result_code',p_row.safe_result_code);
$$;
CREATE FUNCTION core.ops_write_check(p_business_id uuid,p_staff_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT core.ops_write_authorized(p_business_id,p_staff_id) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 -- Shared row lock serializes claim with an operator kill-switch change.
 PERFORM 1 FROM core.ops_write_settings WHERE business_id=p_business_id AND NOT kill_switch FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'disabled' USING ERRCODE='55000'; END IF;
END; $$;
CREATE FUNCTION public.ops_write_preview(p_business_id uuid,p_target_id uuid,p_preview_hash text,p_idempotency_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.ops_write_actions;
BEGIN
 PERFORM core.ops_write_check(p_business_id,auth.uid());
 INSERT INTO core.ops_write_actions(business_id,action_type,target_id,preview_hash,created_by,idempotency_key)
 VALUES(p_business_id,'dry_run',p_target_id,p_preview_hash,auth.uid(),p_idempotency_key)
 ON CONFLICT(business_id,idempotency_key) DO NOTHING;
 SELECT * INTO STRICT r FROM core.ops_write_actions WHERE business_id=p_business_id AND idempotency_key=p_idempotency_key FOR UPDATE;
 IF r.created_by<>auth.uid() OR r.target_id<>p_target_id OR r.preview_hash<>p_preview_hash THEN RAISE EXCEPTION 'repreview_required' USING ERRCODE='22023'; END IF;
 RETURN core.ops_write_receipt(r);
END; $$;
CREATE FUNCTION public.ops_write_approve(p_business_id uuid,p_action_id uuid,p_target_id uuid,p_preview_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.ops_write_actions;
BEGIN
 PERFORM core.ops_write_check(p_business_id,auth.uid());
 SELECT * INTO r FROM core.ops_write_actions WHERE business_id=p_business_id AND id=p_action_id AND created_by=auth.uid() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF r.target_id<>p_target_id OR r.preview_hash<>p_preview_hash THEN RAISE EXCEPTION 'repreview_required' USING ERRCODE='22023'; END IF;
 IF r.status IN('previewed','approved') AND r.expires_at<=clock_timestamp() THEN
  UPDATE core.ops_write_actions SET status='expired',safe_result_code='expired' WHERE business_id=p_business_id AND id=p_action_id RETURNING * INTO r;
 ELSIF r.status='previewed' THEN
  UPDATE core.ops_write_actions SET status='approved',approved_by=auth.uid(),approved_at=clock_timestamp(),safe_result_code='approved'
  WHERE business_id=p_business_id AND id=p_action_id RETURNING * INTO r;
 END IF;
 -- Repeated approve returns the same receipt, never extends its expiry or reopens it.
 RETURN core.ops_write_receipt(r);
END; $$;
CREATE FUNCTION public.ops_write_status(p_business_id uuid,p_action_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.ops_write_actions;
BEGIN
 IF NOT core.ops_write_authorized(p_business_id,auth.uid()) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM core.ops_write_actions WHERE business_id=p_business_id AND id=p_action_id AND created_by=auth.uid();
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 RETURN core.ops_write_receipt(r);
END; $$;
CREATE FUNCTION public.ops_write_claim(p_business_id uuid,p_action_id uuid,p_staff_id uuid,p_target_id uuid,p_preview_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.ops_write_actions;
BEGIN
 PERFORM core.ops_write_check(p_business_id,p_staff_id);
 SELECT * INTO r FROM core.ops_write_actions WHERE business_id=p_business_id AND id=p_action_id AND approved_by=p_staff_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 IF r.target_id<>p_target_id OR r.preview_hash<>p_preview_hash THEN RAISE EXCEPTION 'repreview_required' USING ERRCODE='22023'; END IF;
 IF r.status<>'approved' THEN RETURN NULL; END IF;
 IF r.expires_at<=clock_timestamp() THEN
  UPDATE core.ops_write_actions SET status='expired',safe_result_code='expired' WHERE business_id=p_business_id AND id=p_action_id;
  RETURN NULL;
 END IF;
 UPDATE core.ops_write_actions SET status='executing',claim_token=gen_random_uuid(),safe_result_code='executing'
 WHERE business_id=p_business_id AND id=p_action_id RETURNING * INTO r;
 RETURN core.ops_write_receipt(r)||jsonb_build_object('claim_token',r.claim_token);
END; $$;
CREATE FUNCTION public.ops_write_finalize(p_business_id uuid,p_action_id uuid,p_staff_id uuid,p_claim_token uuid,p_success boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.ops_write_actions; enabled boolean;
BEGIN
 IF NOT core.ops_write_authorized(p_business_id,p_staff_id) THEN RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
 SELECT NOT kill_switch INTO enabled FROM core.ops_write_settings WHERE business_id=p_business_id FOR SHARE;
 UPDATE core.ops_write_actions SET status=CASE WHEN p_success AND coalesce(enabled,false) THEN 'succeeded' ELSE 'failed' END,
 safe_result_code=CASE WHEN NOT coalesce(enabled,false) THEN 'disabled' WHEN p_success THEN 'dry_run_succeeded' ELSE 'dry_run_failed' END,finished_at=clock_timestamp(),claim_token=NULL
 WHERE business_id=p_business_id AND id=p_action_id AND approved_by=p_staff_id AND status='executing' AND claim_token=p_claim_token RETURNING * INTO r;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN core.ops_write_receipt(r);
END; $$;
REVOKE ALL ON FUNCTION core.ops_write_authorized(uuid,uuid),core.ops_write_receipt(core.ops_write_actions),core.ops_write_check(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.ops_write_preview(uuid,uuid,text,uuid),public.ops_write_approve(uuid,uuid,uuid,text),public.ops_write_status(uuid,uuid),public.ops_write_claim(uuid,uuid,uuid,uuid,text),public.ops_write_finalize(uuid,uuid,uuid,uuid,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ops_write_preview(uuid,uuid,text,uuid),public.ops_write_approve(uuid,uuid,uuid,text),public.ops_write_status(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ops_write_claim(uuid,uuid,uuid,uuid,text),public.ops_write_finalize(uuid,uuid,uuid,uuid,boolean) TO service_role;
COMMIT;
