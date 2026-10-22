-- K16 order 18 candidate. Private order/payment/kitchen foundation; no checkout activation.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('site_order_foundation_v1',0));

DO $guard$ BEGIN
  IF to_regclass('core.businesses') IS NULL
    OR to_regclass('core.orders') IS NULL
    OR to_regclass('core.payments') IS NULL
    OR to_regprocedure('core.staff_authorized_v1(uuid,text)') IS NULL
    OR has_schema_privilege('anon','core','USAGE')
    OR has_schema_privilege('authenticated','core','USAGE')
    OR has_schema_privilege('service_role','core','USAGE')
  THEN RAISE EXCEPTION 'K16_PRIVATE_ORDER_PREREQUISITE_REQUIRED'; END IF;
END $guard$;

CREATE TABLE core.site_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('menu','catering')),
  fulfillment_method text NOT NULL CHECK (fulfillment_method IN ('pickup','delivery')),
  customer_name text NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 150),
  customer_email text CHECK (length(customer_email)<=254),
  customer_phone text CHECK (length(customer_phone)<=30),
  requested_at timestamptz NOT NULL,
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines)='array' AND jsonb_array_length(lines)>0),
  preparation_note text NOT NULL DEFAULT '' CHECK (length(preparation_note)<=300),
  subtotal_cents bigint NOT NULL CHECK (subtotal_cents>0),
  tax_cents bigint NOT NULL CHECK (tax_cents>=0),
  total_cents bigint GENERATED ALWAYS AS (subtotal_cents+tax_cents) STORED,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency='USD'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','pending_payment','paid','needs_reschedule','cancelled','refunded')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id,request_id),
  UNIQUE (id,business_id),
  CHECK (nullif(customer_email,'') IS NOT NULL OR nullif(customer_phone,'') IS NOT NULL)
);
CREATE INDEX site_orders_queue ON core.site_orders(business_id,created_at DESC);

CREATE TABLE core.site_order_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  site_order_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider='clover'),
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  merchant_id text NOT NULL CHECK (merchant_id ~ '^[A-Za-z0-9]{8,32}$'),
  checkout_session_id text NOT NULL CHECK (length(checkout_session_id) BETWEEN 8 AND 128),
  clover_payment_id text CHECK (clover_payment_id ~ '^[A-Za-z0-9]{8,32}$'),
  expected_cents bigint NOT NULL CHECK (expected_cents>0),
  verified_cents bigint CHECK (verified_cents>=0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','failed','refunded')),
  verified_at timestamptz,
  clover_order_id uuid,
  clover_payment_record_id uuid REFERENCES core.payments(id),
  raw_response jsonb CHECK (raw_response IS NULL OR jsonb_typeof(raw_response)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (site_order_id,business_id) REFERENCES core.site_orders(id,business_id),
  FOREIGN KEY (clover_order_id,business_id) REFERENCES core.orders(id,business_id),
  UNIQUE (id,business_id),
  UNIQUE (provider,environment,merchant_id,checkout_session_id),
  CHECK (status<>'verified' OR
    (clover_payment_id IS NOT NULL AND verified_cents=expected_cents AND verified_at IS NOT NULL))
);
CREATE UNIQUE INDEX site_order_payment_id_unique ON core.site_order_payments
  (provider,environment,merchant_id,clover_payment_id) WHERE clover_payment_id IS NOT NULL;
CREATE UNIQUE INDEX site_order_one_active_payment ON core.site_order_payments
  (business_id,site_order_id) WHERE status IN ('pending','verified');

CREATE TABLE core.site_order_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid NOT NULL,
  site_order_id uuid NOT NULL,
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 8 AND 160),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z_]{3,50}$'),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (site_order_id,business_id) REFERENCES core.site_orders(id,business_id),
  UNIQUE (business_id,event_key)
);

CREATE TABLE core.site_order_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  site_order_id uuid NOT NULL,
  department text NOT NULL CHECK (department IN ('restaurant','bakery','catering')),
  status text NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN
    ('awaiting_payment','new','needs_reschedule','accepted','preparing','ready','completed','cancelled')),
  requested_at timestamptz NOT NULL,
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines)='array' AND jsonb_array_length(lines)>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (site_order_id,business_id) REFERENCES core.site_orders(id,business_id),
  UNIQUE (business_id,site_order_id,department)
);
CREATE INDEX site_order_tickets_open ON core.site_order_tickets
  (business_id,status,requested_at) WHERE status IN
  ('new','needs_reschedule','accepted','preparing','ready');

-- A kitchen ticket cannot become actionable from a draft or an unverified session.
CREATE FUNCTION core.site_ticket_paid_guard_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF NEW.status IN ('new','accepted','preparing','ready','completed')
    AND NOT EXISTS (
      SELECT 1 FROM core.site_order_payments p
      WHERE p.business_id=NEW.business_id AND p.site_order_id=NEW.site_order_id
        AND p.status='verified' AND p.verified_cents=p.expected_cents
    ) THEN
    RAISE EXCEPTION 'Verified payment required' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

