-- K11: private, append-only loyalty/referrals and observed platform metrics.
-- No activation seed, provider send, consent change, historical backfill or cron.
-- Same reviewed LF bytes test-first; operational order 9, after K9 (8).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('loyalty_referrals_metrics_v1',0));
DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('core.businesses') IS NULL
    OR pg_catalog.to_regclass('core.customers') IS NULL
    OR pg_catalog.to_regclass('core.business_staff') IS NULL
    OR pg_catalog.to_regclass('core.platform_operators') IS NULL
    OR pg_catalog.to_regprocedure('core.staff_authorized_v1(uuid,text)') IS NULL
    OR pg_catalog.to_regclass('core.offer_redemptions') IS NULL
    OR pg_catalog.to_regclass('core.message_log') IS NULL
    OR pg_catalog.to_regprocedure('core.clover_order_status_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'K11_REVIEWED_K6_K7_K9_REQUIRED';
  END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
    OR pg_catalog.current_setting('session_replication_role')<>'origin' THEN
    RAISE EXCEPTION 'K11_PRIVATE_CORE_AND_ORIGIN_REQUIRED';
  END IF;
END $preflight$;

CREATE TABLE core.loyalty_rules (
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  version integer NOT NULL CHECK(version>0),
  enabled boolean NOT NULL DEFAULT false,
  visits_per_order integer NOT NULL DEFAULT 1 CHECK(visits_per_order BETWEEN 1 AND 1000),
  effective_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(business_id,version)
);
CREATE TABLE core.loyalty_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  customer_id uuid NOT NULL,
  order_id uuid,
  entry_type text NOT NULL CHECK(entry_type IN('earn','redeem','adjust')),
  units bigint NOT NULL CHECK(units<>0),
  rule_version integer NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reason text NOT NULL CHECK(reason IN('paid_exact_order','order_no_longer_eligible','order_eligible_again','redemption')),
  FOREIGN KEY(customer_id,business_id) REFERENCES core.customers(id,business_id),
  FOREIGN KEY(order_id,business_id) REFERENCES core.orders(id,business_id),
  FOREIGN KEY(business_id,rule_version) REFERENCES core.loyalty_rules(business_id,version),
  CHECK((entry_type='earn' AND units>0 AND order_id IS NOT NULL AND reason='paid_exact_order')
    OR (entry_type='adjust' AND order_id IS NOT NULL AND reason IN('order_no_longer_eligible','order_eligible_again'))
    OR (entry_type='redeem' AND units<0 AND reason='redemption'))
);
CREATE UNIQUE INDEX loyalty_one_earn ON core.loyalty_ledger(business_id,order_id,customer_id)
  WHERE entry_type='earn';
CREATE INDEX loyalty_customer_history ON core.loyalty_ledger(business_id,customer_id,occurred_at);
CREATE TABLE core.referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  referrer_customer_id uuid NOT NULL,
  referral_code text NOT NULL CHECK(referral_code ~ '^[A-Za-z0-9_-]{4,80}$'),
  referred_customer_id uuid,
  first_order_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','completed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  FOREIGN KEY(referrer_customer_id,business_id) REFERENCES core.customers(id,business_id),
  FOREIGN KEY(referred_customer_id,business_id) REFERENCES core.customers(id,business_id),
  FOREIGN KEY(first_order_id,business_id) REFERENCES core.orders(id,business_id),
  UNIQUE(business_id,referral_code),
  UNIQUE(business_id,referred_customer_id),
  CHECK(referrer_customer_id IS DISTINCT FROM referred_customer_id),
  CHECK((status='pending' AND referred_customer_id IS NULL AND first_order_id IS NULL AND completed_at IS NULL)
    OR (status='completed' AND referred_customer_id IS NOT NULL AND first_order_id IS NOT NULL AND completed_at IS NOT NULL))
);
ALTER TABLE core.loyalty_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.loyalty_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.referrals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.loyalty_rules,core.loyalty_ledger,core.referrals
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION core.loyalty_no_change_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'K11_APPEND_ONLY_HISTORY' USING ERRCODE='42501'; END $$;
CREATE TRIGGER loyalty_rules_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON core.loyalty_rules
  FOR EACH STATEMENT EXECUTE FUNCTION core.loyalty_no_change_v1();
