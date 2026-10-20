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

-- Shared staff contract v1. No memberships/operators are seeded here.
-- Legacy crm_staff stays as history, never an alternate scope authority.
CREATE TABLE core.business_staff (
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  staff_id uuid NOT NULL REFERENCES auth.users(id),
  role text NOT NULL CHECK(role IN('owner','manager','staff')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY(business_id,staff_id)
);
CREATE TABLE core.platform_operators (
  staff_id uuid PRIMARY KEY REFERENCES auth.users(id),
  active boolean NOT NULL DEFAULT true
);
ALTER TABLE core.business_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.platform_operators ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE core.business_staff,core.platform_operators
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION core.staff_authorized_v1(p_business_id uuid,p_operation text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT COALESCE(auth.uid() IS NOT NULL AND CASE
    WHEN p_operation='platform.read' THEN p_business_id IS NULL AND EXISTS(
      SELECT 1 FROM core.platform_operators p WHERE p.staff_id=auth.uid() AND p.active)
    WHEN p_operation IN('crm.read','orders.read','ops.read','loyalty.read',
      'crm.write','consent.restore','orders.match','campaign.staff_mark','ops.write')
      THEN p_business_id IS NOT NULL
        AND EXISTS(SELECT 1 FROM core.businesses b WHERE b.id=p_business_id)
        AND (EXISTS(SELECT 1 FROM core.business_staff s
          WHERE s.business_id=p_business_id AND s.staff_id=auth.uid() AND s.active)
        OR (p_operation IN('crm.read','orders.read','ops.read','loyalty.read')
          AND EXISTS(SELECT 1 FROM core.platform_operators p WHERE p.staff_id=auth.uid() AND p.active)))
    ELSE false END,false)
$$;
REVOKE ALL ON FUNCTION core.staff_authorized_v1(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;

-- Staff adapters must check their configured business, never the global menu bool.
CREATE FUNCTION public.staff_business_authorized_v1(p_business_id uuid,p_operation text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT COALESCE(auth.role()='authenticated' AND core.staff_authorized_v1(p_business_id,p_operation),false)
$$;
REVOKE ALL ON FUNCTION public.staff_business_authorized_v1(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.staff_business_authorized_v1(uuid,text) TO authenticated;

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
  -- Recheck staff scope before idempotent reads OR refund-driven mutations.
  -- A revoked staff member cannot reuse an older applied redemption as a bypass.
  IF p_source='staff_mark' THEN
    IF p_staff_actor IS NULL OR p_staff_actor IS DISTINCT FROM auth.uid()
      OR p_staff_note IS NULL OR length(btrim(p_staff_note)) NOT BETWEEN 1 AND 1000
      OR p_staff_note !~ '[^[:space:]]'
      OR NOT core.staff_authorized_v1(c.business_id,'campaign.staff_mark') THEN
      RETURN jsonb_build_object('applied',false,'code','staff_evidence_required'); END IF;
    p_staff_note:=btrim(p_staff_note);
  END IF;
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
-- K9 unified staff scope: forward-only legacy replacements.
-- Insert after core.business_staff/core.platform_operators/core.staff_authorized_v1.
-- Existing canonical migrations/baseline are never edited. No identity seeds.
-- Guarded replacements support the deliberately minimal local K9 bootstrap;
-- the full reviewed application baseline contains every guarded object.
CREATE FUNCTION core.staff_legacy_business_v1() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$ SELECT CASE WHEN pg_catalog.count(*)=1 THEN (pg_catalog.min(b.id::text))::uuid
  ELSE NULL::uuid END FROM core.businesses b $$;
REVOKE ALL ON FUNCTION core.staff_legacy_business_v1() FROM PUBLIC,anon,authenticated,service_role;


-- public.crm_add_note(uuid,text)
DO $legacy_1$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_add_note(uuid,text)') IS NOT NULL THEN
    EXECUTE $forward_1$
CREATE OR REPLACE FUNCTION public.crm_add_note(p_customer_id uuid, p_body text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF NOT (core.staff_authorized_v1((SELECT c.business_id FROM core.customers c WHERE c.id=p_customer_id),'crm.write')) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
 IF length(trim(coalesce(p_body, ''))) NOT BETWEEN 1 AND 2000 THEN
  RAISE EXCEPTION 'Invalid input' USING ERRCODE = '22023';
 END IF;
 INSERT INTO core.customer_notes(customer_id, author_id, body)
 SELECT id, auth.uid(), trim(p_body) FROM core.customers
 WHERE id = p_customer_id AND core.staff_authorized_v1(business_id,'crm.write');
 RETURN FOUND;
END;
$$;
$forward_1$;
  END IF;
END $legacy_1$;

-- public.crm_catering_decisions_v1()
DO $legacy_2$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_catering_decisions_v1()') IS NOT NULL THEN
    EXECUTE $forward_2$
CREATE OR REPLACE FUNCTION public.crm_catering_decisions_v1() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_rows jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM core.businesses b WHERE core.staff_authorized_v1(b.id,'crm.read'))) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) INTO v_rows FROM (
    SELECT q.id, q.request_id, q.question, q.requested_at,
           q.decision, q.recorded_at, r.status AS request_status,
           c.name AS customer_name
    FROM core.catering_decisions q
    JOIN core.catering_requests r ON r.id = q.request_id
    JOIN core.customers c ON c.id = r.customer_id
    WHERE core.staff_authorized_v1(c.business_id,'crm.read')
    ORDER BY q.recorded_at NULLS FIRST, q.requested_at DESC LIMIT 100
  ) d;
  RETURN jsonb_build_object('items', v_rows);
END;
$$;
$forward_2$;
  END IF;
END $legacy_2$;

-- public.crm_catering_notification_status_v1()
DO $legacy_3$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_catering_notification_status_v1()') IS NOT NULL THEN
    EXECUTE $forward_3$
CREATE OR REPLACE FUNCTION public.crm_catering_notification_status_v1() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_items jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM core.businesses b WHERE core.staff_authorized_v1(b.id,'crm.read'))) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_items
  FROM (
    SELECT r.id AS request_id, r.form_request_id IS NOT NULL AS tracked,
           r.staff_notification_attempted_at AS attempted_at,
           r.staff_notification_sent_at AS sent_at,
           r.staff_notification_error AS error
    FROM core.catering_requests r
    JOIN core.customers c ON c.id = r.customer_id
    WHERE core.staff_authorized_v1(c.business_id,'crm.read')
      AND r.created_at >= now() - interval '30 days'
    ORDER BY r.created_at DESC LIMIT 100
  ) x;
  RETURN pg_catalog.jsonb_build_object('items', v_items);
END
$$;
$forward_3$;
  END IF;
END $legacy_3$;

-- public.crm_complete_task_v1(uuid)
DO $legacy_4$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_complete_task_v1(uuid)') IS NOT NULL THEN
    EXECUTE $forward_4$
CREATE OR REPLACE FUNCTION public.crm_complete_task_v1(p_task_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF NOT (core.staff_authorized_v1((SELECT c.business_id FROM core.customer_follow_up_tasks t JOIN core.customers c ON c.id=t.customer_id WHERE t.id=p_task_id),'crm.write')) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
 UPDATE core.customer_follow_up_tasks t SET completed_at = now()
 FROM core.customers c WHERE t.id = p_task_id AND t.customer_id = c.id
  AND core.staff_authorized_v1(c.business_id,'crm.write') AND t.completed_at IS NULL;
 RETURN FOUND;
END;
$$;
$forward_4$;
  END IF;
END $legacy_4$;

-- public.crm_create_task_v1(uuid,text,text,timestamptz)
DO $legacy_5$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_create_task_v1(uuid,text,text,timestamptz)') IS NOT NULL THEN
    EXECUTE $forward_5$
CREATE OR REPLACE FUNCTION public.crm_create_task_v1(p_customer_id uuid, p_title text, p_assigned_to text, p_due_at timestamp with time zone) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT (core.staff_authorized_v1((SELECT c.business_id FROM core.customers c WHERE c.id=p_customer_id),'crm.write')) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
 IF length(trim(coalesce(p_title, ''))) NOT BETWEEN 1 AND 300 OR length(trim(coalesce(p_assigned_to, ''))) NOT BETWEEN 1 AND 100 OR p_due_at IS NULL THEN
  RAISE EXCEPTION 'Invalid task' USING ERRCODE = '22023';
 END IF;
 INSERT INTO core.customer_follow_up_tasks(customer_id, created_by, title, assigned_to, due_at)
 SELECT id, auth.uid(), trim(p_title), trim(p_assigned_to), p_due_at
 FROM core.customers WHERE id = p_customer_id AND core.staff_authorized_v1(business_id,'crm.write')
 RETURNING id INTO v_id;
 IF v_id IS NULL THEN RAISE EXCEPTION 'Customer not found' USING ERRCODE = '22023'; END IF;
 RETURN v_id;
END;
$$;
$forward_5$;
  END IF;
END $legacy_5$;

-- public.crm_customer_tasks_v1(uuid)
DO $legacy_6$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_customer_tasks_v1(uuid)') IS NOT NULL THEN
    EXECUTE $forward_6$
CREATE OR REPLACE FUNCTION public.crm_customer_tasks_v1(p_customer_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_tasks jsonb;
BEGIN
  IF NOT (core.staff_authorized_v1((SELECT c.business_id FROM core.customers c WHERE c.id=p_customer_id),'crm.read')) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
 IF NOT EXISTS (SELECT 1 FROM core.customers WHERE id = p_customer_id AND core.staff_authorized_v1(business_id,'crm.read')) THEN
  RAISE EXCEPTION 'Customer not found' USING ERRCODE = '22023';
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tasks FROM (
  SELECT id, title, assigned_to, due_at, completed_at, created_at
  FROM core.customer_follow_up_tasks WHERE customer_id = p_customer_id
    AND EXISTS(SELECT 1 FROM core.customers c WHERE c.id=p_customer_id
      AND core.staff_authorized_v1(c.business_id,'crm.read'))
  ORDER BY completed_at NULLS FIRST, due_at ASC LIMIT 50
 ) t;
 RETURN v_tasks;
END;
$$;
$forward_6$;
  END IF;
END $legacy_6$;

-- public.crm_follow_up_queue_v1(text,integer)
DO $legacy_7$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_follow_up_queue_v1(text,integer)') IS NOT NULL THEN
    EXECUTE $forward_7$
CREATE OR REPLACE FUNCTION public.crm_follow_up_queue_v1(p_queue text DEFAULT 'open_catering'::text, p_offset integer DEFAULT 0) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM core.businesses b WHERE core.staff_authorized_v1(b.id,'crm.read'))) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF p_queue IS NULL OR p_queue NOT IN ('open_catering','missing_owner','missing_followup',
    'overdue_catering','open_tasks','overdue_tasks','pending_decisions')
    OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid queue or offset' USING ERRCODE = '22023';
  END IF;
  WITH customers AS MATERIALIZED (
    SELECT c.id, c.name FROM core.customers c
    WHERE core.staff_authorized_v1(c.business_id,'crm.read')
      AND (EXISTS (SELECT 1 FROM core.signups s WHERE s.customer_id = c.id AND NOT s.is_test)
        OR NOT EXISTS (SELECT 1 FROM core.signups s WHERE s.customer_id = c.id))
  ), requests AS MATERIALIZED (
    SELECT r.id, r.customer_id, c.name AS customer_name, r.status AS request_status,
      r.assigned_to, r.follow_up_at AS due_at, r.created_at,
      r.follow_up_at < now() AS overdue,
      nullif(btrim(r.assigned_to), '') IS NULL AS missing_owner,
      r.follow_up_at IS NULL AS missing_followup
    FROM core.catering_requests r JOIN customers c ON c.id = r.customer_id
    WHERE NOT r.is_test AND r.status IN ('new','contacted','quoted')
  ), tasks AS MATERIALIZED (
    SELECT t.id, t.customer_id, c.name AS customer_name, t.title, t.assigned_to,
      t.due_at, t.created_at, t.due_at < now() AS overdue
    FROM core.customer_follow_up_tasks t JOIN customers c ON c.id = t.customer_id
    WHERE t.completed_at IS NULL
  ), decisions AS MATERIALIZED (
    SELECT d.id, r.id AS request_id, r.customer_id, r.customer_name, d.question AS title,
      r.request_status, r.assigned_to, r.due_at, d.requested_at AS created_at
    FROM core.catering_decisions d JOIN requests r ON r.id = d.request_id
    WHERE d.recorded_at IS NULL
  ), entries AS (
    SELECT 'request'::text AS kind, r.id, r.id AS request_id, r.customer_id, r.customer_name,
      'Catering follow-up'::text AS title, r.request_status, r.assigned_to, r.due_at, r.created_at,
      array_remove(ARRAY[CASE WHEN r.overdue THEN 'overdue' END,
        CASE WHEN r.missing_owner THEN 'missing_owner' END,
        CASE WHEN r.missing_followup THEN 'missing_followup' END], NULL) AS flags,
      CASE WHEN r.overdue THEN 0 WHEN r.missing_followup THEN 1 WHEN r.missing_owner THEN 2 ELSE 3 END AS priority
    FROM requests r
    WHERE p_queue = 'open_catering' OR (p_queue = 'missing_owner' AND r.missing_owner)
      OR (p_queue = 'missing_followup' AND r.missing_followup)
      OR (p_queue = 'overdue_catering' AND r.overdue)
    UNION ALL
    SELECT 'task', t.id, NULL::uuid, t.customer_id, t.customer_name, t.title, NULL::text,
      t.assigned_to, t.due_at, t.created_at,
      CASE WHEN t.overdue THEN ARRAY['overdue'] ELSE ARRAY[]::text[] END,
      CASE WHEN t.overdue THEN 0 ELSE 3 END
    FROM tasks t WHERE p_queue = 'open_tasks' OR (p_queue = 'overdue_tasks' AND t.overdue)
    UNION ALL
    SELECT 'decision', d.id, d.request_id, d.customer_id, d.customer_name, d.title,
      d.request_status, d.assigned_to, d.due_at, d.created_at, ARRAY['decision'], 1
    FROM decisions d WHERE p_queue = 'pending_decisions'
  ), page AS (
    SELECT * FROM entries ORDER BY priority, due_at ASC NULLS LAST, created_at, id
    LIMIT 25 OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'generated_at', now(), 'queue', p_queue, 'offset', p_offset, 'page_size', 25,
    'total', (SELECT count(*) FROM entries),
    'counts', jsonb_build_object(
      'open_catering', (SELECT count(*) FROM requests),
      'missing_owner', (SELECT count(*) FROM requests WHERE missing_owner),
      'missing_followup', (SELECT count(*) FROM requests WHERE missing_followup),
      'overdue_catering', (SELECT count(*) FROM requests WHERE overdue),
      'open_tasks', (SELECT count(*) FROM tasks),
      'overdue_tasks', (SELECT count(*) FROM tasks WHERE overdue),
      'pending_decisions', (SELECT count(*) FROM decisions)),
    'items', coalesce((SELECT jsonb_agg(to_jsonb(p) - 'priority'
      ORDER BY p.priority, p.due_at ASC NULLS LAST, p.created_at, p.id) FROM page p), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$$;
$forward_7$;
  END IF;
END $legacy_7$;

-- public.crm_form_errors_v1()
DO $legacy_8$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_form_errors_v1()') IS NOT NULL THEN
    EXECUTE $forward_8$
CREATE OR REPLACE FUNCTION public.crm_form_errors_v1() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_items jsonb; v_total bigint;
BEGIN
  IF NOT (core.staff_authorized_v1(core.staff_legacy_business_v1(),'crm.read')) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT count(*) INTO v_total FROM core.form_errors WHERE resolved_at IS NULL;
  SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_items FROM (
    SELECT id,occurred_at,form_kind,stage,error_code,http_status,alert_status
    FROM core.form_errors WHERE resolved_at IS NULL ORDER BY occurred_at DESC LIMIT 50
  ) x;
  RETURN jsonb_build_object('total_open',v_total,'items',v_items);
END $$;
$forward_8$;
  END IF;
END $legacy_8$;

-- public.crm_klaviyo_status_v1(uuid)
DO $legacy_9$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_klaviyo_status_v1(uuid)') IS NOT NULL THEN
    EXECUTE $forward_9$
CREATE OR REPLACE FUNCTION public.crm_klaviyo_status_v1(p_customer_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT (core.staff_authorized_v1((SELECT c.business_id FROM core.customers c WHERE c.id=p_customer_id),'crm.read')) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
 SELECT jsonb_build_object('email',lower(trim(c.email)),'localStatus',c.email_status,
   'saved',CASE WHEN o.customer_id IS NULL THEN NULL ELSE jsonb_build_object(
    'status',o.status,'checkedAt',o.checked_at,'providerUpdatedAt',o.provider_updated_at,
    'blocked',c.email_status='unsubscribed' OR o.blocked_at IS NOT NULL,
    'blockedStatus',o.blocked_status,'blockedAt',coalesce(o.blocked_at,c.email_suppressed_at)) END)
 INTO v_result FROM core.customers c LEFT JOIN core.klaviyo_email_observations o ON o.customer_id=c.id
 WHERE c.id=p_customer_id AND core.staff_authorized_v1(c.business_id,'crm.read');
 RETURN v_result;
END $$;
$forward_9$;
  END IF;
END $legacy_9$;

-- public.crm_overview(text)
DO $legacy_10$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_overview(text)') IS NOT NULL THEN
    EXECUTE $forward_10$
CREATE OR REPLACE FUNCTION public.crm_overview(p_search text DEFAULT ''::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
 v_search text := left(trim(coalesce(p_search, '')), 100);
 v_customers jsonb;
 v_requests jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM core.businesses b WHERE core.staff_authorized_v1(b.id,'crm.read'))) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) INTO v_customers FROM (
  SELECT c.id, c.name, c.email, c.phone, c.email_status, c.created_at,
   (SELECT count(*) FROM core.signups s WHERE s.customer_id = c.id) AS signup_count,
   (SELECT max(s.created_at) FROM core.signups s WHERE s.customer_id = c.id) AS last_signup_at,
   (SELECT s.source FROM core.signups s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS last_source,
   (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.created_at DESC), '[]'::jsonb)
    FROM (SELECT id, body, created_at FROM core.customer_notes WHERE customer_id = c.id ORDER BY created_at DESC LIMIT 10) n) AS notes
  FROM core.customers c
  WHERE core.staff_authorized_v1(c.business_id,'crm.read')
   AND (v_search = '' OR coalesce(c.name, '') ILIKE '%' || v_search || '%'
    OR coalesce(c.email, '') ILIKE '%' || v_search || '%'
    OR coalesce(c.phone, '') ILIKE '%' || v_search || '%')
  ORDER BY c.created_at DESC LIMIT 100
 ) c;
 SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_requests FROM (
  SELECT r.id, r.customer_id, r.event_date, r.guests, r.message,
   r.status, r.assigned_to, r.follow_up_at, r.created_at, c.name, c.email, c.phone
  FROM core.catering_requests r JOIN core.customers c ON c.id = r.customer_id
  WHERE core.staff_authorized_v1(c.business_id,'crm.read')
   AND (v_search = '' OR coalesce(c.name, '') ILIKE '%' || v_search || '%'
    OR coalesce(c.email, '') ILIKE '%' || v_search || '%'
    OR coalesce(c.phone, '') ILIKE '%' || v_search || '%')
  ORDER BY CASE WHEN r.status IN ('new','contacted','quoted') THEN 0 ELSE 1 END,
   r.follow_up_at ASC NULLS FIRST, r.created_at DESC LIMIT 100
 ) r;
 RETURN jsonb_build_object('customers', v_customers, 'requests', v_requests);
END;
$$;
$forward_10$;
  END IF;
END $legacy_10$;

-- public.crm_overview_v2(text,text)
DO $legacy_11$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_overview_v2(text,text)') IS NOT NULL THEN
    EXECUTE $forward_11$
CREATE OR REPLACE FUNCTION public.crm_overview_v2(p_search text DEFAULT ''::text, p_segment text DEFAULT 'all'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_search text := left(trim(coalesce(p_search, '')), 100);
  v_segment text := coalesce(p_segment, 'all');
  v_customers jsonb;
  v_requests jsonb;
BEGIN
  IF NOT (EXISTS (SELECT 1 FROM core.businesses b WHERE core.staff_authorized_v1(b.id,'crm.read'))) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF v_segment NOT IN ('all', 'vip', 'kevin', 'test') THEN
    RAISE EXCEPTION 'Invalid segment' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) INTO v_customers
  FROM (
    SELECT c.id, c.name, c.email, c.phone, c.email_status, c.created_at,
           (SELECT count(*) FROM core.signups s WHERE s.customer_id = c.id AND s.is_test = (v_segment = 'test')) AS signup_count,
           (SELECT max(s.created_at) FROM core.signups s WHERE s.customer_id = c.id AND s.is_test = (v_segment = 'test')) AS last_signup_at,
           (SELECT s.source FROM core.signups s WHERE s.customer_id = c.id AND s.is_test = (v_segment = 'test')
            ORDER BY s.created_at DESC LIMIT 1) AS last_source,
           (SELECT count(*) FROM core.signups s
            WHERE s.customer_id = c.id AND s.is_test = (v_segment = 'test') AND s.source = 'website_vip_page') AS vip_signup_count,
           (SELECT count(*) FROM core.signups s
            WHERE s.customer_id = c.id AND s.is_test = (v_segment = 'test')
              AND s.source = 'website_vip_page'
              AND s.utm->>'utm_campaign' = 'onscene_20261013') AS kevin_signup_count,
           (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.created_at DESC), '[]'::jsonb)
            FROM (SELECT id, source, created_at, utm->>'utm_campaign' AS campaign
                  FROM core.signups WHERE customer_id = c.id AND is_test = (v_segment = 'test')
                  ORDER BY created_at DESC LIMIT 10) s) AS recent_signups,
           (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.created_at DESC), '[]'::jsonb)
            FROM (SELECT id, body, created_at, author_id FROM core.customer_notes
                  WHERE customer_id = c.id ORDER BY created_at DESC LIMIT 10) n) AS notes
    FROM core.customers c
    WHERE core.staff_authorized_v1(c.business_id,'crm.read')
      AND (EXISTS (SELECT 1 FROM core.signups matching WHERE matching.customer_id = c.id AND matching.is_test = (v_segment = 'test'))
           OR (v_segment <> 'test' AND NOT EXISTS (SELECT 1 FROM core.signups any_signup WHERE any_signup.customer_id = c.id)))
      AND (v_search = '' OR coalesce(c.name, '') ILIKE '%' || v_search || '%'
           OR coalesce(c.email, '') ILIKE '%' || v_search || '%'
           OR coalesce(c.phone, '') ILIKE '%' || v_search || '%')
      AND (v_segment IN ('all', 'test')
           OR EXISTS (
             SELECT 1 FROM core.signups s
             WHERE s.customer_id = c.id AND s.is_test = (v_segment = 'test') AND s.source = 'website_vip_page'
               AND (v_segment = 'vip'
                    OR s.utm->>'utm_campaign' = 'onscene_20261013')
           ))
    ORDER BY c.created_at DESC LIMIT 100
  ) c;

  SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_requests
  FROM (
    SELECT r.id, r.customer_id, r.event_date, r.guests, r.message,
           r.status, r.assigned_to, r.follow_up_at, r.created_at,
           c.name, c.email, c.phone
    FROM core.catering_requests r
    JOIN core.customers c ON c.id = r.customer_id
    WHERE core.staff_authorized_v1(c.business_id,'crm.read')
      AND r.is_test = (v_segment = 'test')
      AND (v_search = '' OR coalesce(c.name, '') ILIKE '%' || v_search || '%'
           OR coalesce(c.email, '') ILIKE '%' || v_search || '%'
           OR coalesce(c.phone, '') ILIKE '%' || v_search || '%')
      AND (v_segment IN ('all', 'test')
           OR EXISTS (
             SELECT 1 FROM core.signups s
             WHERE s.customer_id = c.id AND s.is_test = (v_segment = 'test') AND s.source = 'website_vip_page'
               AND (v_segment = 'vip'
                    OR s.utm->>'utm_campaign' = 'onscene_20261013')
           ))
    ORDER BY CASE WHEN r.status IN ('new', 'contacted', 'quoted') THEN 0 ELSE 1 END,
             r.follow_up_at ASC NULLS FIRST, r.created_at DESC
    LIMIT 100
  ) r;
  RETURN jsonb_build_object('customers', v_customers, 'requests', v_requests);
