-- K5 context: align the eligibility echo with klaviyo_profile_sync_eligible_v1.
-- Sira 24 lets a customer with a historical test signup and a later evidenced
-- genuine DOI become eligible, but this RPC still reported isTest=true for any
-- test signup, so the API rejected an eligible job (context_eligibility, logged
-- as provider_network). Only the isTest expression changes; the eligibility
-- check, payload, fingerprint, lease handling and grants are unchanged.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('profile_sync_context_mixed_history_v1',0));
DO $guard$ BEGIN
  IF pg_catalog.to_regprocedure('public.klaviyo_profile_sync_context_v1(uuid,uuid)') IS NULL
    OR pg_catalog.to_regprocedure('core.klaviyo_profile_sync_eligible_v1(uuid,uuid)') IS NULL
    OR pg_catalog.position('EXISTS(SELECT 1 FROM core.signups s WHERE s.customer_id=c.id AND s.is_test)' IN
      (SELECT prosrc FROM pg_catalog.pg_proc WHERE oid='public.klaviyo_profile_sync_context_v1(uuid,uuid)'::regprocedure))=0
    OR pg_catalog.position('vip_confirmation_evidence' IN
      (SELECT prosrc FROM pg_catalog.pg_proc WHERE oid='core.klaviyo_profile_sync_eligible_v1(uuid,uuid)'::regprocedure))=0 THEN
    RAISE EXCEPTION 'PROFILE_SYNC_CONTEXT_PREREQUISITES_REQUIRED';
  END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.klaviyo_profile_sync_context_v1(p_job_id uuid,p_lease_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE j core.klaviyo_profile_sync_jobs%ROWTYPE; v_payload jsonb; v_fp text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT * INTO j FROM core.klaviyo_profile_sync_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.status<>'running' OR p_lease_id IS NULL
    OR j.lease_id IS DISTINCT FROM p_lease_id OR j.lease_expires_at<=clock_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object('eligible',false,'reason','lease_expired',
      'status',COALESCE(j.status,'missing'));
  END IF;
  PERFORM 1 FROM core.customers WHERE id=j.customer_id AND business_id=j.business_id FOR UPDATE;
  IF NOT core.klaviyo_profile_sync_eligible_v1(j.business_id,j.customer_id) THEN
    UPDATE core.klaviyo_profile_sync_jobs SET status='blocked',lease_id=NULL,lease_expires_at=NULL,
      last_error_code='customer_ineligible',updated_at=clock_timestamp() WHERE id=j.id;
    RETURN pg_catalog.jsonb_build_object('eligible',false,'reason','customer_ineligible','status','blocked');
  END IF;
  v_payload:=core.klaviyo_profile_sync_payload_v1(j.business_id,j.customer_id);
  v_fp:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload::text,'UTF8')),'hex');
  IF v_fp<>j.payload_fingerprint THEN
    UPDATE core.klaviyo_profile_sync_jobs SET status='queued',payload_fingerprint=v_fp,
      email_fingerprint=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload->>'email','UTF8')),'hex'),
      attempts=0,lease_id=NULL,lease_expires_at=NULL,next_attempt_at=clock_timestamp(),
      last_error_code='payload_changed',updated_at=clock_timestamp() WHERE id=j.id;
    RETURN pg_catalog.jsonb_build_object('eligible',false,'reason','payload_changed','status','queued');
  END IF;
  RETURN pg_catalog.jsonb_build_object('eligible',true,'jobId',j.id,'businessId',j.business_id,
    'customerId',j.customer_id,'eligibility',(
      SELECT pg_catalog.jsonb_build_object('emailStatus',c.email_status,
        -- Signup-level test history is adjudicated by klaviyo_profile_sync_eligible_v1
        -- above (mixed-history DOI rule, sira 24); only the customer flag is echoed.
        'isTest',COALESCE((pg_catalog.to_jsonb(c)->>'is_test')::boolean,false),
        'suppressedAt',c.email_suppressed_at)
      FROM core.customers c WHERE c.id=j.customer_id AND c.business_id=j.business_id),
    'account',j.provider_account,'fingerprint',j.payload_fingerprint,
    'idempotencyKey','k5:'||j.id::text||':'||j.payload_fingerprint,'profile',v_payload);
END
$$;
REVOKE ALL ON FUNCTION public.klaviyo_profile_sync_context_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.klaviyo_profile_sync_context_v1(uuid,uuid) TO service_role;
COMMIT;