CREATE TRIGGER loyalty_ledger_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON core.loyalty_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION core.loyalty_no_change_v1();
CREATE TRIGGER referrals_no_remove BEFORE DELETE OR TRUNCATE ON core.referrals
  FOR EACH STATEMENT EXECUTE FUNCTION core.loyalty_no_change_v1();

CREATE FUNCTION core.loyalty_rule_guard_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE v_version integer; v_effective timestamptz;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.business_id::text,110));
  SELECT version,effective_from INTO v_version,v_effective FROM core.loyalty_rules
    WHERE business_id=NEW.business_id ORDER BY version DESC LIMIT 1;
  IF NEW.version<>COALESCE(v_version,0)+1 OR NEW.effective_from<COALESCE(v_effective,NEW.effective_from) THEN
    RAISE EXCEPTION 'K11_RULE_VERSION_ORDER' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER loyalty_rule_guard BEFORE INSERT ON core.loyalty_rules
  FOR EACH ROW EXECUTE FUNCTION core.loyalty_rule_guard_v1();

-- Timestamp evidence only; financial status continues to come exclusively
-- from K7. Order creation is never substituted for a missing payment date.
CREATE FUNCTION core.loyalty_paid_at_v1(p_order_id uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT CASE WHEN count(*)>0 AND count(*)=count(p.created_at) THEN min(p.created_at) END
    FROM core.payments p WHERE p.order_id=p_order_id AND upper(COALESCE(p.payment_status,''))='SUCCESS' AND p.amount_cents>0
$$;

CREATE FUNCTION core.loyalty_referral_guard_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF TG_OP='UPDATE' AND (ROW(NEW.id,NEW.business_id,NEW.referrer_customer_id,NEW.referral_code,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.business_id,OLD.referrer_customer_id,OLD.referral_code,OLD.created_at)
      OR OLD.status='completed') THEN
    RAISE EXCEPTION 'K11_REFERRAL_HISTORY_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  IF NEW.status='completed' AND NOT EXISTS(
    SELECT 1 FROM core.orders o CROSS JOIN LATERAL core.clover_order_status_v1(o.id) s
    WHERE o.id=NEW.first_order_id AND o.business_id=NEW.business_id
      AND o.customer_id=NEW.referred_customer_id AND o.match_status='exact' AND s.status='paid'
      AND core.loyalty_paid_at_v1(o.id) IS NOT NULL
      AND o.raw_response->>'referralCode'=NEW.referral_code
      AND NOT EXISTS(SELECT 1 FROM core.orders prev CROSS JOIN LATERAL core.clover_order_status_v1(prev.id) ps
        WHERE prev.business_id=o.business_id AND prev.customer_id=o.customer_id AND prev.match_status='exact'
          AND ps.paid_cents>0 AND (core.loyalty_paid_at_v1(prev.id) IS NULL OR
            (core.loyalty_paid_at_v1(prev.id),prev.id)<(core.loyalty_paid_at_v1(o.id),o.id)))) THEN
    RAISE EXCEPTION 'K11_REFERRAL_EXACT_FIRST_PAID_REQUIRED' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER loyalty_referral_guard BEFORE INSERT OR UPDATE ON core.referrals
  FOR EACH ROW EXECUTE FUNCTION core.loyalty_referral_guard_v1();