END;
$$;
$forward_11$;
  END IF;
END $legacy_11$;

-- public.crm_record_catering_decision_v1(uuid,text)
DO $legacy_12$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_record_catering_decision_v1(uuid,text)') IS NOT NULL THEN
    EXECUTE $forward_12$
CREATE OR REPLACE FUNCTION public.crm_record_catering_decision_v1(p_decision_id uuid, p_decision text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
       BEGIN
  IF NOT (core.staff_authorized_v1((SELECT c.business_id FROM core.catering_decisions d JOIN core.catering_requests r ON r.id=d.request_id JOIN core.customers c ON c.id=r.customer_id WHERE d.id=p_decision_id),'crm.write') AND EXISTS (SELECT 1 FROM core.catering_decision_makers WHERE auth_user_id=auth.uid() AND active)) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
                IF length(trim(coalesce(p_decision, ''))) NOT BETWEEN 1 AND 2000 THEN
                  RAISE EXCEPTION 'Invalid decision' USING ERRCODE = '22023';
                   END IF;
                    UPDATE core.catering_decisions q
                     SET decision = trim(p_decision), recorded_by = auth.uid(), recorded_at = now()
                      FROM core.catering_requests r
                       JOIN core.customers c ON c.id = r.customer_id
                        WHERE q.id = p_decision_id AND q.request_id = r.id AND q.recorded_at IS NULL
                           AND core.staff_authorized_v1(c.business_id,'crm.write');
                            RETURN FOUND;
                            END;
                            $$;
$forward_12$;
  END IF;
END $legacy_12$;

-- public.crm_request_catering_decision_v1(uuid,text)
DO $legacy_13$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_request_catering_decision_v1(uuid,text)') IS NOT NULL THEN
    EXECUTE $forward_13$
CREATE OR REPLACE FUNCTION public.crm_request_catering_decision_v1(p_request_id uuid, p_question text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT (core.staff_authorized_v1((SELECT c.business_id FROM core.catering_requests r JOIN core.customers c ON c.id=r.customer_id WHERE r.id=p_request_id),'crm.write')) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF length(trim(coalesce(p_question, ''))) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Invalid question' USING ERRCODE = '22023';
  END IF;
  INSERT INTO core.catering_decisions(request_id, question, requested_by)
  SELECT r.id, trim(p_question), auth.uid()
  FROM core.catering_requests r
  JOIN core.customers c ON c.id = r.customer_id
  WHERE r.id = p_request_id
    AND core.staff_authorized_v1(c.business_id,'crm.write')
  ON CONFLICT (request_id) WHERE recorded_at IS NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Request missing or a decision is already pending' USING ERRCODE = '22023';
  END IF;
  RETURN v_id;
END;
$$;
$forward_13$;
  END IF;
END $legacy_13$;

-- public.crm_resolve_form_error_v1(uuid)
DO $legacy_14$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_resolve_form_error_v1(uuid)') IS NOT NULL THEN
    EXECUTE $forward_14$
CREATE OR REPLACE FUNCTION public.crm_resolve_form_error_v1(p_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_changed integer;
BEGIN
  IF NOT (core.staff_authorized_v1(core.staff_legacy_business_v1(),'crm.write')) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  UPDATE core.form_errors SET resolved_at = now(), resolved_by = auth.uid() WHERE id = p_id AND resolved_at IS NULL;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END $$;
$forward_14$;
  END IF;
END $legacy_14$;

-- public.crm_update_catering(uuid,text,text,timestamptz)
DO $legacy_15$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_update_catering(uuid,text,text,timestamptz)') IS NOT NULL THEN
    EXECUTE $forward_15$
CREATE OR REPLACE FUNCTION public.crm_update_catering(p_request_id uuid, p_status text, p_assigned_to text, p_follow_up_at timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE v_assigned_to text := regexp_replace(coalesce(p_assigned_to, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
BEGIN
  IF NOT (core.staff_authorized_v1((SELECT c.business_id FROM core.catering_requests r JOIN core.customers c ON c.id=r.customer_id WHERE r.id=p_request_id),'crm.write')) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
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
  AND core.staff_authorized_v1(c.business_id,'crm.write');
 RETURN FOUND;
END;
$_$;
$forward_15$;
  END IF;
END $legacy_15$;

-- public.crm_staff_authorized_v1()
-- Menu/session precheck only; provider adapters must check their configured business separately.
DO $legacy_16$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_staff_authorized_v1()') IS NOT NULL THEN
    EXECUTE $forward_16$
CREATE OR REPLACE FUNCTION public.crm_staff_authorized_v1() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$ SELECT core.staff_authorized_v1(core.staff_legacy_business_v1(),'crm.read') $$;
$forward_16$;
  END IF;
END $legacy_16$;

-- public.crm_restore_email_consent_v1(uuid,timestamptz,text,text,text,boolean,boolean)
DO $legacy_17$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_restore_email_consent_v1(uuid,timestamptz,text,text,text,boolean,boolean)') IS NOT NULL THEN
    EXECUTE $forward_17$
CREATE OR REPLACE FUNCTION public.crm_restore_email_consent_v1(
  p_customer_id uuid,
  p_customer_requested_at timestamptz,
  p_evidence_source text,
  p_evidence_reference text,
  p_evidence_sha256 text,
  p_customer_initiated boolean,
  p_staff_approved boolean
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_staff uuid := auth.uid();
  v_customer core.customers%ROWTYPE;
  v_latest_suppression timestamptz;
  v_approved_at timestamptz;
  v_event_id uuid;
  v_evidence_id uuid;
  v_source text := pg_catalog.btrim(p_evidence_source);
  v_reference text := pg_catalog.btrim(p_evidence_reference);
  v_sha256 text := pg_catalog.lower(pg_catalog.btrim(p_evidence_sha256));
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR v_staff IS NULL THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  IF NOT core.staff_authorized_v1((SELECT c.business_id FROM core.customers c WHERE c.id=p_customer_id),'consent.restore') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;

  IF p_customer_id IS NULL OR p_customer_requested_at IS NULL
    OR NOT pg_catalog.isfinite(p_customer_requested_at)
    OR p_customer_initiated IS NOT TRUE OR p_staff_approved IS NOT TRUE
    OR v_source IS NULL OR v_source NOT IN (
      'customer_email', 'customer_web', 'customer_in_person', 'customer_signed_document'
    )
    OR v_reference IS NULL OR pg_catalog.length(v_reference) NOT BETWEEN 1 AND 1000
    OR pg_catalog.octet_length(v_reference) > 4000 OR v_reference !~ '[^[:space:]]'
    OR v_sha256 IS NULL OR v_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Dated customer-origin evidence and staff approval are required'
      USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO v_customer FROM core.customers c
    WHERE c.id = p_customer_id FOR UPDATE;
  -- Reauthorize the locked row: a concurrent tenant move must not reuse the
  -- preliminary scope decision from before the lock was acquired.
  IF NOT core.staff_authorized_v1(v_customer.business_id,'consent.restore') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF NOT FOUND OR v_customer.email IS NULL
    OR v_customer.email_status <> 'unsubscribed' THEN
    RAISE EXCEPTION 'Suppressed email customer required' USING ERRCODE = '22023';
  END IF;

  SELECT greatest(v_customer.email_suppressed_at, pg_catalog.max(e.created_at))
    INTO v_latest_suppression
  FROM core.consent_events e
  WHERE e.customer_id = v_customer.id AND e.event_type = 'suppression';
  v_approved_at := pg_catalog.clock_timestamp();
  IF v_latest_suppression IS NULL OR NOT pg_catalog.isfinite(v_latest_suppression)
    OR p_customer_requested_at <= v_latest_suppression
    OR p_customer_requested_at > v_approved_at THEN
    RAISE EXCEPTION 'Customer consent must follow the latest dated suppression'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM core.email_reconsent_evidence e
    WHERE e.customer_id = v_customer.id
      AND (e.evidence_sha256 = v_sha256 OR
        (e.evidence_source = v_source AND e.evidence_reference = v_reference))
  ) THEN
    RAISE EXCEPTION 'Consent evidence has already been used' USING ERRCODE = '22023';
  END IF;

  INSERT INTO core.consent_events(
    customer_id, event_type, source, email_requested, sms_requested,
    evidence_status, note, created_at
  ) VALUES (
    v_customer.id, 'reconsent', v_source, true, false, 'staff_approved',
    'New customer-origin email consent approved by authorized staff.', v_approved_at
  ) RETURNING id INTO v_event_id;

  INSERT INTO core.email_reconsent_evidence(
    consent_event_id, customer_id, identity_key_at_approval,
    previous_suppressed_at, customer_requested_at, evidence_source,
    evidence_reference, evidence_sha256, customer_initiated,
    approved_by, staff_approved, approved_at
  ) VALUES (
    v_event_id, v_customer.id, v_customer.identity_key,
    v_latest_suppression, p_customer_requested_at, v_source,
    v_reference, v_sha256, true, v_staff, true, v_approved_at
  ) RETURNING id INTO v_evidence_id;

  INSERT INTO core.email_reconsent_authorizations(
    customer_id, transaction_id, evidence_id, consent_event_id, previous_suppressed_at
  ) VALUES (
    v_customer.id, pg_catalog.txid_current(), v_evidence_id, v_event_id, v_latest_suppression
  );

  UPDATE core.customers SET email_status = 'subscribed',
    email_suppressed_at = NULL, updated_at = v_approved_at
  WHERE id = v_customer.id;
  IF EXISTS (
    SELECT 1 FROM core.email_reconsent_authorizations a
    WHERE a.customer_id = v_customer.id AND a.transaction_id = pg_catalog.txid_current()
  ) THEN
    RAISE EXCEPTION 'Consent authorization was not consumed' USING ERRCODE = '42501';
  END IF;

  -- Provider observations and provider suppressions are deliberately untouched.
  RETURN v_event_id;
END
$function$;
$forward_17$;
  END IF;
END $legacy_17$;

-- public.list_offers(uuid)
DO $legacy_18$ BEGIN
  IF pg_catalog.to_regprocedure('public.list_offers(uuid)') IS NOT NULL THEN
    EXECUTE $forward_18$
CREATE OR REPLACE FUNCTION public.list_offers(p_business_id uuid)
RETURNS TABLE(
  id uuid, name text, description text, code text, channel_target text,
  starts_at date, ends_at date, active boolean, offer_status text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT (core.staff_authorized_v1(p_business_id,'crm.read')) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF p_business_id IS NULL THEN
    RAISE EXCEPTION 'Business ID required' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  SELECT o.id, o.name, o.description, o.code, o.channel_target,
    o.starts_at, o.ends_at, o.active,
    CASE
      WHEN NOT o.active THEN 'inactive'
      WHEN (pg_catalog.now() AT TIME ZONE b.timezone)::date < o.starts_at THEN 'scheduled'
      WHEN (pg_catalog.now() AT TIME ZONE b.timezone)::date > o.ends_at THEN 'ended'
      ELSE 'live'
    END::text
  FROM core.offers o JOIN core.businesses b ON b.id = o.business_id
  WHERE o.business_id = p_business_id
  ORDER BY o.starts_at DESC, o.id;
END
$function$;
$forward_18$;
  END IF;
END $legacy_18$;

-- public.crm_profile_sync_queue_v1(uuid)
DO $legacy_19$ BEGIN
  IF pg_catalog.to_regprocedure('public.crm_profile_sync_queue_v1(uuid)') IS NOT NULL THEN
    EXECUTE $forward_19$
CREATE OR REPLACE FUNCTION public.crm_profile_sync_queue_v1(p_business_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_items jsonb; v_counts jsonb;
BEGIN
  IF NOT (core.staff_authorized_v1(p_business_id,'crm.read')) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF p_business_id IS NULL OR NOT EXISTS(SELECT 1 FROM core.businesses WHERE id=p_business_id) THEN
    RAISE EXCEPTION 'Invalid business' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)),'[]'::jsonb) INTO v_items FROM (
    SELECT id AS "jobId",customer_id AS "customerId",provider_account AS account,status,
      attempts,6 AS "maxAttempts",next_attempt_at AS "nextAttemptAt",
      lease_expires_at AS "leaseExpiresAt",updated_at AS "updatedAt",
      last_success_at AS "lastSuccessAt",last_error_code AS "lastErrorCode"
    FROM core.klaviyo_profile_sync_jobs WHERE business_id=p_business_id
    ORDER BY updated_at DESC,id LIMIT 100
  ) x;
  SELECT pg_catalog.jsonb_build_object('total',count(*),
    'queued',count(*) FILTER(WHERE status='queued'),'running',count(*) FILTER(WHERE status='running'),
    'retry',count(*) FILTER(WHERE status='retry'),'succeeded',count(*) FILTER(WHERE status='succeeded'),
    'failed',count(*) FILTER(WHERE status='failed'),'blocked',count(*) FILTER(WHERE status='blocked'))
    INTO v_counts FROM core.klaviyo_profile_sync_jobs WHERE business_id=p_business_id;
  RETURN pg_catalog.jsonb_build_object('items',v_items,'counts',v_counts);
END
$$;
$forward_19$;
  END IF;
END $legacy_19$;

-- core.ops_assert_staff()
DO $legacy_20$ BEGIN
  IF pg_catalog.to_regprocedure('core.ops_assert_staff()') IS NOT NULL THEN
    EXECUTE $forward_20$
CREATE OR REPLACE FUNCTION core.ops_assert_staff() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
  IF NOT (core.staff_authorized_v1(core.staff_legacy_business_v1(),'ops.read')) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
END $fn$;
$forward_20$;
  END IF;
END $legacy_20$;

-- public.ops_actions_v()
DO $legacy_21$ BEGIN
  IF pg_catalog.to_regprocedure('public.ops_actions_v()') IS NOT NULL THEN
    EXECUTE $forward_21$
CREATE OR REPLACE FUNCTION public.ops_actions_v() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE items jsonb;
BEGIN
 IF NOT core.staff_authorized_v1(core.staff_legacy_business_v1(),'ops.read') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
 SELECT coalesce(jsonb_agg(core.ops_safe_action(a) ORDER BY a.requested_at DESC),'[]') INTO items
 FROM(SELECT * FROM core.ops_actions WHERE business_id=core.staff_legacy_business_v1() ORDER BY requested_at DESC LIMIT 50)a;
 RETURN jsonb_build_object('items',items);
END $fn$;
$forward_21$;
  END IF;
END $legacy_21$;

-- public.ops_connections_v()
DO $legacy_22$ BEGIN
  IF pg_catalog.to_regprocedure('public.ops_connections_v()') IS NOT NULL THEN
    EXECUTE $forward_22$
CREATE OR REPLACE FUNCTION public.ops_connections_v() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE items jsonb;
BEGIN
 IF NOT core.staff_authorized_v1(core.staff_legacy_business_v1(),'ops.read') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('source',source,'status',status,'last_ok_at',last_ok_at,'last_error',last_error,'note',note,'capabilities',core.ops_capabilities(source)) ORDER BY source),'[]') INTO items
 FROM core.ops_connections WHERE business_id=core.staff_legacy_business_v1();
 RETURN jsonb_build_object('items',items);
END $fn$;
$forward_22$;
  END IF;
END $legacy_22$;

-- public.ops_dashboard_v()
DO $legacy_23$ BEGIN
  IF pg_catalog.to_regprocedure('public.ops_dashboard_v()') IS NOT NULL THEN
    EXECUTE $forward_23$
CREATE OR REPLACE FUNCTION public.ops_dashboard_v() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE metrics jsonb; jobs jsonb;
BEGIN
 IF NOT core.staff_authorized_v1(core.staff_legacy_business_v1(),'ops.read') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(m)-'id'-'business_id'),'[]') INTO metrics FROM(
 SELECT DISTINCT ON(source,metric) * FROM core.ops_metrics
 WHERE business_id=core.staff_legacy_business_v1() AND NOT is_test
 ORDER BY source,metric,CASE WHEN period_start IS NULL OR
 (period_start>=date_trunc('month',now() AT TIME ZONE 'America/New_York')::date AND period_end<=(now() AT TIME ZONE 'America/New_York')::date)
 OR (period_start=(now() AT TIME ZONE 'America/New_York')::date-1 AND period_end=period_start)
 OR (period_start=(now() AT TIME ZONE 'America/New_York')::date-7 AND period_end>=(now() AT TIME ZONE 'America/New_York')::date-1)
 THEN 0 ELSE 1 END,collected_at DESC,period_end DESC LIMIT 1000)m;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',action,'failed_at',finished_at)),'[]') INTO jobs
 FROM core.ops_actions a WHERE business_id=core.staff_legacy_business_v1() AND action='collect' AND status='failed'
 AND requested_at>=now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM core.ops_actions r WHERE r.retry_of=a.id);
 RETURN jsonb_build_object('business_id',core.staff_legacy_business_v1(),'generated_at',now(),'metrics',metrics,'offers',core.ops_offer_catalog(),'failed_jobs',jobs,'campaigns','[]'::jsonb,'products','[]'::jsonb);