-- The K7 record may arrive after checkout. Link it without creating a second
-- site order or treating Clover order total as payment proof.
CREATE FUNCTION public.site_order_clover_link_v1(
  p_business_id uuid,p_session_id text,p_clover_order_record_id uuid,
  p_clover_payment_record_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_payment core.site_order_payments%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_payment FROM core.site_order_payments
    WHERE business_id=p_business_id AND checkout_session_id=p_session_id FOR UPDATE;
  IF NOT FOUND OR v_payment.status<>'verified' OR
    NOT EXISTS(SELECT 1 FROM core.orders o
      WHERE o.id=p_clover_order_record_id AND o.business_id=p_business_id
        AND o.clover_merchant_id=v_payment.merchant_id) OR
    NOT EXISTS(SELECT 1 FROM core.payments p
      WHERE p.id=p_clover_payment_record_id AND p.business_id=p_business_id
        AND p.order_id=p_clover_order_record_id
        AND p.clover_payment_id=v_payment.clover_payment_id) THEN
    RAISE EXCEPTION 'Clover ledger mismatch' USING ERRCODE='22023';
  END IF;
  IF v_payment.clover_order_id IS NOT NULL AND
    (v_payment.clover_order_id<>p_clover_order_record_id OR
     v_payment.clover_payment_record_id<>p_clover_payment_record_id) THEN
    RAISE EXCEPTION 'Clover link conflict' USING ERRCODE='23505';
  END IF;
  UPDATE core.site_order_payments SET clover_order_id=p_clover_order_record_id,
    clover_payment_record_id=p_clover_payment_record_id WHERE id=v_payment.id;
  RETURN true;
END $$;
CREATE TRIGGER site_ticket_paid_guard
  BEFORE INSERT OR UPDATE OF status ON core.site_order_tickets
  FOR EACH ROW EXECUTE FUNCTION core.site_ticket_paid_guard_v1();

-- Server-only order creation. The caller prices the cart; this function enforces
-- consistency and idempotency, and creates a non-actionable kitchen ticket.
CREATE FUNCTION public.site_order_create_v1(
  p_business_id uuid,p_request_id uuid,p_request_hash text,p_kind text,
  p_fulfillment text,p_customer_name text,p_customer_email text,p_customer_phone text,
  p_requested_at timestamptz,p_lines jsonb,p_note text,
  p_subtotal_cents bigint,p_tax_cents bigint,p_department text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid; v_hash text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF p_business_id IS NULL OR p_request_id IS NULL OR p_request_hash !~ '^[0-9a-f]{64}$'
    OR p_kind NOT IN ('menu','catering') OR p_fulfillment NOT IN ('pickup','delivery')
    OR p_department NOT IN ('restaurant','bakery','catering')
    OR p_requested_at IS NULL OR p_subtotal_cents<=0 OR p_tax_cents<0
    OR pg_catalog.jsonb_typeof(p_lines)<>'array' OR pg_catalog.jsonb_array_length(p_lines)=0 THEN
    RAISE EXCEPTION 'Invalid site order' USING ERRCODE='22023';
  END IF;
  INSERT INTO core.site_orders(business_id,request_id,request_hash,kind,fulfillment_method,
    customer_name,customer_email,customer_phone,requested_at,lines,preparation_note,
    subtotal_cents,tax_cents)
  VALUES(p_business_id,p_request_id,p_request_hash,p_kind,p_fulfillment,
    p_customer_name,p_customer_email,p_customer_phone,p_requested_at,p_lines,
    coalesce(p_note,''),p_subtotal_cents,p_tax_cents)
  ON CONFLICT(business_id,request_id) DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id,request_hash INTO v_id,v_hash FROM core.site_orders
      WHERE business_id=p_business_id AND request_id=p_request_id;
    IF v_hash IS DISTINCT FROM p_request_hash THEN
      RAISE EXCEPTION 'Request ID conflict' USING ERRCODE='23505';
    END IF;
    RETURN v_id;
  END IF;
  INSERT INTO core.site_order_tickets(business_id,site_order_id,department,requested_at,lines)
  VALUES(p_business_id,v_id,p_department,p_requested_at,p_lines);
  INSERT INTO core.site_order_events(business_id,site_order_id,event_key,event_type)
  VALUES(p_business_id,v_id,'order:'||v_id::text,'order_created');
  RETURN v_id;
END $$;

CREATE FUNCTION public.site_order_session_set_v1(
  p_business_id uuid,p_site_order_id uuid,p_environment text,p_merchant_id text,
  p_session_id text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_order core.site_orders%ROWTYPE; v_existing text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_order FROM core.site_orders
    WHERE id=p_site_order_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND OR v_order.status NOT IN ('draft','pending_payment') THEN
    RAISE EXCEPTION 'Order not available' USING ERRCODE='22023';
  END IF;
  SELECT checkout_session_id INTO v_existing FROM core.site_order_payments
    WHERE business_id=p_business_id AND site_order_id=p_site_order_id
      AND status IN ('pending','verified');
  IF v_existing IS NOT NULL THEN
    IF v_existing=p_session_id THEN RETURN true; END IF;
    RAISE EXCEPTION 'Payment session already exists' USING ERRCODE='23505';
  END IF;
  INSERT INTO core.site_order_payments(business_id,site_order_id,provider,environment,
    merchant_id,checkout_session_id,expected_cents)
  VALUES(p_business_id,p_site_order_id,'clover',p_environment,p_merchant_id,p_session_id,
    v_order.total_cents);
  UPDATE core.site_orders SET status='pending_payment',updated_at=clock_timestamp()
    WHERE id=v_order.id;
  RETURN true;
END $$;

-- PR 2 will call this only after independent Clover Payments Read verification.
-- Database amount, session and tenant checks make webhook retries idempotent.
CREATE FUNCTION public.site_order_payment_confirm_v1(
  p_business_id uuid,p_session_id text,p_merchant_id text,p_payment_id text,
  p_amount_cents bigint,p_paid_at timestamptz,p_raw_response jsonb
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_payment core.site_order_payments%ROWTYPE; v_order core.site_orders%ROWTYPE;
  v_status text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_payment FROM core.site_order_payments
    WHERE business_id=p_business_id AND checkout_session_id=p_session_id
      AND merchant_id=p_merchant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown session' USING ERRCODE='22023'; END IF;
  IF v_payment.status='verified' AND v_payment.clover_payment_id=p_payment_id
    AND v_payment.verified_cents=p_amount_cents THEN RETURN 'already_verified'; END IF;
  IF v_payment.status<>'pending' OR p_paid_at IS NULL
    OR p_payment_id !~ '^[A-Za-z0-9]{8,32}$'
    OR p_amount_cents IS DISTINCT FROM v_payment.expected_cents
    OR pg_catalog.jsonb_typeof(p_raw_response)<>'object' THEN
    RAISE EXCEPTION 'Payment mismatch' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_order FROM core.site_orders
    WHERE id=v_payment.site_order_id AND business_id=p_business_id FOR UPDATE;
  IF v_order.status<>'pending_payment' THEN
    RAISE EXCEPTION 'Order state mismatch' USING ERRCODE='22023';
  END IF;
  v_status:=CASE WHEN v_order.kind='catering' AND
    v_order.requested_at<p_paid_at+interval '72 hours' THEN 'needs_reschedule' ELSE 'paid' END;
  UPDATE core.site_order_payments SET status='verified',clover_payment_id=p_payment_id,
    verified_cents=p_amount_cents,verified_at=p_paid_at,raw_response=p_raw_response
    WHERE id=v_payment.id;
  UPDATE core.site_orders SET status=v_status,updated_at=clock_timestamp()
    WHERE id=v_order.id;
  UPDATE core.site_order_tickets SET status=CASE WHEN v_status='paid' THEN 'new'
    ELSE 'needs_reschedule' END,updated_at=clock_timestamp()
    WHERE business_id=p_business_id AND site_order_id=v_order.id AND status='awaiting_payment';
  INSERT INTO core.site_order_events(business_id,site_order_id,event_key,event_type)
  VALUES(p_business_id,v_order.id,'payment:'||p_payment_id,'payment_verified')
    ON CONFLICT(business_id,event_key) DO NOTHING;
  RETURN v_status;
END $$;

ALTER TABLE core.site_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site_order_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.site_order_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.site_orders,core.site_order_payments,core.site_order_events,core.site_order_tickets
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE core.site_order_events_id_seq FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION core.site_ticket_paid_guard_v1() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.site_order_create_v1(uuid,uuid,text,text,text,text,text,text,timestamptz,jsonb,text,bigint,bigint,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.site_order_session_set_v1(uuid,uuid,text,text,text)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.site_order_payment_confirm_v1(uuid,text,text,text,bigint,timestamptz,jsonb)
  FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.site_order_clover_link_v1(uuid,text,uuid,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.site_order_create_v1(uuid,uuid,text,text,text,text,text,text,timestamptz,jsonb,text,bigint,bigint,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.site_order_session_set_v1(uuid,uuid,text,text,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.site_order_payment_confirm_v1(uuid,text,text,text,bigint,timestamptz,jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.site_order_clover_link_v1(uuid,text,uuid,uuid)
  TO service_role;

COMMIT;