CREATE FUNCTION core.loyalty_order_process_v1(p_business_id uuid,p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE o core.orders%ROWTYPE; r core.loyalty_rules%ROWTYPE; s record; prior record;
  v_target bigint:=0; v_total bigint:=0; v_earned bigint:=0; v_done boolean:=false; v_reason text; v_paid_at timestamptz;
BEGIN
  -- Row-first matches K7 ingest's existing lock order. A separate advisory
  -- order lock here would invert that order against a deferred ingest commit.
  SELECT * INTO o FROM core.orders WHERE id=p_order_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'K11_ORDER_NOT_FOUND' USING ERRCODE='22023'; END IF;
  SELECT * INTO s FROM core.clover_order_status_v1(o.id);
  v_paid_at:=core.loyalty_paid_at_v1(o.id);
  -- Once earned, the original rule stays attached to that order. A later rule
  -- never rewrites visits already earned, nor revokes them just by disabling.
  SELECT lr.* INTO r FROM core.loyalty_ledger l JOIN core.loyalty_rules lr
    ON lr.business_id=l.business_id AND lr.version=l.rule_version
    WHERE l.business_id=p_business_id AND l.order_id=o.id AND l.entry_type='earn'
      AND l.customer_id=o.customer_id ORDER BY l.occurred_at,l.id LIMIT 1;
  IF NOT FOUND THEN
    SELECT * INTO r FROM core.loyalty_rules WHERE business_id=p_business_id AND effective_from<=v_paid_at
      ORDER BY version DESC LIMIT 1;
  END IF;
  IF s.status='paid' AND v_paid_at IS NOT NULL AND o.match_status='exact' AND o.customer_id IS NOT NULL AND r.enabled THEN
    v_target:=r.visits_per_order;
  END IF;
  -- A changed/ambiguous customer link reverses the old person's balance by a
  -- new row. The K7 matcher remains the sole identity authority.
  FOR prior IN SELECT l.customer_id,l.rule_version,sum(l.units)::bigint AS units
    FROM core.loyalty_ledger l WHERE l.business_id=p_business_id AND l.order_id=o.id
    GROUP BY l.customer_id,l.rule_version LOOP
    IF prior.customer_id IS DISTINCT FROM o.customer_id OR v_target=0 THEN
      IF prior.units<>0 THEN INSERT INTO core.loyalty_ledger(business_id,customer_id,order_id,entry_type,units,rule_version,reason)
        VALUES(p_business_id,prior.customer_id,o.id,'adjust',-prior.units,prior.rule_version,'order_no_longer_eligible'); END IF;
    END IF;
  END LOOP;
  IF v_target>0 THEN
    SELECT COALESCE(sum(units),0) INTO v_total FROM core.loyalty_ledger
      WHERE business_id=p_business_id AND order_id=o.id AND customer_id=o.customer_id;
    IF NOT EXISTS(SELECT 1 FROM core.loyalty_ledger WHERE business_id=p_business_id AND order_id=o.id
      AND customer_id=o.customer_id AND entry_type='earn') THEN
      INSERT INTO core.loyalty_ledger(business_id,customer_id,order_id,entry_type,units,rule_version,reason)
        VALUES(p_business_id,o.customer_id,o.id,'earn',v_target,r.version,'paid_exact_order');
      v_earned:=v_target;
    ELSIF v_total<>v_target THEN
      INSERT INTO core.loyalty_ledger(business_id,customer_id,order_id,entry_type,units,rule_version,reason)
        VALUES(p_business_id,o.customer_id,o.id,'adjust',v_target-v_total,r.version,'order_eligible_again');
    END IF;
  END IF;
  -- Referral completion does not require an enabled loyalty rule. A code is a
  -- single pending invitation; there is no distribution or consent workflow.
  IF s.status='paid' AND v_paid_at IS NOT NULL AND o.match_status='exact' AND o.customer_id IS NOT NULL
    AND o.raw_response->>'referralCode' ~ '^[A-Za-z0-9_-]{4,80}$' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_business_id::text||':'||o.customer_id::text,112));
    IF NOT EXISTS(SELECT 1 FROM core.orders prev CROSS JOIN LATERAL core.clover_order_status_v1(prev.id) ps
      WHERE prev.business_id=p_business_id AND prev.customer_id=o.customer_id AND prev.match_status='exact'
        AND ps.paid_cents>0 AND (core.loyalty_paid_at_v1(prev.id) IS NULL OR
          (core.loyalty_paid_at_v1(prev.id),prev.id)<(v_paid_at,o.id))) THEN
      UPDATE core.referrals SET referred_customer_id=o.customer_id,first_order_id=o.id,status='completed',completed_at=clock_timestamp()
        WHERE business_id=p_business_id AND referral_code=o.raw_response->>'referralCode' AND status='pending'
          AND referrer_customer_id<>o.customer_id
          AND NOT EXISTS(SELECT 1 FROM core.referrals used WHERE used.business_id=p_business_id AND used.referred_customer_id=o.customer_id);
      v_done:=FOUND;
    END IF;
  END IF;
  SELECT COALESCE(sum(units),0) INTO v_total FROM core.loyalty_ledger WHERE business_id=p_business_id AND order_id=o.id;
  v_reason:=CASE WHEN o.match_status<>'exact' THEN 'match_not_exact'
    WHEN s.paid_cents>0 AND v_paid_at IS NULL THEN 'payment_time_unknown' WHEN r.version IS NULL OR NOT r.enabled THEN 'rules_disabled'
    WHEN s.status<>'paid' THEN 'order_not_paid' ELSE NULL END;
  RETURN pg_catalog.jsonb_build_object('ok',true,'order_id',o.id,'status',s.status,'earned_units',v_earned,
    'net_units',v_total,'referral_completed',v_done,'reason',v_reason);