END $fn$;
$forward_23$;
  END IF;
END $legacy_23$;

-- public.ops_request_action(text,jsonb)
DO $legacy_24$ BEGIN
  IF pg_catalog.to_regprocedure('public.ops_request_action(text,jsonb)') IS NOT NULL THEN
    EXECUTE $forward_24$
CREATE OR REPLACE FUNCTION public.ops_request_action(p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE row core.ops_actions; target uuid; allowed text[]; v_request_key uuid; fingerprint text; not_ready boolean:=false;
BEGIN
 IF NOT core.staff_authorized_v1(core.staff_legacy_business_v1(),'ops.write') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
 IF p_action NOT IN('collect','sync_clover_csv','retry_failed_job','offer_set_active','ads_set_status','product_set_channel','commission_report') OR p_action IS NULL
 OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>1100000 THEN RAISE EXCEPTION 'Invalid ops action' USING ERRCODE='22023'; END IF;
 allowed:=CASE p_action WHEN 'collect' THEN ARRAY[]::text[] WHEN 'sync_clover_csv' THEN ARRAY['csv','fileName','periodStart','periodEnd']
 WHEN 'retry_failed_job' THEN ARRAY['actionId'] WHEN 'offer_set_active' THEN ARRAY['offerId','active','approvalReference']
 WHEN 'ads_set_status' THEN ARRAY['source','campaignId','status'] WHEN 'product_set_channel' THEN ARRAY['productId','channel','available'] ELSE ARRAY['month'] END;
 allowed:=array_append(allowed,'clientRequestId');
 IF coalesce(p_payload->>'clientRequestId','') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'Invalid client request key' USING ERRCODE='22023'; END IF;
 v_request_key:=(p_payload->>'clientRequestId')::uuid; fingerprint:=md5(p_action||p_payload::text);
 SELECT * INTO row FROM core.ops_actions a WHERE a.business_id=core.staff_legacy_business_v1() AND a.request_key=v_request_key;
 IF FOUND THEN
  IF row.requested_by<>auth.uid() OR row.request_fingerprint<>fingerprint THEN RAISE EXCEPTION 'Conflicting request key' USING ERRCODE='22023'; END IF;
  RETURN core.ops_safe_action(row);
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload)k WHERE NOT k=ANY(allowed)) THEN RAISE EXCEPTION 'Unsupported action fields' USING ERRCODE='22023'; END IF;
 -- A grey action is a logged intent, not an attempt to mutate an unknown target.
 -- Do this before connected-target validation so {} is a truthful not_connected receipt.
 not_ready:=p_action IN('ads_set_status','product_set_channel') OR
 (p_action IN('offer_set_active','retry_failed_job','commission_report') AND NOT(core.ops_capabilities('supabase') ? p_action));
 IF not_ready THEN
  INSERT INTO core.ops_actions(business_id,action,requested_by,payload,request_key,request_fingerprint,status,result,finished_at)
  VALUES(core.staff_legacy_business_v1(),p_action,auth.uid(),'{}',v_request_key,fingerprint,'not_connected',jsonb_build_object('code','capability_not_connected','message','Bağlantı veya doğrulanmış yetki bekleniyor; işlem uygulanmadı.'),now()) RETURNING * INTO row;
  RETURN core.ops_safe_action(row);
 END IF;
 IF p_action='sync_clover_csv' AND (coalesce(jsonb_typeof(p_payload->'csv'),'')<>'string' OR octet_length(p_payload->>'csv') NOT BETWEEN 1 AND 1048576
 OR coalesce(length(p_payload->>'fileName'),0) NOT BETWEEN 1 AND 120 OR coalesce(p_payload->>'periodStart','') !~ '^\d{4}-\d{2}-\d{2}$' OR coalesce(p_payload->>'periodEnd','') !~ '^\d{4}-\d{2}-\d{2}$') THEN RAISE EXCEPTION 'Invalid CSV input' USING ERRCODE='22023'; END IF;
 IF p_action='offer_set_active' AND (coalesce(p_payload->>'offerId','') !~* '^[a-f0-9-]{36}$' OR coalesce(jsonb_typeof(p_payload->'active'),'')<>'boolean' OR length(coalesce(p_payload->>'approvalReference',''))>300) THEN RAISE EXCEPTION 'Invalid offer input' USING ERRCODE='22023'; END IF;
 IF p_action='ads_set_status' AND (coalesce(p_payload->>'source','') NOT IN('google_ads','meta') OR coalesce(p_payload->>'campaignId','') !~ '^[0-9]{1,30}$' OR coalesce(p_payload->>'status','') NOT IN('ENABLED','PAUSED')) THEN RAISE EXCEPTION 'Invalid ad input' USING ERRCODE='22023'; END IF;
 IF p_action='product_set_channel' AND (coalesce(p_payload->>'productId','') !~ '^[A-Za-z0-9_-]{1,80}$' OR coalesce(p_payload->>'channel','') NOT IN('pickup','delivery','dine-in','catering') OR coalesce(jsonb_typeof(p_payload->'available'),'')<>'boolean') THEN RAISE EXCEPTION 'Invalid product input' USING ERRCODE='22023'; END IF;
 IF p_action='commission_report' AND coalesce(p_payload->>'month','') !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'Invalid month' USING ERRCODE='22023'; END IF;
 IF p_action='retry_failed_job' THEN
  IF coalesce(p_payload->>'actionId','') !~* '^[a-f0-9-]{36}$' THEN RAISE EXCEPTION 'Invalid retry' USING ERRCODE='22023'; END IF;
  target:=(p_payload->>'actionId')::uuid;
  PERFORM 1 FROM core.ops_actions WHERE id=target AND business_id=core.staff_legacy_business_v1() AND action='collect' AND status='failed' AND requested_at>=now()-interval '24 hours' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only a known failed manual collection can be retried once' USING ERRCODE='22023'; END IF;
 END IF;
 INSERT INTO core.ops_actions(business_id,action,requested_by,payload,retry_of,request_key,request_fingerprint) VALUES(core.staff_legacy_business_v1(),p_action,auth.uid(),p_payload-'clientRequestId',target,v_request_key,fingerprint) RETURNING * INTO row;
 RETURN core.ops_safe_action(row);
