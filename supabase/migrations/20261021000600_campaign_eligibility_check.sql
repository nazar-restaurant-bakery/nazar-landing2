-- K10: read-only prospective campaign check for already-paid local Clover orders.
-- Depends only on K7 + reviewed K9/shared-staff contract. No activation, sends,
-- usage reservation, provider call, new identity seed or hosted setup.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('campaign_eligibility_check_v1',0));
DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure('core.staff_authorized_v1(uuid,text)') IS NULL
    OR pg_catalog.to_regprocedure('public.campaign_evaluate_v1(uuid,uuid,uuid,integer,text,uuid,text)') IS NULL
    OR pg_catalog.to_regprocedure('core.campaign_amount_v1(uuid,boolean,boolean)') IS NULL THEN
    RAISE EXCEPTION 'K10_K7_AND_REVIEWED_K9_REQUIRED'; END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE') THEN
    RAISE EXCEPTION 'K10_CORE_MUST_BE_PRIVATE'; END IF;
END $preflight$;

-- A single predicate implementation serves both paths. base is evaluated before
-- fulfillment proof; limits after it in the atomic writer. all is prospective.
-- The private helper performs only reads and does not promise/reserve a right.
CREATE FUNCTION core.campaign_eligibility_rules_v1(p_business_id uuid,p_campaign_id uuid,
  p_order_id uuid,p_units integer,p_stage text DEFAULT 'all')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE c core.campaigns%ROWTYPE; o core.orders%ROWTYPE; customer core.customers%ROWTYPE;
  s record; a record; v_local timestamp; v_period text; v_total bigint;
  v_now timestamptz:=statement_timestamp(); v_remaining jsonb;
BEGIN
  IF p_business_id IS NULL OR p_campaign_id IS NULL OR p_order_id IS NULL OR p_units IS NULL
    OR p_units NOT BETWEEN 1 AND 1000 OR p_stage IS NULL OR p_stage NOT IN('base','limits','all') THEN
    RAISE EXCEPTION 'Invalid campaign eligibility intent' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM core.campaigns WHERE id=p_campaign_id AND business_id=p_business_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('eligible',false,'code','campaign_not_found'); END IF;
  SELECT * INTO o FROM core.orders WHERE id=p_order_id AND business_id=p_business_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('eligible',false,'code','order_not_found'); END IF;
  IF p_stage IN('base','all') THEN
    IF c.status<>'active' THEN RETURN jsonb_build_object('eligible',false,'code','campaign_inactive'); END IF;
    SELECT * INTO s FROM core.clover_order_status_v1(o.id);
    IF s.status<>'paid' OR s.paid_cents<=0 OR s.net_cents<=0 THEN
      RETURN jsonb_build_object('eligible',false,'code','order_not_paid'); END IF;
    IF o.customer_id IS NULL OR o.match_status NOT IN('exact','staff_resolved') THEN
      RETURN jsonb_build_object('eligible',false,'code','order_unmatched'); END IF;
    SELECT * INTO customer FROM core.customers WHERE id=o.customer_id AND business_id=c.business_id;
    IF NOT FOUND OR (c.eligibility='subscribed_only' AND
      (customer.email_status<>'subscribed' OR customer.email_suppressed_at IS NOT NULL))
      OR c.is_test IS DISTINCT FROM customer.is_test THEN
      RETURN jsonb_build_object('eligible',false,'code','customer_ineligible'); END IF;
    IF NOT o.clover_order_type_id=ANY(c.order_type_ids) THEN
      RETURN jsonb_build_object('eligible',false,'code','channel_mismatch'); END IF;
    v_local:=o.created_at AT TIME ZONE c.tz_name;
    IF o.created_at>v_now OR o.created_at<c.starts_at OR o.created_at>=c.ends_at
      OR NOT extract(isodow FROM v_local)::smallint=ANY(c.weekdays)
      OR (c.local_start IS NOT NULL AND (v_local::time<c.local_start OR v_local::time>=c.local_end)) THEN
      RETURN jsonb_build_object('eligible',false,'code','outside_window'); END IF;
    SELECT * INTO a FROM core.campaign_amount_v1(o.id,c.include_tax,c.include_tip);
    IF NOT a.known THEN RETURN jsonb_build_object('eligible',false,'code','amount_evidence_missing'); END IF;
    IF a.amount_cents<c.min_amount_cents THEN RETURN jsonb_build_object('eligible',false,'code','below_minimum'); END IF;
    IF p_units>c.max_units_per_order THEN RETURN jsonb_build_object('eligible',false,'code','per_order_limit'); END IF;
  END IF;
  v_local:=o.created_at AT TIME ZONE c.tz_name;
  v_period:=CASE c.period WHEN 'week' THEN 'week:'||to_char(v_local,'IYYY-"W"IW')
    WHEN 'campaign' THEN 'campaign:'||c.id::text ELSE 'order:'||o.id::text END;
  IF p_stage IN('limits','all') THEN
    SELECT reserved_units INTO STRICT v_total FROM core.campaign_usage WHERE campaign_id=c.id;
    v_remaining:=jsonb_build_object('person',CASE WHEN EXISTS(SELECT 1 FROM core.offer_redemptions
      WHERE campaign_id=c.id AND customer_id=o.customer_id AND period_key=v_period AND quota_reserved)
      THEN 0 ELSE 1 END,'total',CASE WHEN c.max_total_units IS NULL THEN NULL
      ELSE greatest(c.max_total_units-v_total,0) END,'perOrder',c.max_units_per_order);
    IF (v_remaining->>'person')::integer=0 THEN
      RETURN jsonb_build_object('eligible',false,'code','period_limit','periodKey',v_period,'remaining',v_remaining); END IF;
    IF c.max_total_units IS NOT NULL AND v_total+p_units>c.max_total_units THEN
      RETURN jsonb_build_object('eligible',false,'code','total_limit','periodKey',v_period,'remaining',v_remaining); END IF;
  END IF;
  RETURN jsonb_build_object('eligible',true,'code','eligible','periodKey',v_period,
    'evaluatedAt',v_now,'remaining',v_remaining);
