-- K9: private campaign configuration and atomic, evidence-bound redemptions.
-- No send, consent write, provider call, activation seed, cron or public UI.
-- Apply reviewed LF bytes test-first, operationally after K8 (20261021000100).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('campaign_engine_v1',0));
DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('core.businesses') IS NULL
    OR pg_catalog.to_regclass('core.customers') IS NULL
    OR pg_catalog.to_regclass('core.offers') IS NULL
    OR pg_catalog.to_regclass('core.crm_staff') IS NULL
    OR pg_catalog.to_regclass('core.order_items') IS NULL
    OR pg_catalog.to_regclass('core.payments') IS NULL
    OR pg_catalog.to_regclass('core.refunds') IS NULL
    OR pg_catalog.to_regprocedure('core.clover_order_status_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'K9_REVIEWED_BASELINE_AND_K7_REQUIRED';
  END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
    OR pg_catalog.current_setting('session_replication_role')<>'origin' THEN
    RAISE EXCEPTION 'K9_PRIVATE_CORE_AND_ORIGIN_REQUIRED';
  END IF;
END $preflight$;

-- Additive parent keys prevent later tenant moves from stranding a child link.
CREATE UNIQUE INDEX k9_offers_id_business ON core.offers(id,business_id);
CREATE UNIQUE INDEX k9_customers_id_business ON core.customers(id,business_id);

CREATE TABLE core.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  offer_id uuid NOT NULL,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200 AND name ~ '[^[:space:]]'),
  benefit_type text NOT NULL CHECK(benefit_type IN('item','discount')),
  target_clover_item_id text CHECK(target_clover_item_id ~ '^[A-Za-z0-9]{8,32}$'),
  benefit_code text CHECK(length(btrim(benefit_code)) BETWEEN 1 AND 120 AND benefit_code ~ '[^[:space:]]'),
  clover_discount_id text CHECK(clover_discount_id ~ '^[A-Za-z0-9]{8,32}$'),
  discount_amount_cents bigint CHECK(discount_amount_cents BETWEEN 1 AND 999999999999),
  discount_percentage numeric(6,3) CHECK(discount_percentage>0 AND discount_percentage<=100),
  min_amount_cents bigint NOT NULL DEFAULT 0 CHECK(min_amount_cents BETWEEN 0 AND 999999999999),
  include_tax boolean NOT NULL DEFAULT false,
  include_tip boolean NOT NULL DEFAULT false,
  order_type_ids text[] NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  tz_name text NOT NULL DEFAULT 'UTC',
  weekdays smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
  local_start time,
  local_end time,
  eligibility text NOT NULL DEFAULT 'subscribed_only' CHECK(eligibility IN('subscribed_only','everyone')),
  max_units_per_order integer NOT NULL DEFAULT 1 CHECK(max_units_per_order BETWEEN 1 AND 1000),
  period text NOT NULL DEFAULT 'campaign' CHECK(period IN('week','campaign','unlimited')),
  max_total_units bigint CHECK(max_total_units BETWEEN 1 AND 999999999999),
  restore_on_full_refund boolean NOT NULL DEFAULT false,
  restore_on_partial_below_minimum boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','active','stopped')),
  schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,business_id),
  FOREIGN KEY(offer_id,business_id) REFERENCES core.offers(id,business_id),
  CHECK(ends_at>starts_at),
  CHECK((local_start IS NULL AND local_end IS NULL) OR
    (local_start IS NOT NULL AND local_end IS NOT NULL AND local_end>local_start)),
  CHECK((benefit_type='item' AND target_clover_item_id IS NOT NULL
      AND discount_amount_cents IS NULL AND discount_percentage IS NULL)
    OR (benefit_type='discount' AND max_units_per_order=1
      AND ((discount_amount_cents IS NOT NULL)::integer+(discount_percentage IS NOT NULL)::integer)=1))
);
CREATE TABLE core.offer_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  campaign_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  order_id uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source text NOT NULL CHECK(source IN('clover_trace','staff_mark')),
  staff_actor uuid,
  staff_note text,
  period_key text NOT NULL CHECK(length(period_key) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'applied' CHECK(status IN('applied','voided')),
  units integer NOT NULL CHECK(units BETWEEN 1 AND 1000),
  quota_reserved boolean NOT NULL DEFAULT true,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  voided_at timestamptz,
  void_reason text CHECK(void_reason IN('full_refund','partial_below_minimum')),
  FOREIGN KEY(campaign_id,business_id) REFERENCES core.campaigns(id,business_id),
  FOREIGN KEY(customer_id,business_id) REFERENCES core.customers(id,business_id),
  FOREIGN KEY(order_id,business_id) REFERENCES core.orders(id,business_id),
  UNIQUE(id,business_id,campaign_id),
  UNIQUE(campaign_id,order_id),
  CHECK((status='applied' AND quota_reserved AND voided_at IS NULL AND void_reason IS NULL)
    OR (status='voided' AND voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK((source='clover_trace' AND staff_actor IS NULL AND staff_note IS NULL)
    OR (source='staff_mark' AND staff_actor IS NOT NULL AND staff_note IS NOT NULL
      AND length(btrim(staff_note)) BETWEEN 1 AND 1000 AND staff_note ~ '[^[:space:]]'))
);
-- A non-restoring refund continues to reserve the original person/period and
-- global units. A restoring refund releases them without deleting history.
-- An unconditional UNIQUE would prevent the expressly configurable restoration.
CREATE UNIQUE INDEX offer_redemptions_person_period
  ON core.offer_redemptions(campaign_id,customer_id,period_key) WHERE quota_reserved;
CREATE INDEX offer_redemptions_total ON core.offer_redemptions(campaign_id) WHERE quota_reserved;
CREATE TABLE core.campaign_usage (
  campaign_id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  reserved_units bigint NOT NULL DEFAULT 0 CHECK(reserved_units>=0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(campaign_id,business_id) REFERENCES core.campaigns(id,business_id)
);
CREATE TABLE core.campaign_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  campaign_id uuid NOT NULL,
  redemption_id uuid,
  event_type text NOT NULL CHECK(event_type IN('created','activated','stopped','parameters_changed','applied','voided')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id uuid,
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
  FOREIGN KEY(campaign_id,business_id) REFERENCES core.campaigns(id,business_id),
  FOREIGN KEY(redemption_id,business_id,campaign_id) REFERENCES core.offer_redemptions(id,business_id,campaign_id)
);
ALTER TABLE core.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.offer_redemptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.campaign_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.campaign_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE core.campaigns,core.offer_redemptions,core.campaign_events,core.campaign_usage
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION core.campaign_no_remove_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'K9_HISTORY_IMMUTABLE' USING ERRCODE='42501'; END $$;
CREATE TRIGGER campaigns_no_remove BEFORE DELETE OR TRUNCATE ON core.campaigns
  FOR EACH STATEMENT EXECUTE FUNCTION core.campaign_no_remove_v1();
CREATE TRIGGER redemptions_no_remove BEFORE DELETE OR TRUNCATE ON core.offer_redemptions
  FOR EACH STATEMENT EXECUTE FUNCTION core.campaign_no_remove_v1();
CREATE TRIGGER campaign_events_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON core.campaign_events
  FOR EACH STATEMENT EXECUTE FUNCTION core.campaign_no_remove_v1();
CREATE TRIGGER campaign_usage_no_remove BEFORE DELETE OR TRUNCATE ON core.campaign_usage
  FOR EACH STATEMENT EXECUTE FUNCTION core.campaign_no_remove_v1();

CREATE FUNCTION core.campaign_config_guard_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE v_reserved numeric;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=NEW.tz_name)
    OR cardinality(NEW.weekdays) NOT BETWEEN 1 AND 7
    OR array_position(NEW.weekdays,NULL) IS NOT NULL
    OR EXISTS(SELECT 1 FROM unnest(NEW.weekdays) d WHERE d NOT BETWEEN 1 AND 7)
    OR cardinality(NEW.order_type_ids) NOT BETWEEN 1 AND 30
    OR array_position(NEW.order_type_ids,NULL) IS NOT NULL
    OR EXISTS(SELECT 1 FROM unnest(NEW.order_type_ids) t WHERE t !~ '^[A-Za-z0-9]{8,32}$') THEN
    RAISE EXCEPTION 'K9_INVALID_CAMPAIGN_WINDOW_OR_CHANNEL' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM core.offers WHERE id=NEW.offer_id AND business_id=NEW.business_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'K9_OFFER_TENANT_MISMATCH' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.business_id,NEW.created_at,NEW.schema_version) IS DISTINCT FROM
      ROW(OLD.id,OLD.business_id,OLD.created_at,OLD.schema_version) THEN
      RAISE EXCEPTION 'K9_CAMPAIGN_IDENTITY_IMMUTABLE' USING ERRCODE='42501'; END IF;
    SELECT reserved_units INTO STRICT v_reserved FROM core.campaign_usage WHERE campaign_id=OLD.id;
    IF NEW.max_total_units IS NOT NULL AND NEW.max_total_units<v_reserved THEN
      RAISE EXCEPTION 'K9_LIMIT_BELOW_RESERVED_UNITS' USING ERRCODE='23514'; END IF;
    -- A period/clock identity cannot be changed to bypass already consumed rights.
    IF EXISTS(SELECT 1 FROM core.offer_redemptions WHERE campaign_id=OLD.id)
      AND ROW(NEW.period,NEW.tz_name,NEW.offer_id,NEW.benefit_type,NEW.target_clover_item_id,
        NEW.benefit_code,NEW.clover_discount_id,NEW.is_test,NEW.discount_amount_cents,NEW.discount_percentage) IS DISTINCT FROM
        ROW(OLD.period,OLD.tz_name,OLD.offer_id,OLD.benefit_type,OLD.target_clover_item_id,
        OLD.benefit_code,OLD.clover_discount_id,OLD.is_test,OLD.discount_amount_cents,OLD.discount_percentage) THEN
      RAISE EXCEPTION 'K9_CONSUMED_PERIOD_IMMUTABLE' USING ERRCODE='23514'; END IF;
    NEW.version:=OLD.version+1;
    NEW.updated_at:=clock_timestamp();
  ELSE
    NEW.version:=1;
    NEW.created_at:=clock_timestamp();
    NEW.updated_at:=NEW.created_at;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaigns_config_guard BEFORE INSERT OR UPDATE ON core.campaigns
  FOR EACH ROW EXECUTE FUNCTION core.campaign_config_guard_v1();
CREATE FUNCTION core.campaign_config_event_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO core.campaign_usage(campaign_id,business_id) VALUES(NEW.id,NEW.business_id);
  END IF;
  INSERT INTO core.campaign_events(business_id,campaign_id,event_type,actor_id,payload)
  VALUES(NEW.business_id,NEW.id,CASE WHEN TG_OP='INSERT' THEN 'created' ELSE 'parameters_changed' END,
    auth.uid(),jsonb_build_object('schemaVersion',1,'version',NEW.version,'campaign',to_jsonb(NEW)));
  IF (TG_OP='INSERT' AND NEW.status='active') OR
    (TG_OP='UPDATE' AND NEW.status='active' AND OLD.status<>'active') THEN
    INSERT INTO core.campaign_events(business_id,campaign_id,event_type,actor_id,payload)
      VALUES(NEW.business_id,NEW.id,'activated',auth.uid(),jsonb_build_object('version',NEW.version));
  ELSIF TG_OP='UPDATE' AND NEW.status='stopped' AND OLD.status<>'stopped' THEN
    INSERT INTO core.campaign_events(business_id,campaign_id,event_type,actor_id,payload)
      VALUES(NEW.business_id,NEW.id,'stopped',auth.uid(),jsonb_build_object('version',NEW.version));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaigns_evidence AFTER INSERT OR UPDATE ON core.campaigns
  FOR EACH ROW EXECUTE FUNCTION core.campaign_config_event_v1();

CREATE FUNCTION core.campaign_redemption_guard_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE c core.campaigns%ROWTYPE; v_total numeric;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.id,NEW.business_id,NEW.campaign_id,NEW.customer_id,NEW.order_id,NEW.applied_at,
      NEW.source,NEW.staff_actor,NEW.staff_note,NEW.period_key,NEW.units,NEW.snapshot)
      IS DISTINCT FROM ROW(OLD.id,OLD.business_id,OLD.campaign_id,OLD.customer_id,OLD.order_id,
      OLD.applied_at,OLD.source,OLD.staff_actor,OLD.staff_note,OLD.period_key,OLD.units,OLD.snapshot)
      OR OLD.status<>'applied' OR NEW.status<>'voided'
      OR NEW.voided_at IS NULL OR NEW.void_reason IS NULL THEN
      RAISE EXCEPTION 'K9_REDEMPTION_IMMUTABLE' USING ERRCODE='42501'; END IF;
    IF NEW.quota_reserved IS DISTINCT FROM (NOT CASE NEW.void_reason
      WHEN 'full_refund' THEN (OLD.snapshot#>>'{campaign,restore_on_full_refund}')::boolean
      WHEN 'partial_below_minimum' THEN (OLD.snapshot#>>'{campaign,restore_on_partial_below_minimum}')::boolean END) THEN
      RAISE EXCEPTION 'K9_REFUND_POLICY_MISMATCH' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO c FROM core.campaigns WHERE id=NEW.campaign_id AND business_id=NEW.business_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'K9_CAMPAIGN_TENANT_MISMATCH' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM core.customers WHERE id=NEW.customer_id AND business_id=NEW.business_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'K9_CUSTOMER_TENANT_MISMATCH' USING ERRCODE='23514'; END IF;
  IF NEW.status<>'applied' OR NOT NEW.quota_reserved OR NEW.units>c.max_units_per_order
    OR NEW.snapshot->'campaign' IS DISTINCT FROM to_jsonb(c) THEN
    RAISE EXCEPTION 'K9_INVALID_REDEMPTION_LIMIT_OR_SNAPSHOT' USING ERRCODE='23514'; END IF;
  SELECT reserved_units INTO STRICT v_total FROM core.campaign_usage WHERE campaign_id=c.id;
  IF c.max_total_units IS NOT NULL AND v_total+NEW.units>c.max_total_units THEN
    RAISE EXCEPTION 'K9_TOTAL_LIMIT' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER offer_redemptions_guard BEFORE INSERT OR UPDATE ON core.offer_redemptions
  FOR EACH ROW EXECUTE FUNCTION core.campaign_redemption_guard_v1();

CREATE FUNCTION core.campaign_usage_guard_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF pg_catalog.pg_trigger_depth()<2 OR (TG_OP='UPDATE' AND
    ROW(NEW.campaign_id,NEW.business_id) IS DISTINCT FROM ROW(OLD.campaign_id,OLD.business_id)) THEN
    RAISE EXCEPTION 'K9_USAGE_COUNTER_ENGINE_ONLY' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campaign_usage_guard BEFORE INSERT OR UPDATE ON core.campaign_usage
  FOR EACH ROW EXECUTE FUNCTION core.campaign_usage_guard_v1();
CREATE FUNCTION core.campaign_usage_update_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  UPDATE core.campaign_usage SET reserved_units=reserved_units+
    CASE WHEN TG_OP='INSERT' THEN NEW.units
      WHEN OLD.quota_reserved AND NOT NEW.quota_reserved THEN -NEW.units ELSE 0 END,
    updated_at=clock_timestamp() WHERE campaign_id=NEW.campaign_id AND business_id=NEW.business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'K9_USAGE_COUNTER_MISSING'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER offer_redemptions_usage AFTER INSERT OR UPDATE ON core.offer_redemptions
  FOR EACH ROW EXECUTE FUNCTION core.campaign_usage_update_v1();

-- K7 net_cents is payment less refunds, not a tax-free merchandise value.
-- Exclusion needs explicit integral provider evidence for every relevant row.
-- Missing/null/negative/malformed evidence is unknown, never an implicit zero.
CREATE FUNCTION core.campaign_amount_v1(p_order_id uuid,p_include_tax boolean,p_include_tip boolean)
RETURNS TABLE(known boolean,amount_cents bigint,evidence jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE s record; p record; r record; v_tax numeric:=0; v_tip numeric:=0;
  v_ref_tax numeric:=0; v_ref_tip numeric:=0; t numeric; tip numeric;
BEGIN
  SELECT * INTO s FROM core.clover_order_status_v1(p_order_id);
  IF NOT FOUND THEN RETURN QUERY SELECT false,NULL::bigint,jsonb_build_object('reason','order_missing'); RETURN; END IF;
  -- K7 optional-scope reads can retain an empty array when refunds could not
  -- be read. Only an explicit JSON boolean true certifies that empty is zero.
  IF (SELECT o_.raw_response->'refundsVerified' FROM core.orders o_ WHERE o_.id=p_order_id)
    IS DISTINCT FROM 'true'::jsonb THEN
    RETURN QUERY SELECT false,NULL::bigint,jsonb_build_object('reason','refunds_unverified'); RETURN; END IF;
  FOR p IN SELECT pay_.amount_cents,pay_.raw_response FROM core.payments pay_ WHERE pay_.order_id=p_order_id
    AND upper(COALESCE(pay_.payment_status,''))='SUCCESS' LOOP
    IF COALESCE(p.raw_response->>'taxAmount','') !~ '^[0-9]{1,12}$'
      OR COALESCE(p.raw_response->>'tipAmount','') !~ '^[0-9]{1,12}$' THEN
      RETURN QUERY SELECT false,NULL::bigint,jsonb_build_object('reason','payment_allocation_missing'); RETURN; END IF;
    t:=(p.raw_response->>'taxAmount')::numeric;
    tip:=(p.raw_response->>'tipAmount')::numeric;
    IF t>p.amount_cents THEN
      RETURN QUERY SELECT false,NULL::bigint,jsonb_build_object('reason','payment_allocation_invalid'); RETURN; END IF;
    v_tax:=v_tax+t;v_tip:=v_tip+tip;
  END LOOP;
  FOR r IN SELECT ref_.amount_cents,ref_.payment_id,ref_.business_id,ref_.raw_response
    FROM core.refunds ref_ WHERE ref_.order_id=p_order_id LOOP
    IF r.raw_response ? 'voided' AND jsonb_typeof(r.raw_response->'voided')<>'boolean' THEN
      RETURN QUERY SELECT false,NULL::bigint,jsonb_build_object('reason','refund_void_evidence_invalid'); RETURN; END IF;
    IF COALESCE(r.raw_response->>'voided','false')='true' THEN CONTINUE; END IF;
    PERFORM 1 FROM core.payments WHERE id=r.payment_id AND order_id=p_order_id AND business_id=r.business_id
      AND upper(COALESCE(payment_status,''))='SUCCESS'
      AND clover_payment_id=r.raw_response#>>'{payment,id}';
    IF NOT FOUND THEN
      RETURN QUERY SELECT false,NULL::bigint,jsonb_build_object('reason','refund_payment_link_missing'); RETURN; END IF;
    IF COALESCE(r.raw_response->>'taxAmount','') !~ '^[0-9]{1,12}$'
      OR COALESCE(r.raw_response->>'tipAmount','') !~ '^[0-9]{1,12}$' THEN
      RETURN QUERY SELECT false,NULL::bigint,jsonb_build_object('reason','refund_allocation_missing'); RETURN; END IF;
    t:=(r.raw_response->>'taxAmount')::numeric;
    tip:=(r.raw_response->>'tipAmount')::numeric;
    IF t+tip>r.amount_cents THEN
      RETURN QUERY SELECT false,NULL::bigint,jsonb_build_object('reason','refund_allocation_invalid'); RETURN; END IF;
    v_ref_tax:=v_ref_tax+t;v_ref_tip:=v_ref_tip+tip;
  END LOOP;
  IF EXISTS(SELECT 1 FROM core.payments pay_ JOIN LATERAL (
      SELECT sum(ref_.amount_cents) AS gross,
        sum((ref_.raw_response->>'taxAmount')::numeric) AS tax,
        sum((ref_.raw_response->>'tipAmount')::numeric) AS tip
      FROM core.refunds ref_ WHERE ref_.order_id=p_order_id AND ref_.payment_id=pay_.id
        AND COALESCE(ref_.raw_response->>'voided','false')<>'true'
    ) refund_ ON true WHERE pay_.order_id=p_order_id AND upper(COALESCE(pay_.payment_status,''))='SUCCESS'
      AND (refund_.gross>pay_.amount_cents+(pay_.raw_response->>'tipAmount')::numeric
        OR refund_.tax>(pay_.raw_response->>'taxAmount')::numeric
        OR refund_.tip>(pay_.raw_response->>'tipAmount')::numeric)) THEN
    RETURN QUERY SELECT false,NULL::bigint,jsonb_build_object('reason','refund_payment_allocation_inconsistent'); RETURN; END IF;
  IF v_ref_tax>v_tax OR v_ref_tip>v_tip OR s.refunded_cents>s.paid_cents+v_tip
    OR (s.paid_cents-v_tax)-(s.refunded_cents-v_ref_tax-v_ref_tip)<0 THEN
    RETURN QUERY SELECT false,NULL::bigint,jsonb_build_object('reason','allocation_inconsistent'); RETURN; END IF;
  RETURN QUERY SELECT true,(s.paid_cents-CASE WHEN p_include_tax THEN 0 ELSE v_tax END
      +CASE WHEN p_include_tip THEN v_tip ELSE 0 END
      -(s.refunded_cents-CASE WHEN p_include_tax THEN 0 ELSE v_ref_tax END
        -CASE WHEN p_include_tip THEN 0 ELSE v_ref_tip END))::bigint,
    jsonb_build_object('paidCents',s.paid_cents,'refundedCents',s.refunded_cents,'netCents',s.net_cents,
      'grossPaidCents',s.paid_cents+v_tip,'refundGrossCents',s.refunded_cents,
      'fullRefund',s.refunded_cents=s.paid_cents+v_tip,
      'paidTaxCents',v_tax,'paidTipCents',v_tip,'refundedTaxCents',v_ref_tax,'refundedTipCents',v_ref_tip,
      'includeTax',p_include_tax,'includeTip',p_include_tip);
END $$;

CREATE FUNCTION public.campaign_evaluate_v1(p_business_id uuid,p_campaign_id uuid,p_order_id uuid,
  p_units integer DEFAULT 1,p_source text DEFAULT 'clover_trace',p_staff_actor uuid DEFAULT NULL,p_staff_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c core.campaigns%ROWTYPE; o core.orders%ROWTYPE; customer core.customers%ROWTYPE;
  red core.offer_redemptions%ROWTYPE; s record; a record; v_local timestamp; v_period text;
  v_now timestamptz; v_total numeric; v_product_units numeric:=0; v_qty numeric; i record;
  v_discounts jsonb:='[]'::jsonb; v_discount jsonb; v_trace boolean:=false;
  v_trace_units numeric:=0; v_trace_evidence jsonb:='[]'::jsonb; v_match boolean;
  v_percentage text; v_amount text;
  v_void_reason text; v_restore boolean; v_snapshot jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'K9_READ_COMMITTED_REQUIRED' USING ERRCODE='25000'; END IF;
  IF p_business_id IS NULL OR p_campaign_id IS NULL OR p_order_id IS NULL OR p_units IS NULL
    OR p_units NOT BETWEEN 1 AND 1000 OR p_source IS NULL OR p_source NOT IN('clover_trace','staff_mark') THEN
    RAISE EXCEPTION 'Invalid campaign intent' USING ERRCODE='22023'; END IF;
  -- Serialize the complete campaign, including person-period and global units.
  -- Read committed plus this row lock makes a waiting session see committed uses.
  SELECT * INTO c FROM core.campaigns WHERE id=p_campaign_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied',false,'code','campaign_not_found'); END IF;
  SELECT * INTO o FROM core.orders WHERE id=p_order_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('applied',false,'code','order_not_found'); END IF;
  SELECT * INTO s FROM core.clover_order_status_v1(o.id);
  SELECT * INTO red FROM core.offer_redemptions WHERE campaign_id=c.id AND order_id=o.id FOR UPDATE;
  IF FOUND THEN
    IF red.status='voided' THEN
      RETURN jsonb_build_object('applied',false,'code','already_voided','redemptionId',red.id,'status',red.status); END IF;
    IF o.raw_response->'refundsVerified' IS DISTINCT FROM 'true'::jsonb THEN
      RETURN jsonb_build_object('applied',false,'code','refund_amount_evidence_missing',
        'redemptionId',red.id,'status',red.status); END IF;
    IF s.status='refunded' AND s.paid_cents>0 THEN
      SELECT * INTO a FROM core.campaign_amount_v1(o.id,
        (red.snapshot#>>'{campaign,include_tax}')::boolean,(red.snapshot#>>'{campaign,include_tip}')::boolean);
      IF NOT a.known THEN RETURN jsonb_build_object('applied',false,'code','refund_amount_evidence_missing',
        'redemptionId',red.id,'status',red.status); END IF;
      IF (a.evidence->>'fullRefund')::boolean THEN
        v_void_reason:='full_refund';
        v_restore:=(red.snapshot#>>'{campaign,restore_on_full_refund}')::boolean;
      ELSE
        IF a.amount_cents<(red.snapshot#>>'{campaign,min_amount_cents}')::bigint THEN
          v_void_reason:='partial_below_minimum';
          v_restore:=(red.snapshot#>>'{campaign,restore_on_partial_below_minimum}')::boolean;
        END IF;
      END IF;
      IF v_void_reason IS NOT NULL THEN
        UPDATE core.offer_redemptions SET status='voided',void_reason=v_void_reason,voided_at=clock_timestamp(),
          quota_reserved=NOT v_restore WHERE id=red.id;
        INSERT INTO core.campaign_events(business_id,campaign_id,redemption_id,event_type,actor_id,payload)
          VALUES(c.business_id,c.id,red.id,'voided',auth.uid(),jsonb_build_object('reason',v_void_reason,
            'rightsRestored',v_restore,'originalCampaignVersion',red.snapshot#>'{campaign,version}',
            'paidCents',s.paid_cents,'refundedCents',s.refunded_cents,'amountEvidence',to_jsonb(a),
            'providerEvidence',jsonb_build_object('order',o.raw_response,
              'payments',COALESCE((SELECT jsonb_agg(pay_.raw_response ORDER BY pay_.clover_payment_id)
                FROM core.payments pay_ WHERE pay_.order_id=o.id AND pay_.business_id=c.business_id),'[]'::jsonb),
              'refunds',COALESCE((SELECT jsonb_agg(ref_.raw_response ORDER BY ref_.clover_refund_id)
                FROM core.refunds ref_ WHERE ref_.order_id=o.id AND ref_.business_id=c.business_id),'[]'::jsonb))));
        RETURN jsonb_build_object('applied',false,'code','voided','redemptionId',red.id,'status','voided','rightsRestored',v_restore);
      END IF;
    END IF;
    IF p_units<>red.units OR p_source<>red.source OR p_staff_actor IS DISTINCT FROM red.staff_actor
      OR NULLIF(btrim(p_staff_note),'') IS DISTINCT FROM red.staff_note THEN
      RETURN jsonb_build_object('applied',false,'code','idempotency_conflict','redemptionId',red.id); END IF;
    RETURN jsonb_build_object('applied',false,'code','already_applied','redemptionId',red.id,'status',red.status);
  END IF;
  IF c.status<>'active' THEN RETURN jsonb_build_object('applied',false,'code','campaign_inactive'); END IF;
  IF s.status<>'paid' OR s.paid_cents<=0 OR s.net_cents<=0 THEN
    RETURN jsonb_build_object('applied',false,'code','order_not_paid'); END IF;
  IF o.customer_id IS NULL OR o.match_status NOT IN('exact','staff_resolved') THEN
    RETURN jsonb_build_object('applied',false,'code','order_unmatched'); END IF;
  SELECT * INTO customer FROM core.customers WHERE id=o.customer_id AND business_id=c.business_id FOR SHARE;
  IF NOT FOUND OR (c.eligibility='subscribed_only' AND
    (customer.email_status<>'subscribed' OR customer.email_suppressed_at IS NOT NULL))
    OR c.is_test IS DISTINCT FROM customer.is_test THEN
    RETURN jsonb_build_object('applied',false,'code','customer_ineligible'); END IF;
  IF NOT o.clover_order_type_id=ANY(c.order_type_ids) THEN
    RETURN jsonb_build_object('applied',false,'code','channel_mismatch'); END IF;
  v_now:=clock_timestamp();
  v_local:=o.created_at AT TIME ZONE c.tz_name;
  IF o.created_at>v_now OR o.created_at<c.starts_at OR o.created_at>=c.ends_at
    OR NOT extract(isodow FROM v_local)::smallint=ANY(c.weekdays)
    OR (c.local_start IS NOT NULL AND (v_local::time<c.local_start OR v_local::time>=c.local_end)) THEN
    RETURN jsonb_build_object('applied',false,'code','outside_window'); END IF;
  SELECT * INTO a FROM core.campaign_amount_v1(o.id,c.include_tax,c.include_tip);
  IF NOT a.known THEN RETURN jsonb_build_object('applied',false,'code','amount_evidence_missing'); END IF;
  IF a.amount_cents<c.min_amount_cents THEN RETURN jsonb_build_object('applied',false,'code','below_minimum'); END IF;
  IF p_units>c.max_units_per_order THEN RETURN jsonb_build_object('applied',false,'code','per_order_limit'); END IF;
  IF c.target_clover_item_id IS NOT NULL THEN
    FOR i IN SELECT quantity,raw_response FROM core.order_items WHERE order_id=o.id AND business_id=c.business_id
      AND raw_response#>>'{item,id}'=c.target_clover_item_id
      AND COALESCE(raw_response->>'deleted','false')='false'
      AND COALESCE(raw_response->>'voided','false')='false' LOOP
      -- No substitution of Clover line-item id for inventory item.id.
      -- K7 quantity or explicitly integral PER_UNIT unitQty are usable evidence.
      v_qty:=i.quantity;
      IF v_qty IS NULL AND i.raw_response->>'priceType'='PER_UNIT'
        AND COALESCE(i.raw_response->>'unitQty','') ~ '^[0-9]{1,12}$' THEN
        v_qty:=(i.raw_response->>'unitQty')::numeric/1000;
      END IF;
      IF v_qty IS NULL OR v_qty<=0 OR v_qty<>trunc(v_qty) THEN
        RETURN jsonb_build_object('applied',false,'code','product_evidence_missing'); END IF;
      v_product_units:=v_product_units+v_qty;
    END LOOP;
    IF v_product_units<p_units THEN RETURN jsonb_build_object('applied',false,'code','product_mismatch'); END IF;
  END IF;
  IF p_source='staff_mark' THEN
    IF p_staff_actor IS NULL OR p_staff_actor IS DISTINCT FROM auth.uid()
      OR p_staff_note IS NULL OR length(btrim(p_staff_note)) NOT BETWEEN 1 AND 1000
      OR p_staff_note !~ '[^[:space:]]'
      OR NOT EXISTS(SELECT 1 FROM core.crm_staff WHERE auth_user_id=auth.uid() AND active) THEN
      RETURN jsonb_build_object('applied',false,'code','staff_evidence_required'); END IF;
    p_staff_note:=btrim(p_staff_note);
  ELSE
    IF p_staff_actor IS NOT NULL OR p_staff_note IS NOT NULL THEN
      RAISE EXCEPTION 'Invalid Clover trace intent' USING ERRCODE='22023'; END IF;
    -- These exact fields come from retained provider response objects. A caller
    -- supplied flag, matching line id/name or application-only code is no proof.
    IF c.benefit_type='item' THEN
      -- Item means an evidenced free target inventory item. An order-level
      -- coupon or discount on another item cannot prove this grant. Only an
      -- explicit 100% line discount is accepted in v1; fixed-amount free-item
      -- inference is intentionally unsupported because modifiers/price/qty
      -- may be incomplete in the existing provider read.
      FOR i IN SELECT clover_item_id,quantity,raw_response FROM core.order_items
        WHERE order_id=o.id AND business_id=c.business_id
          AND raw_response#>>'{item,id}'=c.target_clover_item_id
          AND COALESCE(raw_response->>'deleted','false')='false'
          AND COALESCE(raw_response->>'voided','false')='false' LOOP
        v_qty:=i.quantity;
        IF v_qty IS NULL AND i.raw_response->>'priceType'='PER_UNIT'
          AND COALESCE(i.raw_response->>'unitQty','') ~ '^[0-9]{1,12}$' THEN
          v_qty:=(i.raw_response->>'unitQty')::numeric/1000;
        END IF;
        v_discounts:=CASE WHEN jsonb_typeof(i.raw_response#>'{discounts,elements}')='array'
          THEN i.raw_response#>'{discounts,elements}'
          WHEN jsonb_typeof(i.raw_response->'discounts')='array' THEN i.raw_response->'discounts'
          ELSE '[]'::jsonb END;
        FOR v_discount IN SELECT value FROM jsonb_array_elements(v_discounts) LOOP
          v_match:=(c.clover_discount_id IS NOT NULL AND
            (v_discount->>'id'=c.clover_discount_id OR v_discount#>>'{discount,id}'=c.clover_discount_id))
            OR (c.benefit_code IS NOT NULL AND
            (v_discount->>'code'=c.benefit_code OR v_discount#>>'{discount,code}'=c.benefit_code));
          v_percentage:=COALESCE(v_discount->>'percentage',v_discount#>>'{discount,percentage}','');
          IF v_match AND COALESCE(v_discount->>'deleted','false')='false'
            AND COALESCE(v_discount->>'voided','false')='false'
            AND COALESCE(v_discount#>>'{discount,deleted}','false')='false'
            AND COALESCE(v_discount#>>'{discount,voided}','false')='false'
            AND v_percentage ~ '^100(\.0{1,3})?$' THEN
            v_trace:=true;v_trace_units:=v_trace_units+v_qty;
            v_trace_evidence:=v_trace_evidence||jsonb_build_array(jsonb_build_object(
              'cloverLineItemId',i.clover_item_id,'inventoryItemId',c.target_clover_item_id,
              'units',v_qty,'discount',v_discount));
            EXIT;
          END IF;
        END LOOP;
      END LOOP;
      IF v_trace AND v_trace_units<>p_units THEN
        RETURN jsonb_build_object('applied',false,'code','quantity_mismatch'); END IF;
    ELSE
      -- A discount use is one applied monetary/percentage grant, never an
      -- arbitrary number supplied by a caller. Match the configured magnitude.
      IF c.target_clover_item_id IS NULL THEN
        IF jsonb_typeof(o.raw_response#>'{raw,discounts,elements}')='array' THEN
          v_discounts:=o.raw_response#>'{raw,discounts,elements}';
        ELSIF jsonb_typeof(o.raw_response#>'{raw,discounts}')='array' THEN
          v_discounts:=o.raw_response#>'{raw,discounts}';
        END IF;
      ELSE
        FOR i IN SELECT raw_response FROM core.order_items WHERE order_id=o.id AND business_id=c.business_id
          AND raw_response#>>'{item,id}'=c.target_clover_item_id
          AND COALESCE(raw_response->>'deleted','false')='false'
          AND COALESCE(raw_response->>'voided','false')='false' LOOP
          IF jsonb_typeof(i.raw_response#>'{discounts,elements}')='array' THEN
            v_discounts:=v_discounts||(i.raw_response#>'{discounts,elements}');
          ELSIF jsonb_typeof(i.raw_response->'discounts')='array' THEN
            v_discounts:=v_discounts||(i.raw_response->'discounts');
          END IF;
        END LOOP;
      END IF;
      FOR v_discount IN SELECT value FROM jsonb_array_elements(v_discounts) LOOP
        v_match:=(c.clover_discount_id IS NOT NULL AND
          (v_discount->>'id'=c.clover_discount_id OR v_discount#>>'{discount,id}'=c.clover_discount_id))
          OR (c.benefit_code IS NOT NULL AND
          (v_discount->>'code'=c.benefit_code OR v_discount#>>'{discount,code}'=c.benefit_code));
        v_percentage:=COALESCE(v_discount->>'percentage',v_discount#>>'{discount,percentage}','');
        v_amount:=COALESCE(v_discount->>'amount',v_discount#>>'{discount,amount}','');
        IF v_match AND COALESCE(v_discount->>'deleted','false')='false'
          AND COALESCE(v_discount->>'voided','false')='false'
          AND COALESCE(v_discount#>>'{discount,deleted}','false')='false'
          AND COALESCE(v_discount#>>'{discount,voided}','false')='false'
          AND ((c.discount_percentage IS NOT NULL AND v_percentage ~ '^[0-9]{1,3}(\.[0-9]{1,3})?$'
            AND CASE WHEN v_percentage ~ '^[0-9]{1,3}(\.[0-9]{1,3})?$' THEN v_percentage::numeric END=c.discount_percentage)
          OR (c.discount_amount_cents IS NOT NULL AND v_amount ~ '^-[0-9]{1,12}$'
            AND CASE WHEN v_amount ~ '^-[0-9]{1,12}$' THEN -v_amount::bigint END=c.discount_amount_cents)) THEN
          v_trace:=true;v_trace_evidence:=jsonb_build_array(v_discount);EXIT;
        END IF;
      END LOOP;
    END IF;
    IF NOT v_trace THEN RETURN jsonb_build_object('applied',false,'code','trace_missing'); END IF;
  END IF;
  v_period:=CASE c.period WHEN 'week' THEN 'week:'||to_char(v_local,'IYYY-"W"IW')
    WHEN 'campaign' THEN 'campaign:'||c.id::text ELSE 'order:'||o.id::text END;
  IF EXISTS(SELECT 1 FROM core.offer_redemptions WHERE campaign_id=c.id AND customer_id=customer.id
    AND period_key=v_period AND quota_reserved) THEN
    RETURN jsonb_build_object('applied',false,'code','period_limit'); END IF;
  SELECT reserved_units INTO STRICT v_total FROM core.campaign_usage WHERE campaign_id=c.id;
  IF c.max_total_units IS NOT NULL AND v_total+p_units>c.max_total_units THEN
    RETURN jsonb_build_object('applied',false,'code','total_limit'); END IF;
  v_snapshot:=jsonb_build_object('schemaVersion',1,'campaign',to_jsonb(c),'orderId',o.id,
    'customerId',customer.id,'orderCreatedAt',o.created_at,'cloverOrderId',o.clover_order_id,
    'cloverMerchantId',o.clover_merchant_id,'cloverOrderTypeId',o.clover_order_type_id,
    'source',p_source,'staffActor',p_staff_actor,'staffNote',p_staff_note,
    'periodKey',v_period,'units',p_units,'amountEvidence',a.evidence,
    'traceEvidence',CASE WHEN p_source='clover_trace' THEN v_trace_evidence ELSE NULL END,
    'targetProductUnits',v_product_units,'evaluatedAt',v_now,
    'providerEvidence',jsonb_build_object('order',o.raw_response,
      'items',COALESCE((SELECT jsonb_agg(oi_.raw_response ORDER BY oi_.clover_item_id)
        FROM core.order_items oi_ WHERE oi_.order_id=o.id AND oi_.business_id=c.business_id),'[]'::jsonb),
      'payments',COALESCE((SELECT jsonb_agg(pay_.raw_response ORDER BY pay_.clover_payment_id)
        FROM core.payments pay_ WHERE pay_.order_id=o.id AND pay_.business_id=c.business_id),'[]'::jsonb),
      'refunds',COALESCE((SELECT jsonb_agg(ref_.raw_response ORDER BY ref_.clover_refund_id)
        FROM core.refunds ref_ WHERE ref_.order_id=o.id AND ref_.business_id=c.business_id),'[]'::jsonb)));
  INSERT INTO core.offer_redemptions(business_id,campaign_id,customer_id,order_id,applied_at,source,
    staff_actor,staff_note,period_key,units,snapshot)
    VALUES(c.business_id,c.id,customer.id,o.id,v_now,p_source,p_staff_actor,p_staff_note,v_period,p_units,v_snapshot)
    RETURNING * INTO red;
  INSERT INTO core.campaign_events(business_id,campaign_id,redemption_id,event_type,actor_id,payload)
    VALUES(c.business_id,c.id,red.id,'applied',auth.uid(),jsonb_build_object('schemaVersion',1,
      'campaignVersion',c.version,'orderId',o.id,'units',p_units,'periodKey',v_period,'source',p_source));
  RETURN jsonb_build_object('applied',true,'code','applied','redemptionId',red.id,'status',red.status,
    'periodKey',v_period,'units',p_units);
END $$;

ALTER TABLE core.campaigns ENABLE ALWAYS TRIGGER campaigns_no_remove;
ALTER TABLE core.campaigns ENABLE ALWAYS TRIGGER campaigns_config_guard;
ALTER TABLE core.campaigns ENABLE ALWAYS TRIGGER campaigns_evidence;
ALTER TABLE core.offer_redemptions ENABLE ALWAYS TRIGGER redemptions_no_remove;
ALTER TABLE core.offer_redemptions ENABLE ALWAYS TRIGGER offer_redemptions_guard;
ALTER TABLE core.campaign_events ENABLE ALWAYS TRIGGER campaign_events_immutable;
ALTER TABLE core.campaign_usage ENABLE ALWAYS TRIGGER campaign_usage_guard;
ALTER TABLE core.campaign_usage ENABLE ALWAYS TRIGGER campaign_usage_no_remove;
ALTER TABLE core.offer_redemptions ENABLE ALWAYS TRIGGER offer_redemptions_usage;
REVOKE ALL ON FUNCTION core.campaign_no_remove_v1(),core.campaign_config_guard_v1(),
  core.campaign_config_event_v1(),core.campaign_redemption_guard_v1(),core.campaign_usage_guard_v1(),
  core.campaign_usage_update_v1(),core.campaign_amount_v1(uuid,boolean,boolean),
  public.campaign_evaluate_v1(uuid,uuid,uuid,integer,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.campaign_evaluate_v1(uuid,uuid,uuid,integer,text,uuid,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