END $fn$;
$forward_24$;
  END IF;
END $legacy_24$;

-- public.ops_claim_action(uuid,uuid)
-- Service-only execution rechecks persisted requester membership; no caller-supplied actor grants authorization.
DO $legacy_25$ BEGIN
  IF pg_catalog.to_regprocedure('public.ops_claim_action(uuid,uuid)') IS NOT NULL THEN
    EXECUTE $forward_25$
CREATE OR REPLACE FUNCTION public.ops_claim_action(p_action_id uuid,p_user_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE row core.ops_actions;
BEGIN
  IF NOT ((auth.role() IS NOT DISTINCT FROM 'service_role' AND EXISTS (SELECT 1 FROM core.ops_actions a JOIN core.business_staff s ON s.business_id=a.business_id AND s.staff_id=a.requested_by AND s.active WHERE a.id=p_action_id AND a.requested_by=p_user_id AND a.business_id=core.staff_legacy_business_v1()))) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
 UPDATE core.ops_actions SET status='running',claim_token=gen_random_uuid()
 WHERE id=p_action_id AND business_id=core.staff_legacy_business_v1() AND requested_by=p_user_id AND status='queued'
   AND EXISTS(SELECT 1 FROM core.business_staff s WHERE s.business_id=core.ops_actions.business_id
     AND s.staff_id=core.ops_actions.requested_by AND s.active)
 RETURNING * INTO row;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id',row.id,'request_key',row.request_key,'action',row.action,'payload',row.payload,'claim_token',row.claim_token,'requested_by',row.requested_by,'requested_at',row.requested_at);
END $fn$;
$forward_25$;
  END IF;
END $legacy_25$;

-- public.clover_order_match_queue_v1(uuid)
DO $legacy_26$ BEGIN
  IF pg_catalog.to_regprocedure('public.clover_order_match_queue_v1(uuid)') IS NOT NULL THEN
    EXECUTE $forward_26$
CREATE OR REPLACE FUNCTION public.clover_order_match_queue_v1(p_business_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT core.staff_authorized_v1(p_business_id,'orders.read') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  RETURN COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
     'reviewId',r.id,'orderId',r.order_id,'cloverOrderId',o.clover_order_id,
     'candidateCustomerIds',r.candidate_customer_ids,'createdAt',r.created_at)
     ORDER BY r.created_at) FROM core.order_match_review r JOIN core.orders o ON o.id=r.order_id
     WHERE r.business_id=p_business_id AND r.status='open'),'[]'::jsonb);
