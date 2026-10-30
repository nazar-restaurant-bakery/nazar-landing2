-- K16 follow-up: Clover void/refund returns to site orders. LF bytes, psql 18.6.
-- Hosted Checkout webhooks report only PAYMENT APPROVED/DECLINED. Voids and
-- refunds reach the K7 ledger through the Clover app webhook and the daily pull
-- (clover_order_ingest_v1): a void as core.payments.payment_status='VOIDED',
-- a refund as a core.refunds row. Triggers on those two tables apply the
-- reversal to the matching site order. Existing functions and rows are unchanged;
-- a reversal failure is recorded and never fails the ledger ingest.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('site_order_clover_reversal_v1',0));

DO $guard$ BEGIN
  IF pg_catalog.to_regclass('core.orders') IS NULL
    OR pg_catalog.to_regclass('core.payments') IS NULL
    OR pg_catalog.to_regclass('core.refunds') IS NULL
    OR pg_catalog.to_regclass('core.site_orders') IS NULL
    OR pg_catalog.to_regclass('core.site_order_payments') IS NULL
    OR pg_catalog.to_regclass('core.site_order_tickets') IS NULL
    OR pg_catalog.to_regclass('core.site_order_events') IS NULL
    OR pg_catalog.to_regprocedure('public.clover_order_ingest_v1(uuid,text,jsonb)') IS NULL
    OR pg_catalog.to_regprocedure('public.site_order_payment_confirm_v1(uuid,text,text,text,bigint,timestamptz,jsonb)') IS NULL
  THEN RAISE EXCEPTION 'SITE_ORDER_REVERSAL_PREREQUISITE_REQUIRED'; END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
  THEN RAISE EXCEPTION 'SITE_ORDER_REVERSAL_CORE_MUST_BE_PRIVATE'; END IF;
  IF pg_catalog.to_regclass('core.site_order_clover_reversals') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE NOT tgisinternal AND tgname IN
      ('site_order_clover_void_reversal','site_order_clover_refund_reversal'))
  THEN RAISE EXCEPTION 'SITE_ORDER_REVERSAL_ALREADY_INSTALLED'; END IF;
END $guard$;

-- One row per Clover void or refund seen by the ledger, matched or not.
-- 'unmatched' and 'failed' rows are re-evaluated on the next ingest.
CREATE TABLE core.site_order_clover_reversals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  source_key text NOT NULL CHECK (source_key ~ '^(void|refund):[A-Za-z0-9]{8,32}$'),
  source text NOT NULL CHECK (source IN ('clover_payment_void','clover_refund')),
  clover_payment_id text CHECK (clover_payment_id ~ '^[A-Za-z0-9]{8,32}$'),
  amount_cents bigint NOT NULL CHECK (amount_cents>=0),
  refunded_total_cents bigint CHECK (refunded_total_cents>=0),
  outcome text NOT NULL CHECK (outcome IN
    ('reversed','partial_refund','already_reversed','unmatched','failed')),
  reason text CHECK (reason ~ '^[a-z0-9_]{3,60}$'),
  site_order_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(details)='object'),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts>=1),
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (site_order_id,business_id) REFERENCES core.site_orders(id,business_id),
  UNIQUE (business_id,source_key),
  CHECK ((outcome IN ('unmatched','failed')) = (reason IS NOT NULL))
);
CREATE INDEX site_order_clover_reversals_open ON core.site_order_clover_reversals
  (business_id,last_seen_at) WHERE outcome IN ('unmatched','failed');
ALTER TABLE core.site_order_clover_reversals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.site_order_clover_reversals FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE core.site_order_clover_reversals_id_seq FROM PUBLIC,anon,authenticated,service_role;

