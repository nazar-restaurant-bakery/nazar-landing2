-- K7: private, idempotent Clover order ledger. Apply identical LF bytes with psql 18.6.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('clover_order_core_v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('core.businesses') IS NULL
    OR pg_catalog.to_regclass('core.customers') IS NULL
    OR pg_catalog.to_regclass('core.crm_staff') IS NULL
    OR pg_catalog.to_regprocedure('public.crm_staff_authorized_v1()') IS NULL THEN
    RAISE EXCEPTION 'K7_BASELINE_REQUIRED';
  END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE') THEN
    RAISE EXCEPTION 'K7_CORE_MUST_BE_PRIVATE';
  END IF;
END $preflight$;

CREATE TABLE core.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  clover_order_id text NOT NULL CHECK (clover_order_id ~ '^[A-Za-z0-9]{8,32}$'),
  clover_merchant_id text NOT NULL CHECK (clover_merchant_id ~ '^[A-Za-z0-9]{8,32}$'),
  clover_order_type_id text NOT NULL,
  online_order boolean NOT NULL,
  created_at timestamptz NOT NULL,
  modified_at timestamptz,
  clover_state text,
  order_total_cents bigint CHECK (order_total_cents >= 0),
  customer_email_normalized text,
  customer_phone_e164 text,
  customer_id uuid REFERENCES core.customers(id),
  match_status text NOT NULL DEFAULT 'unmatched'
    CHECK (match_status IN ('exact','ambiguous','unmatched','staff_resolved')),
  match_source text CHECK (match_source IN ('automatic','staff')),
  raw_response jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(raw_response)='object'),
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id, clover_order_id),
  UNIQUE (id, business_id),
  CHECK (online_order OR (customer_email_normalized IS NULL AND customer_phone_e164 IS NULL AND customer_id IS NULL))
);
CREATE INDEX orders_by_business_day ON core.orders (business_id,created_at);
CREATE INDEX orders_by_customer ON core.orders (business_id,customer_id) WHERE customer_id IS NOT NULL;

CREATE TABLE core.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  order_id uuid NOT NULL,
  clover_item_id text NOT NULL CHECK (clover_item_id ~ '^[A-Za-z0-9]{8,32}$'),
  name text,
  quantity numeric(18,3),
  price_cents bigint,
  raw_response jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(raw_response)='object'),
  FOREIGN KEY (order_id,business_id) REFERENCES core.orders(id,business_id),
  UNIQUE (business_id,clover_item_id)
);
CREATE TABLE core.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  order_id uuid NOT NULL,
  clover_payment_id text NOT NULL CHECK (clover_payment_id ~ '^[A-Za-z0-9]{8,32}$'),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  payment_status text,
  created_at timestamptz,
  raw_response jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(raw_response)='object'),
  FOREIGN KEY (order_id,business_id) REFERENCES core.orders(id,business_id),
  UNIQUE (business_id,clover_payment_id)
);
CREATE TABLE core.refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_id uuid,
  clover_refund_id text NOT NULL CHECK (clover_refund_id ~ '^[A-Za-z0-9]{8,32}$'),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  created_at timestamptz,
  raw_response jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(raw_response)='object'),
  FOREIGN KEY (order_id,business_id) REFERENCES core.orders(id,business_id),
  FOREIGN KEY (payment_id) REFERENCES core.payments(id),
  UNIQUE (business_id,clover_refund_id)
);
CREATE TABLE core.order_match_review (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  order_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('multiple_customers','conflicting_identifiers')),
  candidate_customer_ids uuid[] NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','left_unmatched')),
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (order_id,business_id) REFERENCES core.orders(id,business_id),
  UNIQUE (business_id,order_id)
);
CREATE INDEX order_match_review_open ON core.order_match_review(business_id,created_at) WHERE status='open';

