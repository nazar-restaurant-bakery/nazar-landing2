-- K16 PR 4 candidate (sequence 21, after staff workflow). No Data API table access.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('site_order_customer_confirmation_v1',0));

DO $guard$ BEGIN
  IF to_regclass('core.site_orders') IS NULL
    OR to_regclass('core.site_order_payments') IS NULL
    OR to_regprocedure('public.site_order_payment_confirm_v1(uuid,text,text,text,bigint,timestamp with time zone,jsonb)') IS NULL
    OR to_regprocedure('public.site_order_ticket_advance_v1(uuid,uuid,text,text)') IS NULL
  THEN RAISE EXCEPTION 'K16_SITE_ORDER_STAFF_REQUIRED'; END IF;
END $guard$;

CREATE TABLE core.site_order_customer_emails (
  business_id uuid NOT NULL,
  site_order_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('claimed','sent','failed')),
  provider_status text NOT NULL DEFAULT '',
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  PRIMARY KEY (business_id,site_order_id),
  FOREIGN KEY (site_order_id,business_id) REFERENCES core.site_orders(id,business_id),
  CHECK ((status='claimed' AND completed_at IS NULL) OR
    (status IN ('sent','failed') AND completed_at IS NOT NULL))
);
ALTER TABLE core.site_order_customer_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.site_order_customer_emails FROM PUBLIC,anon,authenticated,service_role;

-- The request UUID is generated in the customer's browser, kept only in that
-- browser, and is never returned from the status endpoint. Both UUIDs are
-- required; knowing an order ID alone does not reveal its state.
CREATE FUNCTION public.site_order_customer_status_v1(
  p_business_id uuid,p_site_order_id uuid,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object('status',o.status,'orderId',o.id,
    'requestedAt',o.requested_at,'totalCents',o.total_cents,
    'emailStatus',coalesce(e.status,'pending')) INTO v_result
  FROM core.site_orders o
  LEFT JOIN core.site_order_customer_emails e
    ON e.business_id=o.business_id AND e.site_order_id=o.id
  WHERE o.business_id=p_business_id AND o.id=p_site_order_id
    AND o.request_id=p_request_id;
  RETURN v_result;
END $$;

-- One claim per verified order. Ambiguous provider outcomes are left claimed
-- for staff review rather than risking duplicate customer email.
CREATE FUNCTION public.site_order_customer_email_claim_v1(
  p_business_id uuid,p_session_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  WITH eligible AS (
    SELECT o.id,o.business_id,o.customer_email,o.requested_at,o.total_cents,o.status
    FROM core.site_orders o
    JOIN core.site_order_payments p
      ON p.site_order_id=o.id AND p.business_id=o.business_id
    WHERE o.business_id=p_business_id AND p.checkout_session_id=p_session_id
      AND p.status='verified' AND p.clover_payment_id IS NOT NULL
      AND p.verified_cents=o.total_cents
      AND o.status IN ('paid','needs_reschedule')
      AND nullif(o.customer_email,'') IS NOT NULL
  ), claim AS (
    INSERT INTO core.site_order_customer_emails(business_id,site_order_id,status)
    SELECT business_id,id,'claimed' FROM eligible
    ON CONFLICT (business_id,site_order_id) DO NOTHING
    RETURNING site_order_id
  )
  SELECT jsonb_build_object('orderId',e.id,'email',e.customer_email,
    'requestedAt',e.requested_at,'totalCents',e.total_cents,'status',e.status)
    INTO v_result
  FROM eligible e JOIN claim c ON c.site_order_id=e.id;
  RETURN v_result;
END $$;

CREATE FUNCTION public.site_order_customer_email_finish_v1(
  p_business_id uuid,p_site_order_id uuid,p_sent boolean,p_provider_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  UPDATE core.site_order_customer_emails
    SET status=CASE WHEN p_sent THEN 'sent' ELSE 'failed' END,
      provider_status=left(coalesce(p_provider_status,''),32),
      completed_at=clock_timestamp()
  WHERE business_id=p_business_id AND site_order_id=p_site_order_id
    AND status='claimed';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count=1;
END $$;

REVOKE ALL ON FUNCTION public.site_order_customer_status_v1(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.site_order_customer_email_claim_v1(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.site_order_customer_email_finish_v1(uuid,uuid,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.site_order_customer_status_v1(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.site_order_customer_email_claim_v1(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.site_order_customer_email_finish_v1(uuid,uuid,boolean,text) TO service_role;
COMMIT;