END $$;
$forward_26$;
  END IF;
END $legacy_26$;

-- public.clover_order_day_totals_v1(uuid,timestamptz,timestamptz)
DO $legacy_27$ BEGIN
  IF pg_catalog.to_regprocedure('public.clover_order_day_totals_v1(uuid,timestamptz,timestamptz)') IS NOT NULL THEN
    EXECUTE $forward_27$
CREATE OR REPLACE FUNCTION public.clover_order_day_totals_v1(p_business_id uuid,p_start timestamptz,p_end timestamptz) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NOT core.staff_authorized_v1(p_business_id,'orders.read') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  RETURN CASE WHEN p_start IS NULL OR p_end IS NULL OR p_end<=p_start OR p_end>p_start+interval '1 day'
   THEN NULL ELSE
   (SELECT pg_catalog.jsonb_build_object('orderCount',count(*),'paidOrderCount',count(*) FILTER
       (WHERE s.paid_cents>0),'paidCents',COALESCE(sum(s.paid_cents),0),
       'refundedCents',COALESCE(sum(s.refunded_cents),0),'netCents',COALESCE(sum(s.net_cents),0),
       'refundUnverifiedCount',count(*) FILTER (WHERE o.raw_response->>'refundsVerified'='false'),
       'customerAccessDeniedCount',count(*) FILTER
         (WHERE o.online_order AND o.raw_response->>'customerAccess'='denied'),
       'reconciliationConfirmed',count(*) FILTER (WHERE o.raw_response->>'refundsVerified'='false')=0)
    FROM core.orders o CROSS JOIN LATERAL core.clover_order_status_v1(o.id) s
    WHERE o.business_id=p_business_id AND o.created_at>=p_start AND o.created_at<p_end) END;
