-- K7 follow-up: keep order counts on creation day and cash on transaction day.
-- Clover payment.amount excludes tipAmount; both fields are stored separately.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('core.orders') IS NULL
    OR pg_catalog.to_regclass('core.payments') IS NULL
    OR pg_catalog.to_regclass('core.refunds') IS NULL
    OR pg_catalog.to_regprocedure('public.clover_order_day_totals_v1(uuid,timestamptz,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'K7_ORDER_CORE_REQUIRED';
  END IF;
END $preflight$;

CREATE FUNCTION public.clover_order_day_summary_v2(p_business_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT CASE WHEN NOT public.crm_staff_authorized_v1()
    OR p_business_id IS NULL OR p_start IS NULL OR p_end IS NULL
    OR p_end<=p_start OR p_end>p_start+interval '25 hours' THEN NULL ELSE
    (WITH opened AS (
      SELECT count(*)::bigint AS order_count,
        count(*) FILTER (WHERE o.online_order AND o.raw_response->>'customerAccess'='denied')::bigint AS customer_denied
      FROM core.orders o
      WHERE o.business_id=p_business_id AND o.created_at>=p_start AND o.created_at<p_end
    ), paid AS (
      SELECT COALESCE(sum(p.amount_cents),0)::bigint AS amount_cents,
        COALESCE(sum(CASE WHEN p.raw_response->>'tipAmount' ~ '^[0-9]{1,12}$'
          THEN (p.raw_response->>'tipAmount')::bigint ELSE 0 END),0)::bigint AS tip_cents
      FROM core.payments p JOIN core.orders o ON o.id=p.order_id AND o.business_id=p.business_id
      WHERE p.business_id=p_business_id AND p.created_at>=p_start AND p.created_at<p_end
        AND pg_catalog.upper(COALESCE(p.payment_status,''))='SUCCESS'
    ), refunded AS (
      SELECT COALESCE(sum(r.amount_cents),0)::bigint AS amount_cents,
        COALESCE(sum(CASE WHEN r.raw_response->>'tipAmount' ~ '^[0-9]{1,12}$'
          THEN (r.raw_response->>'tipAmount')::bigint ELSE 0 END),0)::bigint AS tip_cents
      FROM core.refunds r
      WHERE r.business_id=p_business_id AND r.created_at>=p_start AND r.created_at<p_end
        AND COALESCE(r.raw_response->>'voided','false')<>'true'
    ), unverified AS (
      SELECT count(*)::bigint AS order_count FROM core.orders o
      WHERE o.business_id=p_business_id AND o.raw_response->>'refundsVerified'='false'
        AND (o.created_at>=p_start AND o.created_at<p_end OR EXISTS (
          SELECT 1 FROM core.payments p WHERE p.order_id=o.id AND p.business_id=p_business_id
            AND p.created_at>=p_start AND p.created_at<p_end))
    ), undated AS (
      SELECT (SELECT count(*) FROM core.payments p WHERE p.business_id=p_business_id
        AND p.created_at IS NULL AND pg_catalog.upper(COALESCE(p.payment_status,''))='SUCCESS')
        +(SELECT count(*) FROM core.refunds r WHERE r.business_id=p_business_id
          AND r.created_at IS NULL AND COALESCE(r.raw_response->>'voided','false')<>'true') AS event_count
    ) SELECT pg_catalog.jsonb_build_object(
      'orderCount',opened.order_count,
      'collectedCents',paid.amount_cents-refunded.amount_cents,
      'tipCents',paid.tip_cents-refunded.tip_cents,
      'refundUnverifiedCount',unverified.order_count,
      'undatedTransactionCount',undated.event_count,
      'customerAccessDeniedCount',opened.customer_denied,
      'reconciliationConfirmed',unverified.order_count=0 AND undated.event_count=0)
      FROM opened,paid,refunded,unverified,undated) END
$$;

REVOKE ALL ON FUNCTION public.clover_order_day_summary_v2(uuid,timestamptz,timestamptz)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.clover_order_day_summary_v2(uuid,timestamptz,timestamptz)
  TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