-- Match by Clover payment ID and merchant, then by amount. A full reversal
-- refunds payment and order and cancels open tickets; a completed ticket stays
-- completed and gets its own event. A partial refund is an event only.
CREATE FUNCTION core.site_order_clover_reversal_apply_v1(
  p_business_id uuid,p_merchant_id text,p_source text,p_source_ref text,
  p_clover_payment_id text,p_amount_cents bigint,p_refunded_total_cents bigint,p_details jsonb
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_key text; v_prev core.site_order_clover_reversals%ROWTYPE;
  v_pay core.site_order_payments%ROWTYPE; v_order core.site_orders%ROWTYPE;
  v_matches integer; v_outcome text; v_reason text; v_site_order uuid;
  v_cancelled integer:=0; v_completed integer:=0; v_info jsonb;
BEGIN
  IF p_source NOT IN ('clover_payment_void','clover_refund') THEN
    RAISE EXCEPTION 'Invalid reversal source' USING ERRCODE='22023';
  END IF;
  v_key:=CASE p_source WHEN 'clover_payment_void' THEN 'void:' ELSE 'refund:' END||p_source_ref;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_business_id::text||':'||v_key,31));
  SELECT * INTO v_prev FROM core.site_order_clover_reversals
    WHERE business_id=p_business_id AND source_key=v_key FOR UPDATE;
  IF FOUND AND v_prev.outcome NOT IN ('unmatched','failed') THEN RETURN 'duplicate'; END IF;
  v_info:=COALESCE(p_details,'{}'::jsonb)||pg_catalog.jsonb_build_object(
    'source',p_source,'clover_payment_id',p_clover_payment_id,'amount_cents',p_amount_cents,
    'refunded_total_cents',p_refunded_total_cents,'clover_merchant_id',p_merchant_id);

  IF p_clover_payment_id IS NULL OR p_clover_payment_id !~ '^[A-Za-z0-9]{8,32}$' THEN
    v_outcome:='unmatched'; v_reason:='refund_payment_unknown';
  ELSE
    SELECT count(*) INTO v_matches FROM core.site_order_payments
      WHERE business_id=p_business_id AND clover_payment_id=p_clover_payment_id
        AND merchant_id IS NOT DISTINCT FROM p_merchant_id;
    IF v_matches=0 THEN
      v_outcome:='unmatched'; v_reason:='no_site_order_payment';
    ELSIF v_matches>1 THEN
      v_outcome:='unmatched'; v_reason:='ambiguous_site_order_payment';
    ELSE
      SELECT * INTO v_pay FROM core.site_order_payments
        WHERE business_id=p_business_id AND clover_payment_id=p_clover_payment_id
          AND merchant_id=p_merchant_id FOR UPDATE;
      v_site_order:=v_pay.site_order_id;
      IF v_pay.status='refunded' THEN
        v_outcome:='already_reversed';
      ELSIF v_pay.status<>'verified' THEN
        v_outcome:='unmatched'; v_reason:='site_payment_not_verified';
      ELSIF p_amount_cents IS NULL OR p_amount_cents<=0
        OR (p_source='clover_payment_void' AND p_amount_cents<>v_pay.verified_cents)
        OR (p_source='clover_refund' AND (p_refunded_total_cents IS NULL
          OR p_refunded_total_cents<p_amount_cents
          OR p_refunded_total_cents>v_pay.verified_cents)) THEN
        v_outcome:='unmatched'; v_reason:='amount_mismatch';
      ELSIF p_source='clover_refund' AND p_refunded_total_cents<v_pay.verified_cents THEN
        v_outcome:='partial_refund';
      ELSE
        v_outcome:='reversed';
      END IF;
    END IF;
  END IF;

  IF v_outcome='reversed' THEN
    SELECT * INTO v_order FROM core.site_orders
      WHERE id=v_pay.site_order_id AND business_id=p_business_id FOR UPDATE;
    UPDATE core.site_order_payments SET status='refunded' WHERE id=v_pay.id;
    UPDATE core.site_orders SET status='refunded',updated_at=clock_timestamp()
      WHERE id=v_order.id AND status<>'refunded';
    UPDATE core.site_order_tickets SET status='cancelled',updated_at=clock_timestamp()
      WHERE business_id=p_business_id AND site_order_id=v_order.id
        AND status NOT IN ('completed','cancelled');
    GET DIAGNOSTICS v_cancelled=ROW_COUNT;
    SELECT count(*) INTO v_completed FROM core.site_order_tickets
      WHERE business_id=p_business_id AND site_order_id=v_order.id AND status='completed';
    v_info:=v_info||pg_catalog.jsonb_build_object('previous_order_status',v_order.status,
      'tickets_cancelled',v_cancelled,'tickets_completed_unchanged',v_completed);
    INSERT INTO core.site_order_events(business_id,site_order_id,event_key,event_type,details)
    VALUES(p_business_id,v_order.id,'reversal:'||v_key,
      CASE p_source WHEN 'clover_payment_void' THEN 'payment_voided' ELSE 'payment_refunded' END,v_info)
      ON CONFLICT(business_id,event_key) DO NOTHING;
    IF v_completed>0 THEN
      INSERT INTO core.site_order_events(business_id,site_order_id,event_key,event_type,details)
      VALUES(p_business_id,v_order.id,'reversal_ticket:'||v_key,'ticket_completed_before_reversal',v_info)
        ON CONFLICT(business_id,event_key) DO NOTHING;
    END IF;
  ELSIF v_outcome='partial_refund' THEN
    INSERT INTO core.site_order_events(business_id,site_order_id,event_key,event_type,details)
    VALUES(p_business_id,v_site_order,'reversal:'||v_key,'payment_partially_refunded',v_info)
      ON CONFLICT(business_id,event_key) DO NOTHING;
  ELSIF v_outcome='already_reversed' THEN
    INSERT INTO core.site_order_events(business_id,site_order_id,event_key,event_type,details)
    VALUES(p_business_id,v_site_order,'reversal:'||v_key,'payment_reversal_repeated',v_info)
      ON CONFLICT(business_id,event_key) DO NOTHING;
  END IF;

  INSERT INTO core.site_order_clover_reversals(business_id,source_key,source,clover_payment_id,
    amount_cents,refunded_total_cents,outcome,reason,site_order_id,details)
  VALUES(p_business_id,v_key,p_source,
    CASE WHEN p_clover_payment_id ~ '^[A-Za-z0-9]{8,32}$' THEN p_clover_payment_id END,
    GREATEST(COALESCE(p_amount_cents,0),0),p_refunded_total_cents,v_outcome,v_reason,v_site_order,v_info)
  ON CONFLICT(business_id,source_key) DO UPDATE SET outcome=EXCLUDED.outcome,
    reason=EXCLUDED.reason,site_order_id=EXCLUDED.site_order_id,details=EXCLUDED.details,
    amount_cents=EXCLUDED.amount_cents,refunded_total_cents=EXCLUDED.refunded_total_cents,
    attempts=core.site_order_clover_reversals.attempts+1,last_seen_at=clock_timestamp();
  RETURN v_outcome;