END $$;
$forward_27$;
  END IF;
END $legacy_27$;

-- public.clover_order_match_resolve_v1(uuid,uuid,uuid)
DO $legacy_28$ BEGIN
  IF pg_catalog.to_regprocedure('public.clover_order_match_resolve_v1(uuid,uuid,uuid)') IS NOT NULL THEN
    EXECUTE $forward_28$
CREATE OR REPLACE FUNCTION public.clover_order_match_resolve_v1(p_business_id uuid,p_review_id uuid,p_customer_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_review core.order_match_review%ROWTYPE;
BEGIN
  IF NOT (core.staff_authorized_v1(p_business_id,'orders.match')) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_review FROM core.order_match_review
    WHERE id=p_review_id AND business_id=p_business_id AND status='open' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF p_customer_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM core.customers
    WHERE id=p_customer_id AND business_id=p_business_id) THEN
    RAISE EXCEPTION 'Invalid customer' USING ERRCODE='22023';
  END IF;
  UPDATE core.orders SET customer_id=p_customer_id,match_status=CASE WHEN p_customer_id IS NULL
    THEN 'unmatched' ELSE 'staff_resolved' END,match_source='staff' WHERE id=v_review.order_id;
  UPDATE core.order_match_review SET status=CASE WHEN p_customer_id IS NULL THEN 'left_unmatched'
    ELSE 'resolved' END,resolved_by=auth.uid(),resolved_at=clock_timestamp() WHERE id=p_review_id;
  RETURN true;