END $$;
REVOKE ALL ON FUNCTION core.campaign_eligibility_rules_v1(uuid,uuid,uuid,integer,text)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.campaign_evaluate_v1(p_business_id uuid,p_campaign_id uuid,p_order_id uuid,
  p_units integer DEFAULT 1,p_source text DEFAULT 'clover_trace',p_staff_actor uuid DEFAULT NULL,p_staff_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c core.campaigns%ROWTYPE; o core.orders%ROWTYPE; customer core.customers%ROWTYPE;
  red core.offer_redemptions%ROWTYPE; s record; a record; v_local timestamp; v_period text;
  v_now timestamptz; v_total numeric; v_product_units numeric:=0; v_qty numeric; i record;
  v_discounts jsonb:='[]'::jsonb; v_discount jsonb; v_trace boolean:=false;
  v_trace_units numeric:=0; v_trace_evidence jsonb:='[]'::jsonb; v_match boolean;
  v_percentage text; v_amount text;
  v_void_reason text; v_restore boolean; v_snapshot jsonb; v_eligibility jsonb;
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
  -- Keep the write path's customer lock; predicates are shared with the read-only check.
  SELECT * INTO customer FROM core.customers WHERE id=o.customer_id AND business_id=c.business_id FOR SHARE;
  v_eligibility:=core.campaign_eligibility_rules_v1(c.business_id,c.id,o.id,p_units,'base');
  IF NOT (v_eligibility->>'eligible')::boolean THEN
    RETURN jsonb_build_object('applied',false,'code',v_eligibility->>'code'); END IF;
  v_now:=(v_eligibility->>'evaluatedAt')::timestamptz;
  v_local:=o.created_at AT TIME ZONE c.tz_name;
  SELECT * INTO a FROM core.campaign_amount_v1(o.id,c.include_tax,c.include_tip);
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
  -- Limits remain after fulfillment evidence, preserving the existing evaluator's reason order.
  v_eligibility:=core.campaign_eligibility_rules_v1(c.business_id,c.id,o.id,p_units,'limits');
  IF NOT (v_eligibility->>'eligible')::boolean THEN
    RETURN jsonb_build_object('applied',false,'code',v_eligibility->>'code'); END IF;
  v_period:=v_eligibility->>'periodKey';
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

-- Staff receives only decision/configuration metadata, never provider payloads
-- or customer contact/identity fields. This checks the existing paid snapshot.
CREATE FUNCTION public.campaign_eligibility_check_v1(p_business_id uuid,p_clover_order_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE o core.orders%ROWTYPE; c core.campaigns%ROWTYPE; v_rule jsonb; v_check jsonb;
  v_candidates jsonb:='[]'::jsonb; v_selected jsonb; v_first jsonb; v_unknown jsonb;
  v_count integer:=0; v_unknown_count integer:=0;
  v_known boolean; v_code text; v_context jsonb:=jsonb_build_object('checkedAt',statement_timestamp(),'snapshotAt',NULL);
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated'
    OR NOT core.staff_authorized_v1(p_business_id,'orders.read') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF p_clover_order_id IS NULL OR p_clover_order_id !~ '^[A-Za-z0-9]{8,32}$' THEN
    RAISE EXCEPTION 'Invalid Clover order ID' USING ERRCODE='22023'; END IF;
  SELECT * INTO o FROM core.orders WHERE business_id=p_business_id AND clover_order_id=p_clover_order_id;
  IF NOT FOUND THEN RETURN v_context||jsonb_build_object('known',false,'eligible',NULL,'reason','order_not_synced',
    'campaign',NULL,'remaining',NULL,'candidates',v_candidates); END IF;
  v_context:=v_context||jsonb_build_object('snapshotAt',o.last_seen_at);
  -- Do not infer a gift right from unrelated monetary/percentage campaigns.
  FOR c IN SELECT * FROM core.campaigns WHERE business_id=p_business_id AND status='active'
    AND benefit_type='item' ORDER BY starts_at,id LOOP
    v_rule:=core.campaign_eligibility_rules_v1(p_business_id,c.id,o.id,1,'all');
    IF EXISTS(SELECT 1 FROM core.offer_redemptions WHERE campaign_id=c.id AND order_id=o.id) THEN
      v_rule:=jsonb_build_object('eligible',false,'code','already_applied','remaining',
        CASE WHEN jsonb_typeof(v_rule->'remaining')='object'
          THEN jsonb_set(v_rule->'remaining','{person}','0'::jsonb)
          ELSE jsonb_build_object('person',0,'total',NULL,'perOrder',c.max_units_per_order) END);
    END IF;
    v_code:=v_rule->>'code';
    v_known:=v_code NOT IN('order_unmatched','amount_evidence_missing','order_not_found','campaign_not_found');
    v_check:=jsonb_build_object('known',v_known,'eligible',CASE WHEN v_known THEN (v_rule->>'eligible')::boolean END,
      'reason',v_code,'campaign',jsonb_build_object('id',c.id,'name',c.name,'benefitType',c.benefit_type,
        'targetItemId',c.target_clover_item_id),'remaining',v_rule->'remaining');
    v_candidates:=v_candidates||jsonb_build_array(v_check);
    IF v_first IS NULL THEN v_first:=v_check; END IF;
    IF NOT v_known THEN v_unknown_count:=v_unknown_count+1;
      IF v_unknown IS NULL THEN v_unknown:=v_check; END IF; END IF;
    IF (v_rule->>'eligible')::boolean THEN v_count:=v_count+1; v_selected:=v_check; END IF;
  END LOOP;
  IF v_count>1 OR (v_count=1 AND v_unknown_count>0) THEN RETURN v_context||jsonb_build_object('known',false,'eligible',NULL,'reason','ambiguous_campaign',
    'campaign',NULL,'remaining',NULL,'candidates',v_candidates); END IF;
  IF v_selected IS NULL THEN v_selected:=COALESCE(v_unknown,v_first); END IF;
  IF v_selected IS NULL THEN
    v_code:=CASE WHEN EXISTS(SELECT 1 FROM core.campaigns WHERE business_id=p_business_id AND status='active')
      THEN 'no_item_campaign' ELSE 'no_active_campaign' END;
    RETURN v_context||jsonb_build_object('known',true,'eligible',false,'reason',v_code,
      'campaign',NULL,'remaining',NULL,'candidates',v_candidates); END IF;
  RETURN v_context||v_selected||jsonb_build_object('candidates',v_candidates);
END $$;
REVOKE ALL ON FUNCTION public.campaign_eligibility_check_v1(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.campaign_eligibility_check_v1(uuid,text) TO authenticated;
COMMIT;