END $$;

-- Records a reversal that raised an error; the ledger ingest itself continues.
CREATE FUNCTION core.site_order_clover_reversal_failed_v1(
  p_business_id uuid,p_source text,p_source_ref text,p_clover_payment_id text,
  p_amount_cents bigint,p_sqlstate text
) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  INSERT INTO core.site_order_clover_reversals(business_id,source_key,source,clover_payment_id,
    amount_cents,outcome,reason,details)
  VALUES(p_business_id,
    CASE p_source WHEN 'clover_payment_void' THEN 'void:' ELSE 'refund:' END||p_source_ref,
    p_source,CASE WHEN p_clover_payment_id ~ '^[A-Za-z0-9]{8,32}$' THEN p_clover_payment_id END,
    GREATEST(COALESCE(p_amount_cents,0),0),'failed','apply_error',
    pg_catalog.jsonb_build_object('sqlstate',p_sqlstate))
  ON CONFLICT(business_id,source_key) DO UPDATE SET outcome='failed',reason='apply_error',
    details=EXCLUDED.details,attempts=core.site_order_clover_reversals.attempts+1,
    last_seen_at=clock_timestamp()
  WHERE core.site_order_clover_reversals.outcome IN ('unmatched','failed');
$$;

CREATE FUNCTION core.site_order_clover_void_trigger_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_merchant text; v_state text;
BEGIN
  IF pg_catalog.upper(COALESCE(NEW.payment_status,''))<>'VOIDED' THEN RETURN NULL; END IF;
  BEGIN
    SELECT clover_merchant_id INTO v_merchant FROM core.orders
      WHERE id=NEW.order_id AND business_id=NEW.business_id;
    PERFORM core.site_order_clover_reversal_apply_v1(NEW.business_id,v_merchant,
      'clover_payment_void',NEW.clover_payment_id,NEW.clover_payment_id,
      NEW.amount_cents,NEW.amount_cents,pg_catalog.jsonb_build_object(
        'via','k7_ledger','clover_payment_status',NEW.payment_status));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state=RETURNED_SQLSTATE;
    PERFORM core.site_order_clover_reversal_failed_v1(NEW.business_id,'clover_payment_void',
      NEW.clover_payment_id,NEW.clover_payment_id,NEW.amount_cents,v_state);
  END;
  RETURN NULL;