ALTER TABLE core.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.order_match_review ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.orders,core.order_items,core.payments,core.refunds,core.order_match_review
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION core.clover_email_normalize_v1(p_email text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=''
AS $$ SELECT CASE WHEN pg_catalog.length(pg_catalog.btrim(p_email)) BETWEEN 3 AND 254
  AND pg_catalog.btrim(p_email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  THEN pg_catalog.lower(pg_catalog.btrim(p_email)) ELSE NULL END $$;

-- Nazar's current customer base is US-only. A non-US number is accepted only
-- when it already arrives with an explicit international + prefix.
CREATE FUNCTION core.clover_phone_e164_v1(p_phone text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=''
AS $$
DECLARE digits text;
BEGIN
  IF p_phone IS NULL THEN RETURN NULL; END IF;
  digits := pg_catalog.regexp_replace(p_phone,'[^0-9]','','g');
  IF p_phone ~ '^\+' AND pg_catalog.length(digits) BETWEEN 8 AND 15 THEN RETURN '+'||digits; END IF;
  IF pg_catalog.length(digits)=10 THEN RETURN '+1'||digits; END IF;
  IF pg_catalog.length(digits)=11 AND pg_catalog.left(digits,1)='1' THEN RETURN '+'||digits; END IF;
  RETURN NULL;
END $$;

-- This is the only interpretation of financial order status. An order's total
-- or Clover order state by itself never proves a captured payment.
CREATE FUNCTION core.clover_order_status_v1(p_order_id uuid)
RETURNS TABLE(status text,paid_cents bigint,refunded_cents bigint,net_cents bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT CASE WHEN COALESCE(r.refunded,0)>0 THEN 'refunded'
         WHEN COALESCE(p.paid,0)>0 THEN 'paid'
         WHEN pg_catalog.upper(COALESCE(o.clover_state,'')) IN ('CANCELED','CANCELLED','VOIDED') THEN 'cancelled'
         ELSE 'pending' END,
    COALESCE(p.paid,0),COALESCE(r.refunded,0),COALESCE(p.paid,0)-COALESCE(r.refunded,0)
  FROM core.orders o
  LEFT JOIN LATERAL (SELECT sum(x.amount_cents)::bigint AS paid FROM core.payments x
    WHERE x.order_id=o.id AND pg_catalog.upper(COALESCE(x.payment_status,''))='SUCCESS') p ON true
  LEFT JOIN LATERAL (SELECT sum(x.amount_cents)::bigint AS refunded FROM core.refunds x
    WHERE x.order_id=o.id AND COALESCE(x.raw_response->>'voided','false')<>'true') r ON true
  WHERE o.id=p_order_id
$$;

-- Complete, validated order snapshots are supplied by the bounded manual pull.
-- Each order is one transaction; a failed snapshot cannot partially replace it.
CREATE FUNCTION public.clover_order_ingest_v1(p_business_id uuid,p_merchant_id text,p_snapshot jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_order core.orders%ROWTYPE; v_obj jsonb; v_child jsonb;
  v_email text; v_phone text; v_matches uuid[]; v_match_count integer;
  v_payment_id uuid; v_payment_ref text; v_online boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF p_business_id IS NULL OR NOT EXISTS(SELECT 1 FROM core.businesses WHERE id=p_business_id)
    OR p_merchant_id !~ '^[A-Za-z0-9]{8,32}$' OR pg_catalog.jsonb_typeof(p_snapshot)<>'object'
    OR p_snapshot->>'id' !~ '^[A-Za-z0-9]{8,32}$'
    OR pg_catalog.jsonb_typeof(p_snapshot->'items')<>'array'
    OR pg_catalog.jsonb_typeof(p_snapshot->'payments')<>'array'
    OR pg_catalog.jsonb_typeof(p_snapshot->'refunds')<>'array'
    OR (p_snapshot->>'createdTime') !~ '^[0-9]{12,14}$'
    OR (p_snapshot->>'online') NOT IN ('true','false') THEN
    RAISE EXCEPTION 'Invalid Clover snapshot' USING ERRCODE='22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_business_id::text||':'||(p_snapshot->>'id'),7));
  v_online := (p_snapshot->>'online')::boolean;
  v_email := CASE WHEN v_online THEN core.clover_email_normalize_v1(p_snapshot->>'customerEmail') ELSE NULL END;
  v_phone := CASE WHEN v_online THEN core.clover_phone_e164_v1(p_snapshot->>'customerPhone') ELSE NULL END;
  INSERT INTO core.orders (business_id,clover_order_id,clover_merchant_id,clover_order_type_id,
    online_order,created_at,modified_at,clover_state,order_total_cents,
    customer_email_normalized,customer_phone_e164,raw_response)
  VALUES (p_business_id,p_snapshot->>'id',p_merchant_id,COALESCE(p_snapshot->>'orderTypeId',''),
    v_online,pg_catalog.to_timestamp((p_snapshot->>'createdTime')::double precision/1000),
    CASE WHEN p_snapshot->>'modifiedTime' ~ '^[0-9]{12,14}$' THEN
      pg_catalog.to_timestamp((p_snapshot->>'modifiedTime')::double precision/1000) END,
    p_snapshot->>'state',CASE WHEN p_snapshot->>'total' ~ '^[0-9]{1,12}$' THEN (p_snapshot->>'total')::bigint END,
    v_email,v_phone,p_snapshot)
  ON CONFLICT (business_id,clover_order_id) DO UPDATE SET
    modified_at=EXCLUDED.modified_at,clover_state=EXCLUDED.clover_state,
    order_total_cents=EXCLUDED.order_total_cents,customer_email_normalized=EXCLUDED.customer_email_normalized,
    customer_phone_e164=EXCLUDED.customer_phone_e164,raw_response=EXCLUDED.raw_response,
    last_seen_at=clock_timestamp()
  RETURNING * INTO v_order;

  FOR v_child IN SELECT value FROM pg_catalog.jsonb_array_elements(p_snapshot->'items') LOOP
    IF v_child->>'id' !~ '^[A-Za-z0-9]{8,32}$' THEN RAISE EXCEPTION 'Invalid item id'; END IF;
    INSERT INTO core.order_items(business_id,order_id,clover_item_id,name,quantity,price_cents,raw_response)
    VALUES(p_business_id,v_order.id,v_child->>'id',v_child->>'name',
      CASE WHEN v_child->>'quantity' ~ '^[0-9]{1,12}(\.[0-9]{1,3})?$' THEN (v_child->>'quantity')::numeric END,
      CASE WHEN v_child->>'price' ~ '^[0-9]{1,12}$' THEN (v_child->>'price')::bigint END,v_child)
    ON CONFLICT (business_id,clover_item_id) DO UPDATE SET name=EXCLUDED.name,
      quantity=EXCLUDED.quantity,price_cents=EXCLUDED.price_cents,raw_response=EXCLUDED.raw_response;
  END LOOP;
  FOR v_child IN SELECT value FROM pg_catalog.jsonb_array_elements(p_snapshot->'payments') LOOP
    IF v_child->>'id' !~ '^[A-Za-z0-9]{8,32}$' OR v_child->>'amount' !~ '^[0-9]{1,12}$'
      THEN RAISE EXCEPTION 'Invalid payment'; END IF;
    INSERT INTO core.payments(business_id,order_id,clover_payment_id,amount_cents,payment_status,created_at,raw_response)
    VALUES(p_business_id,v_order.id,v_child->>'id',(v_child->>'amount')::bigint,v_child->>'result',
      CASE WHEN v_child->>'createdTime' ~ '^[0-9]{12,14}$' THEN pg_catalog.to_timestamp((v_child->>'createdTime')::double precision/1000) END,v_child)
    ON CONFLICT (business_id,clover_payment_id) DO UPDATE SET amount_cents=EXCLUDED.amount_cents,
      payment_status=EXCLUDED.payment_status,raw_response=EXCLUDED.raw_response;
  END LOOP;
  FOR v_child IN SELECT value FROM pg_catalog.jsonb_array_elements(p_snapshot->'refunds') LOOP
    IF v_child->>'id' !~ '^[A-Za-z0-9]{8,32}$' OR v_child->>'amount' !~ '^[0-9]{1,12}$'
      THEN RAISE EXCEPTION 'Invalid refund'; END IF;
    v_payment_ref := v_child#>>'{payment,id}';
    SELECT id INTO v_payment_id FROM core.payments
      WHERE business_id=p_business_id AND order_id=v_order.id AND clover_payment_id=v_payment_ref;
    INSERT INTO core.refunds(business_id,order_id,payment_id,clover_refund_id,amount_cents,created_at,raw_response)
    VALUES(p_business_id,v_order.id,v_payment_id,v_child->>'id',(v_child->>'amount')::bigint,
      CASE WHEN v_child->>'createdTime' ~ '^[0-9]{12,14}$' THEN pg_catalog.to_timestamp((v_child->>'createdTime')::double precision/1000) END,v_child)
    ON CONFLICT (business_id,clover_refund_id) DO UPDATE SET payment_id=EXCLUDED.payment_id,
      amount_cents=EXCLUDED.amount_cents,raw_response=EXCLUDED.raw_response;
  END LOOP;

  -- Staff decisions are stable across subsequent pulls. Nothing here writes
  -- email_status, suppression, signups or provider lists.
  IF v_order.match_source IS DISTINCT FROM 'staff' THEN
    SELECT pg_catalog.array_agg(DISTINCT c.id),count(DISTINCT c.id)
      INTO v_matches,v_match_count FROM core.customers c
      WHERE c.business_id=p_business_id AND v_online AND
        ((v_email IS NOT NULL AND core.clover_email_normalize_v1(c.email)=v_email)
          OR (v_phone IS NOT NULL AND core.clover_phone_e164_v1(c.phone)=v_phone));
    IF COALESCE(v_match_count,0)=1 THEN
      UPDATE core.orders SET customer_id=v_matches[1],match_status='exact',match_source='automatic' WHERE id=v_order.id;
      DELETE FROM core.order_match_review WHERE order_id=v_order.id AND status='open';
    ELSIF COALESCE(v_match_count,0)>1 THEN
      UPDATE core.orders SET customer_id=NULL,match_status='ambiguous',match_source='automatic' WHERE id=v_order.id;
      INSERT INTO core.order_match_review(business_id,order_id,reason,candidate_customer_ids)
      VALUES(p_business_id,v_order.id,'multiple_customers',v_matches)
      ON CONFLICT(business_id,order_id) DO UPDATE SET candidate_customer_ids=EXCLUDED.candidate_customer_ids,
        reason=EXCLUDED.reason,status='open',resolved_by=NULL,resolved_at=NULL;
    ELSE
      UPDATE core.orders SET customer_id=NULL,match_status='unmatched',match_source='automatic' WHERE id=v_order.id;
      DELETE FROM core.order_match_review WHERE order_id=v_order.id AND status='open';
    END IF;
  END IF;
  RETURN pg_catalog.jsonb_build_object('orderId',v_order.id,'cloverOrderId',v_order.clover_order_id,
    'matchStatus',(SELECT match_status FROM core.orders WHERE id=v_order.id),
    'status',(SELECT s.status FROM core.clover_order_status_v1(v_order.id) s));
END $$;

CREATE FUNCTION public.clover_order_match_queue_v1(p_business_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
 SELECT CASE WHEN NOT public.crm_staff_authorized_v1() THEN NULL ELSE
   COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
     'reviewId',r.id,'orderId',r.order_id,'cloverOrderId',o.clover_order_id,
     'candidateCustomerIds',r.candidate_customer_ids,'createdAt',r.created_at)
     ORDER BY r.created_at) FROM core.order_match_review r JOIN core.orders o ON o.id=r.order_id
     WHERE r.business_id=p_business_id AND r.status='open'),'[]'::jsonb) END
$$;

-- Compare a closed Clover report day using the same explicit time interval and
-- order population. Client supplies the report's start/end in its time zone.
CREATE FUNCTION public.clover_order_day_totals_v1(p_business_id uuid,p_start timestamptz,p_end timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
 SELECT CASE WHEN NOT public.crm_staff_authorized_v1()
   OR p_start IS NULL OR p_end IS NULL OR p_end<=p_start OR p_end>p_start+interval '1 day'
   THEN NULL ELSE
   (SELECT pg_catalog.jsonb_build_object('orderCount',count(*),'paidOrderCount',count(*) FILTER
       (WHERE s.paid_cents>0),'paidCents',COALESCE(sum(s.paid_cents),0),
       'refundedCents',COALESCE(sum(s.refunded_cents),0),'netCents',COALESCE(sum(s.net_cents),0))
    FROM core.orders o CROSS JOIN LATERAL core.clover_order_status_v1(o.id) s
    WHERE o.business_id=p_business_id AND o.created_at>=p_start AND o.created_at<p_end) END
$$;

CREATE FUNCTION public.clover_order_match_resolve_v1(p_business_id uuid,p_review_id uuid,p_customer_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_review core.order_match_review%ROWTYPE;
BEGIN
  IF NOT public.crm_staff_authorized_v1() THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
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

REVOKE ALL ON FUNCTION core.clover_email_normalize_v1(text),core.clover_phone_e164_v1(text),
  core.clover_order_status_v1(uuid),public.clover_order_ingest_v1(uuid,text,jsonb),
  public.clover_order_match_queue_v1(uuid),public.clover_order_day_totals_v1(uuid,timestamptz,timestamptz),
  public.clover_order_match_resolve_v1(uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.clover_order_ingest_v1(uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.clover_order_match_queue_v1(uuid),
  public.clover_order_day_totals_v1(uuid,timestamptz,timestamptz),
  public.clover_order_match_resolve_v1(uuid,uuid,uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
