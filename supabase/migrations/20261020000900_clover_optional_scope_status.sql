-- K7: expose unverified optional Clover fields in the closed-day report.
-- Apply after 20261020000700_clover_order_core.sql. No customer/order rows change.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('core.orders') IS NULL
    OR pg_catalog.to_regprocedure('public.clover_order_day_totals_v1(uuid,timestamptz,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'K7_ORDER_CORE_REQUIRED';
  END IF;
END $preflight$;

CREATE OR REPLACE FUNCTION public.clover_order_day_totals_v1(p_business_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
 SELECT CASE WHEN NOT public.crm_staff_authorized_v1()
   OR p_start IS NULL OR p_end IS NULL OR p_end<=p_start OR p_end>p_start+interval '1 day'
   THEN NULL ELSE
   (SELECT pg_catalog.jsonb_build_object('orderCount',count(*),'paidOrderCount',count(*) FILTER
       (WHERE s.paid_cents>0),'paidCents',COALESCE(sum(s.paid_cents),0),
       'refundedCents',COALESCE(sum(s.refunded_cents),0),'netCents',COALESCE(sum(s.net_cents),0),
       'refundUnverifiedCount',count(*) FILTER (WHERE o.raw_response->>'refundsVerified'='false'),
       'customerAccessDeniedCount',count(*) FILTER
         (WHERE o.online_order AND o.raw_response->>'customerAccess'='denied'),
       'reconciliationConfirmed',count(*) FILTER (WHERE o.raw_response->>'refundsVerified'='false')=0)
    FROM core.orders o CROSS JOIN LATERAL core.clover_order_status_v1(o.id) s
    WHERE o.business_id=p_business_id AND o.created_at>=p_start AND o.created_at<p_end) END
$$;

COMMIT;