END $$;
CREATE FUNCTION public.loyalty_order_process_v1(p_business_id uuid,p_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  RETURN core.loyalty_order_process_v1(p_business_id,p_order_id);
END $$;
CREATE FUNCTION core.loyalty_ingest_deferred_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  -- Deferred until the full K7/K8 transaction has finished; never award from
  -- an intermediate order before its payments/refunds/match are present.
  IF TG_TABLE_NAME='orders' THEN
    IF TG_OP='DELETE' THEN RETURN NULL; END IF;
    PERFORM core.loyalty_order_process_v1(NEW.business_id,NEW.id);
  ELSE
    IF TG_OP='DELETE' THEN PERFORM core.loyalty_order_process_v1(OLD.business_id,OLD.order_id);
    ELSE PERFORM core.loyalty_order_process_v1(NEW.business_id,NEW.order_id); END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER loyalty_after_order AFTER INSERT OR UPDATE ON core.orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.loyalty_ingest_deferred_v1();
CREATE CONSTRAINT TRIGGER loyalty_after_payment AFTER INSERT OR UPDATE OR DELETE ON core.payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.loyalty_ingest_deferred_v1();
CREATE CONSTRAINT TRIGGER loyalty_after_refund AFTER INSERT OR UPDATE OR DELETE ON core.refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.loyalty_ingest_deferred_v1();

CREATE FUNCTION public.loyalty_metrics_v1(p_business_id uuid,p_month date,p_include_tests boolean DEFAULT false)
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

  SELECT COALESCE(jsonb_agg(jsonb_build_object('campaign_id',ca.id,'name',ca.name,'applied',x.applied,
    'repeat_30d',jsonb_build_object('known',x.mature>0 AND x.uncertain=0,
      'numerator',CASE WHEN x.mature>0 AND x.uncertain=0 THEN x.repeated END,
      'denominator',CASE WHEN x.mature>0 AND x.uncertain=0 THEN x.mature END,
      'rate',CASE WHEN x.mature>0 AND x.uncertain=0 THEN x.repeated::numeric/x.mature END,
      'reason',CASE WHEN x.uncertain>0 THEN 'repeat_payment_time_unknown'
        WHEN x.recent>0 THEN 'recent_cohorts_incomplete_observed_history_only'
        WHEN x.mature=0 THEN 'no_mature_30d_cohort' ELSE 'observed_history_only' END)) ORDER BY ca.name,ca.id),'[]'::jsonb)
    INTO v_campaigns FROM core.campaigns ca CROSS JOIN LATERAL (
      SELECT count(*) AS applied,count(*) FILTER(WHERE rr.applied_at<=v_now-interval '30 days') AS mature,
        count(*) FILTER(WHERE rr.applied_at>v_now-interval '30 days') AS recent,
        count(*) FILTER(WHERE rr.applied_at<=v_now-interval '30 days' AND EXISTS(
          SELECT 1 FROM core.orders untimed CROSS JOIN LATERAL core.clover_order_status_v1(untimed.id) uts
          WHERE untimed.business_id=p_business_id AND untimed.customer_id=rr.customer_id AND untimed.match_status='exact'
            AND untimed.id<>rr.order_id AND uts.paid_cents>0 AND core.loyalty_paid_at_v1(untimed.id) IS NULL
            AND (p_include_tests OR (untimed.raw_response->'is_test' IS DISTINCT FROM 'true'::jsonb
              AND untimed.raw_response->'isTest' IS DISTINCT FROM 'true'::jsonb)))) AS uncertain,
        count(*) FILTER(WHERE rr.applied_at<=v_now-interval '30 days' AND EXISTS(
          SELECT 1 FROM core.orders ro CROSS JOIN LATERAL core.clover_order_status_v1(ro.id) rs
          WHERE ro.business_id=p_business_id AND ro.customer_id=rr.customer_id AND ro.match_status='exact'
            AND ro.id<>rr.order_id AND core.loyalty_paid_at_v1(ro.id)>rr.applied_at
            AND core.loyalty_paid_at_v1(ro.id)<=rr.applied_at+interval '30 days'
            AND rs.status='paid' AND (p_include_tests OR (ro.raw_response->'is_test' IS DISTINCT FROM 'true'::jsonb
              AND ro.raw_response->'isTest' IS DISTINCT FROM 'true'::jsonb)))) AS repeated
      FROM core.offer_redemptions rr JOIN core.customers rc ON rc.id=rr.customer_id AND rc.business_id=rr.business_id
      JOIN core.orders source_order ON source_order.id=rr.order_id AND source_order.business_id=rr.business_id
      WHERE rr.business_id=p_business_id AND rr.campaign_id=ca.id AND rr.status='applied'
        AND rr.applied_at>=v_start AND rr.applied_at<v_end
        AND (p_include_tests OR (NOT COALESCE((to_jsonb(rc)->>'is_test')::boolean,false)
          AND source_order.raw_response->'is_test' IS DISTINCT FROM 'true'::jsonb
          AND source_order.raw_response->'isTest' IS DISTINCT FROM 'true'::jsonb))
    ) x WHERE ca.business_id=p_business_id AND (p_include_tests OR NOT ca.is_test);
  v_campaign_known:=jsonb_array_length(v_campaigns)>0 AND (v_known OR EXISTS(
    SELECT 1 FROM core.offer_redemptions rr JOIN core.campaigns ca ON ca.id=rr.campaign_id AND ca.business_id=rr.business_id
      JOIN core.customers rc ON rc.id=rr.customer_id AND rc.business_id=rr.business_id
      JOIN core.orders source_order ON source_order.id=rr.order_id AND source_order.business_id=rr.business_id
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

ALTER TABLE core.loyalty_rules ENABLE ALWAYS TRIGGER loyalty_rules_immutable;
ALTER TABLE core.loyalty_rules ENABLE ALWAYS TRIGGER loyalty_rule_guard;
ALTER TABLE core.loyalty_ledger ENABLE ALWAYS TRIGGER loyalty_ledger_immutable;
ALTER TABLE core.referrals ENABLE ALWAYS TRIGGER referrals_no_remove;
ALTER TABLE core.referrals ENABLE ALWAYS TRIGGER loyalty_referral_guard;
ALTER TABLE core.orders ENABLE ALWAYS TRIGGER loyalty_after_order;
ALTER TABLE core.payments ENABLE ALWAYS TRIGGER loyalty_after_payment;
ALTER TABLE core.refunds ENABLE ALWAYS TRIGGER loyalty_after_refund;
REVOKE ALL ON FUNCTION core.loyalty_no_change_v1(),core.loyalty_rule_guard_v1(),core.loyalty_referral_guard_v1(),
  core.loyalty_paid_at_v1(uuid),
  core.loyalty_order_process_v1(uuid,uuid),core.loyalty_ingest_deferred_v1(),public.loyalty_order_process_v1(uuid,uuid),
  public.loyalty_metrics_v1(uuid,date,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.loyalty_order_process_v1(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.loyalty_metrics_v1(uuid,date,boolean) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