END $$;
$forward_28$;
  END IF;
END $legacy_28$;

-- Storage read policies must use the report path's target business, never the
-- global menu boolean. The public narrow wrapper carries the same actor JWT.
DO $legacy_storage$
BEGIN
  IF pg_catalog.to_regclass('storage.objects') IS NOT NULL
    AND EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='nazar_ops_report_read') THEN
    EXECUTE $policy$ALTER POLICY nazar_ops_report_read ON storage.objects USING (
      bucket_id='nazar-ops' AND CASE
        WHEN name ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/ops/commission/[0-9]{4}-[0-9]{2}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pdf$'
        THEN public.staff_business_authorized_v1(pg_catalog.split_part(name,'/',1)::uuid,'ops.read')
        ELSE false END)$policy$;
    EXECUTE $policy$ALTER POLICY nazar_ops_report_staff_guard ON storage.objects USING (
      bucket_id<>'nazar-ops' OR CASE
        WHEN name ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/ops/commission/[0-9]{4}-[0-9]{2}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.pdf$'
        THEN public.staff_business_authorized_v1(pg_catalog.split_part(name,'/',1)::uuid,'ops.read')
        ELSE false END)$policy$;
  END IF;
END $legacy_storage$;

NOTIFY pgrst,'reload schema';
COMMIT;
