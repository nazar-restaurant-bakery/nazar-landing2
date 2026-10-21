-- Order 16 proposed: count every applied campaign use; preserve order-only repeat cohort.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ops_campaign_usage_split_v1',0));
DO $guard$ BEGIN
 IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('public.loyalty_metrics_v1(uuid,date,boolean)')) IS DISTINCT FROM 'a079e2b0649fbc285867ada1550e41c6'
 THEN RAISE EXCEPTION 'K10_USAGE_PREDECESSOR_REVIEW_REQUIRED'; END IF;
END $guard$;
CREATE OR REPLACE FUNCTION public.loyalty_metrics_v1(p_business_id uuid,p_month date,p_include_tests boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_tz text; v_start timestamptz; v_end timestamptz; v_now timestamptz:=statement_timestamp(); v_campaign_known boolean;
  v_known boolean; v_new bigint; v_repeat bigint; v_campaigns jsonb; v_sent bigint; v_message_known boolean;
  v_attributed bigint; v_attribution_known boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated'
    OR NOT core.staff_authorized_v1(p_business_id,'loyalty.read') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF p_month IS NULL OR p_month<>date_trunc('month',p_month::timestamp)::date OR p_include_tests IS NULL THEN
    RAISE EXCEPTION 'K11_MONTH_START_REQUIRED' USING ERRCODE='22023';
  END IF;
  SELECT b.timezone INTO v_tz FROM core.businesses b WHERE b.id=p_business_id;
  IF v_tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=v_tz) THEN
    RAISE EXCEPTION 'K11_BUSINESS_TIMEZONE_REQUIRED' USING ERRCODE='22023';
  END IF;
  v_start:=p_month::timestamp AT TIME ZONE v_tz;
  v_end:=(p_month+interval '1 month')::timestamp AT TIME ZONE v_tz;
  WITH paid AS (
    SELECT o.id,o.customer_id,core.loyalty_paid_at_v1(o.id) AS paid_at,s.status,
      row_number() OVER(PARTITION BY o.customer_id ORDER BY core.loyalty_paid_at_v1(o.id),o.id) AS n
    FROM core.orders o JOIN core.customers c ON c.id=o.customer_id AND c.business_id=o.business_id
    CROSS JOIN LATERAL core.clover_order_status_v1(o.id) s
    WHERE o.business_id=p_business_id AND o.match_status='exact' AND s.paid_cents>0
      AND core.loyalty_paid_at_v1(o.id) IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM core.orders unknown_order CROSS JOIN LATERAL core.clover_order_status_v1(unknown_order.id) us
        WHERE unknown_order.business_id=p_business_id AND unknown_order.customer_id=o.customer_id
          AND unknown_order.match_status='exact' AND us.paid_cents>0 AND core.loyalty_paid_at_v1(unknown_order.id) IS NULL
          AND (p_include_tests OR (unknown_order.raw_response->'is_test' IS DISTINCT FROM 'true'::jsonb
            AND unknown_order.raw_response->'isTest' IS DISTINCT FROM 'true'::jsonb)))
      AND (p_include_tests OR (NOT COALESCE((to_jsonb(c)->>'is_test')::boolean,false)
        AND o.raw_response->'is_test' IS DISTINCT FROM 'true'::jsonb AND o.raw_response->'isTest' IS DISTINCT FROM 'true'::jsonb))
  ) SELECT count(*)>0,count(DISTINCT customer_id) FILTER(WHERE n=1),count(DISTINCT customer_id) FILTER(WHERE n>1)
    INTO v_known,v_new,v_repeat FROM paid WHERE status='paid' AND paid_at>=v_start AND paid_at<v_end;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('campaign_id',ca.id,'name',ca.name,'applied',x.applied,'order_linked',x.order_linked,'staff_attested',x.staff_attested,
    'repeat_30d',jsonb_build_object('known',x.mature>0 AND x.uncertain=0,
      'numerator',CASE WHEN x.mature>0 AND x.uncertain=0 THEN x.repeated END,
      'denominator',CASE WHEN x.mature>0 AND x.uncertain=0 THEN x.mature END,
      'rate',CASE WHEN x.mature>0 AND x.uncertain=0 THEN x.repeated::numeric/x.mature END,
      'reason',CASE WHEN x.uncertain>0 THEN 'repeat_payment_time_unknown'
        WHEN x.recent>0 THEN 'recent_cohorts_incomplete_observed_history_only'
        WHEN x.mature=0 THEN 'no_mature_30d_cohort' ELSE 'observed_history_only' END)) ORDER BY ca.name,ca.id),'[]'::jsonb)
    INTO v_campaigns FROM core.campaigns ca CROSS JOIN LATERAL (
      SELECT count(*) AS applied,count(*) FILTER(WHERE rr.order_id IS NOT NULL) AS order_linked,
        count(*) FILTER(WHERE rr.order_id IS NULL) AS staff_attested,
        count(*) FILTER(WHERE rr.order_id IS NOT NULL AND rr.applied_at<=v_now-interval '30 days') AS mature,
        count(*) FILTER(WHERE rr.order_id IS NOT NULL AND rr.applied_at>v_now-interval '30 days') AS recent,
        count(*) FILTER(WHERE rr.order_id IS NOT NULL AND rr.applied_at<=v_now-interval '30 days' AND EXISTS(
          SELECT 1 FROM core.orders untimed CROSS JOIN LATERAL core.clover_order_status_v1(untimed.id) uts
          WHERE untimed.business_id=p_business_id AND untimed.customer_id=rr.customer_id AND untimed.match_status='exact'
            AND untimed.id<>rr.order_id AND uts.paid_cents>0 AND core.loyalty_paid_at_v1(untimed.id) IS NULL
            AND (p_include_tests OR (untimed.raw_response->'is_test' IS DISTINCT FROM 'true'::jsonb
              AND untimed.raw_response->'isTest' IS DISTINCT FROM 'true'::jsonb)))) AS uncertain,
        count(*) FILTER(WHERE rr.order_id IS NOT NULL AND rr.applied_at<=v_now-interval '30 days' AND EXISTS(
          SELECT 1 FROM core.orders ro CROSS JOIN LATERAL core.clover_order_status_v1(ro.id) rs
          WHERE ro.business_id=p_business_id AND ro.customer_id=rr.customer_id AND ro.match_status='exact'
            AND ro.id<>rr.order_id AND core.loyalty_paid_at_v1(ro.id)>rr.applied_at
            AND core.loyalty_paid_at_v1(ro.id)<=rr.applied_at+interval '30 days'
            AND rs.status='paid' AND (p_include_tests OR (ro.raw_response->'is_test' IS DISTINCT FROM 'true'::jsonb
              AND ro.raw_response->'isTest' IS DISTINCT FROM 'true'::jsonb)))) AS repeated
      FROM core.offer_redemptions rr JOIN core.customers rc ON rc.id=rr.customer_id AND rc.business_id=rr.business_id
      LEFT JOIN core.orders source_order ON source_order.id=rr.order_id AND source_order.business_id=rr.business_id
      WHERE rr.business_id=p_business_id AND rr.campaign_id=ca.id AND rr.status='applied'
        AND rr.applied_at>=v_start AND rr.applied_at<v_end
        AND (p_include_tests OR (NOT COALESCE((to_jsonb(rc)->>'is_test')::boolean,false)
          AND source_order.raw_response->'is_test' IS DISTINCT FROM 'true'::jsonb
          AND source_order.raw_response->'isTest' IS DISTINCT FROM 'true'::jsonb))
    ) x WHERE ca.business_id=p_business_id AND (p_include_tests OR NOT ca.is_test);
  v_campaign_known:=jsonb_array_length(v_campaigns)>0 AND (v_known OR EXISTS(
    SELECT 1 FROM core.offer_redemptions rr JOIN core.campaigns ca ON ca.id=rr.campaign_id AND ca.business_id=rr.business_id
      JOIN core.customers rc ON rc.id=rr.customer_id AND rc.business_id=rr.business_id
      LEFT JOIN core.orders source_order ON source_order.id=rr.order_id AND source_order.business_id=rr.business_id
    WHERE rr.business_id=p_business_id AND rr.status='applied' AND rr.applied_at>=v_start AND rr.applied_at<v_end
      AND (p_include_tests OR (NOT ca.is_test AND NOT COALESCE((to_jsonb(rc)->>'is_test')::boolean,false)
        AND source_order.raw_response->'is_test' IS DISTINCT FROM 'true'::jsonb
        AND source_order.raw_response->'isTest' IS DISTINCT FROM 'true'::jsonb))));

  SELECT count(*)>0,count(*) FILTER(WHERE m.status='sent' AND m.sent_at>=v_start AND m.sent_at<v_end)
    INTO v_message_known,v_sent FROM core.message_log m JOIN core.customers c ON c.id=m.customer_id AND c.business_id=m.business_id
    WHERE m.business_id=p_business_id AND (p_include_tests OR NOT COALESCE((to_jsonb(c)->>'is_test')::boolean,false));
  -- Identity/time proximity alone is not attribution. Both exact identifiers
  -- must be captured on the order by a future reviewed connector; absent
  -- evidence is null, never a fabricated zero or a customer/profile payload.
  SELECT count(*)>0,count(DISTINCT o.id) INTO v_attribution_known,v_attributed
    FROM core.orders o JOIN core.customers c ON c.id=o.customer_id AND c.business_id=o.business_id
    CROSS JOIN LATERAL core.clover_order_status_v1(o.id) s
    JOIN core.message_log m ON m.business_id=o.business_id AND m.customer_id=o.customer_id
      AND m.id::text=o.raw_response#>>'{messageAttribution,messageId}'
      AND m.message_key=o.raw_response#>>'{messageAttribution,campaignCode}' AND m.status='sent'
    WHERE o.business_id=p_business_id AND o.match_status='exact' AND s.status='paid'
      AND core.loyalty_paid_at_v1(o.id)>=v_start AND core.loyalty_paid_at_v1(o.id)<v_end
      AND core.loyalty_paid_at_v1(o.id)>=m.sent_at AND core.loyalty_paid_at_v1(o.id)<=m.sent_at+interval '30 days'
      AND (p_include_tests OR (NOT COALESCE((to_jsonb(c)->>'is_test')::boolean,false)
        AND o.raw_response->'is_test' IS DISTINCT FROM 'true'::jsonb AND o.raw_response->'isTest' IS DISTINCT FROM 'true'::jsonb));
  RETURN jsonb_build_object('version',1,'business_id',p_business_id,'month',to_char(p_month,'YYYY-MM-DD'),
    'timezone',v_tz,'include_tests',p_include_tests,'generated_at',v_now,'coverage','observed_ingested_orders',
    'customer_counts',jsonb_build_object('known',v_known,'new',CASE WHEN v_known THEN v_new END,'repeat',CASE WHEN v_known THEN v_repeat END,
      'reason',CASE WHEN v_known THEN 'observed_history_only_new_repeat_can_overlap' ELSE 'no_observed_exact_paid_orders' END),
    'campaigns',jsonb_build_object('known',v_campaign_known,
      'items',CASE WHEN v_campaign_known THEN v_campaigns ELSE '[]'::jsonb END,
      'reason',CASE WHEN jsonb_array_length(v_campaigns)=0 THEN 'no_campaigns' WHEN NOT v_campaign_known THEN 'no_observed_campaign_evidence' ELSE 'observed_history_only' END),
    'messages',jsonb_build_object('known',v_message_known,'sent',CASE WHEN v_message_known THEN v_sent END,
      'reason',CASE WHEN v_message_known THEN 'observed_gate_log_only' ELSE 'no_message_log_evidence' END),
    'attribution',jsonb_build_object('known',v_attribution_known,'orders',CASE WHEN v_attribution_known THEN v_attributed END,
      'reason',CASE WHEN v_attribution_known THEN 'explicit_message_and_code_match_only' ELSE 'no_explicit_message_order_evidence' END));
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
