-- Proposed order 17, after order 16; aggregate reads only. No seed, send, job or new secret.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF to_regclass('core.ops_metrics') IS NULL OR to_regclass('core.vip_confirmation_evidence') IS NULL
 OR to_regclass('core.campaign_coupons') IS NULL OR to_regprocedure('core.staff_authorized_v1(uuid,text)') IS NULL
 OR NOT COALESCE((SELECT prosrc LIKE '%staff_attested%' FROM pg_proc WHERE oid=to_regprocedure('public.loyalty_metrics_v1(uuid,date,boolean)')),false)
 THEN RAISE EXCEPTION 'QR_FUNNEL_REQUIRES_K10_K11_ORDER16'; END IF;
END $guard$;
CREATE FUNCTION public.qr_vip_funnel_v1(p_business_id uuid,p_month date,p_include_tests boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE tz text; from_at timestamptz; until_at timestamptz; now_at timestamptz:=statement_timestamp();
 sessions numeric; snapshot_at timestamptz; registrations bigint; confirmations bigint; coupons bigint;
 linked bigint; attested bigint; mature bigint; repeated bigint; uncertain bigint;
BEGIN
 IF auth.role() IS DISTINCT FROM 'authenticated' OR NOT core.staff_authorized_v1(p_business_id,'loyalty.read')
 THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 IF p_month IS NULL OR p_month<>date_trunc('month',p_month::timestamp)::date OR p_include_tests IS NULL
 THEN RAISE EXCEPTION 'QR_MONTH_START_REQUIRED' USING ERRCODE='22023'; END IF;
 SELECT timezone INTO tz FROM core.businesses WHERE id=p_business_id;
 IF tz IS NULL OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=tz)
 THEN RAISE EXCEPTION 'QR_BUSINESS_TIMEZONE_REQUIRED' USING ERRCODE='22023'; END IF;
 from_at:=p_month::timestamp AT TIME ZONE tz;
 until_at:=LEAST((p_month+interval '1 month')::timestamp AT TIME ZONE tz,(now_at AT TIME ZONE tz)::date::timestamp AT TIME ZONE tz);
 -- Only completed local days enter the signup cohort; later evidence/conversion is observed through now.
 WITH cohort AS (
  SELECT s.id,s.customer_id FROM core.signups s
  JOIN core.customers c ON c.id=s.customer_id AND c.business_id=s.business_id
  WHERE s.business_id=p_business_id AND s.source IN('website_vip_page','website_vip_form') AND s.consent_email
   AND s.created_at>=from_at AND s.created_at<until_at
   AND s.utm->>'utm_source'='qr' AND s.utm->>'utm_medium'='offline' AND s.utm->>'utm_campaign'='qr_paket'
   AND (p_include_tests OR (NOT s.is_test AND NOT c.is_test))
 ), evidence AS (
  SELECT e.id,e.customer_id FROM core.vip_confirmation_evidence e JOIN cohort s ON s.id=e.signup_id AND s.customer_id=e.customer_id
  WHERE e.business_id=p_business_id AND e.confirmed_at<=now_at
 ), earned AS (
  SELECT cp.* FROM core.campaign_coupons cp JOIN evidence e ON e.id=cp.confirmation_evidence_id AND e.customer_id=cp.customer_id
  JOIN core.campaigns ca ON ca.id=cp.campaign_id AND ca.business_id=cp.business_id
  WHERE cp.business_id=p_business_id AND ca.campaign_kind='signup_reward' AND ca.benefit_code='SIMIT'
   AND cp.issued_at<=now_at AND (p_include_tests OR (NOT cp.is_test AND NOT ca.is_test))
 ), used AS (
  SELECT rr.* FROM core.offer_redemptions rr JOIN earned cp ON cp.id=rr.coupon_id AND cp.business_id=rr.business_id
   AND cp.campaign_id=rr.campaign_id AND cp.customer_id=rr.customer_id
  LEFT JOIN core.orders o ON o.id=rr.order_id AND o.business_id=rr.business_id
  WHERE rr.business_id=p_business_id AND rr.status='applied' AND rr.applied_at<=now_at
   AND (p_include_tests OR (o.raw_response->'is_test' IS DISTINCT FROM 'true'::jsonb AND o.raw_response->'isTest' IS DISTINCT FROM 'true'::jsonb))
 ) SELECT (SELECT count(DISTINCT customer_id) FROM cohort),(SELECT count(DISTINCT customer_id) FROM evidence),
  (SELECT count(*) FROM earned),count(*) FILTER(WHERE u.order_id IS NOT NULL),count(*) FILTER(WHERE u.order_id IS NULL),
  count(*) FILTER(WHERE u.order_id IS NOT NULL AND u.applied_at<=now_at-interval '30 days'),
  count(*) FILTER(WHERE u.order_id IS NOT NULL AND u.applied_at<=now_at-interval '30 days' AND EXISTS(
   SELECT 1 FROM core.orders o CROSS JOIN LATERAL core.clover_order_status_v1(o.id) st
   WHERE o.business_id=p_business_id AND o.customer_id=u.customer_id AND o.id<>u.order_id AND o.match_status='exact' AND st.status='paid'
    AND core.loyalty_paid_at_v1(o.id)>u.applied_at AND core.loyalty_paid_at_v1(o.id)<=u.applied_at+interval '30 days'
    AND (p_include_tests OR (o.raw_response->'is_test' IS DISTINCT FROM 'true'::jsonb AND o.raw_response->'isTest' IS DISTINCT FROM 'true'::jsonb)))),
  count(*) FILTER(WHERE u.order_id IS NOT NULL AND u.applied_at<=now_at-interval '30 days' AND EXISTS(
   SELECT 1 FROM core.orders o CROSS JOIN LATERAL core.clover_order_status_v1(o.id) st
   WHERE o.business_id=p_business_id AND o.customer_id=u.customer_id AND o.id<>u.order_id AND o.match_status='exact' AND st.paid_cents>0
    AND core.loyalty_paid_at_v1(o.id) IS NULL
    AND (p_include_tests OR (o.raw_response->'is_test' IS DISTINCT FROM 'true'::jsonb AND o.raw_response->'isTest' IS DISTINCT FROM 'true'::jsonb))))
 INTO registrations,confirmations,coupons,linked,attested,mature,repeated,uncertain FROM used u;
 -- Exact property-verified snapshot period; test cohorts must never borrow real GA4 sessions.
 IF NOT p_include_tests AND tz='America/New_York' AND until_at>from_at THEN
  SELECT value_num,collected_at INTO sessions,snapshot_at FROM core.ops_metrics
  WHERE business_id=p_business_id AND source='ga4' AND metric='qr_paket_sessions_mtd' AND NOT is_test
   AND period_start=p_month AND period_end=(until_at AT TIME ZONE tz)::date-1
   AND collected_at<=now_at AND collected_at>=now_at-interval '26 hours'
  ORDER BY collected_at DESC,id DESC LIMIT 1;
 END IF;
 RETURN jsonb_build_object('version',1,'business_id',p_business_id,'month',p_month,'timezone',tz,'include_tests',p_include_tests,
  'cohort_end_exclusive',until_at,'observed_at',now_at,'source','qr/offline/qr_paket','coupon_scope','signup_reward:SIMIT',
  'sessions',sessions,'sessions_checked_at',snapshot_at,'registrations',registrations,'confirmed',confirmations,'coupons',coupons,
  'order_linked',linked,'staff_attested',attested,'used',linked+attested,
  'repeat_30d',jsonb_build_object('known',mature>0 AND uncertain=0,'numerator',CASE WHEN mature>0 AND uncertain=0 THEN repeated END,
   'denominator',CASE WHEN mature>0 AND uncertain=0 THEN mature END,'rate',CASE WHEN mature>0 AND uncertain=0 THEN repeated::numeric/mature END));
END $$;
REVOKE ALL ON FUNCTION public.qr_vip_funnel_v1(uuid,date,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.qr_vip_funnel_v1(uuid,date,boolean) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