END $$;

CREATE FUNCTION core.site_order_clover_refund_trigger_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_merchant text; v_payment_ref text; v_total bigint; v_state text;
BEGIN
  -- A voided refund returned no money; it is not a reversal.
  IF COALESCE(NEW.raw_response->>'voided','false')='true' THEN RETURN NULL; END IF;
  BEGIN
    SELECT clover_merchant_id INTO v_merchant FROM core.orders
      WHERE id=NEW.order_id AND business_id=NEW.business_id;
    SELECT p.clover_payment_id INTO v_payment_ref FROM core.payments p WHERE p.id=NEW.payment_id;
    v_payment_ref:=COALESCE(v_payment_ref,NEW.raw_response#>>'{payment,id}');
    SELECT sum(r.amount_cents)::bigint INTO v_total FROM core.refunds r
      LEFT JOIN core.payments p ON p.id=r.payment_id
      WHERE r.business_id=NEW.business_id
        AND COALESCE(r.raw_response->>'voided','false')<>'true'
        AND COALESCE(p.clover_payment_id,r.raw_response#>>'{payment,id}')=v_payment_ref;
    PERFORM core.site_order_clover_reversal_apply_v1(NEW.business_id,v_merchant,
      'clover_refund',NEW.clover_refund_id,v_payment_ref,NEW.amount_cents,v_total,
      pg_catalog.jsonb_build_object('via','k7_ledger','clover_refund_id',NEW.clover_refund_id));
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state=RETURNED_SQLSTATE;
    PERFORM core.site_order_clover_reversal_failed_v1(NEW.business_id,'clover_refund',
      NEW.clover_refund_id,v_payment_ref,NEW.amount_cents,v_state);
  END;
  RETURN NULL;
END $$;

CREATE TRIGGER site_order_clover_void_reversal
  AFTER INSERT OR UPDATE OF payment_status ON core.payments
  FOR EACH ROW EXECUTE FUNCTION core.site_order_clover_void_trigger_v1();
CREATE TRIGGER site_order_clover_refund_reversal
  AFTER INSERT OR UPDATE ON core.refunds
  FOR EACH ROW EXECUTE FUNCTION core.site_order_clover_refund_trigger_v1();

-- Server-only review of reversals that did not reach a site order.
CREATE FUNCTION public.site_order_clover_reversal_review_v1(p_business_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  RETURN COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'sourceKey',r.source_key,'source',r.source,'cloverPaymentId',r.clover_payment_id,
      'amountCents',r.amount_cents,'outcome',r.outcome,'reason',r.reason,
      'siteOrderId',r.site_order_id,'attempts',r.attempts,'lastSeenAt',r.last_seen_at)
      ORDER BY r.last_seen_at DESC)
    FROM (SELECT * FROM core.site_order_clover_reversals
      WHERE business_id=p_business_id AND outcome IN ('unmatched','failed')
      ORDER BY last_seen_at DESC LIMIT 200) r),'[]'::jsonb);
END $$;

REVOKE ALL ON FUNCTION
  core.site_order_clover_reversal_apply_v1(uuid,text,text,text,text,bigint,bigint,jsonb),
  core.site_order_clover_reversal_failed_v1(uuid,text,text,text,bigint,text),
  core.site_order_clover_void_trigger_v1(),core.site_order_clover_refund_trigger_v1(),
  public.site_order_clover_reversal_review_v1(uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.site_order_clover_reversal_review_v1(uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
