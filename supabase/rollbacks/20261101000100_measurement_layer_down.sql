-- G21 geri alma. Siparislere UTM yazilmissa durur (veri kaybi olmasin); yoksa olcum katmanini
-- kaldirir ve public.site_order_create_v1'i K16 temelindeki ozgun haline (p_utm yok) dondurur.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('measurement_layer_v1',0));
DO $guard$
BEGIN
  IF pg_catalog.to_regclass('core.customer_campaign_attribution') IS NULL THEN RAISE EXCEPTION 'G21_NOT_APPLIED'; END IF;
  IF EXISTS(SELECT 1 FROM core.site_orders WHERE utm IS NOT NULL) THEN RAISE EXCEPTION 'G21_ROLLBACK_DATA_PRESENT'; END IF;
END $guard$;
DROP FUNCTION public.crm_customer_attribution_v1(uuid);
DROP FUNCTION public.measurement_report_v1(uuid,date,date);
DROP FUNCTION core.measurement_attribution_refresh_v1(uuid,uuid);
DROP TABLE core.customer_campaign_attribution;
DROP FUNCTION core.measurement_campaign_summary_v1(uuid,date,date);
DROP VIEW core.measurement_catering_orders_v1;
DROP FUNCTION public.site_order_create_v1(uuid,uuid,text,text,text,text,text,text,timestamptz,jsonb,text,bigint,bigint,text,jsonb);
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
REVOKE ALL ON FUNCTION public.site_order_create_v1(uuid,uuid,text,text,text,text,text,text,timestamptz,jsonb,text,bigint,bigint,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.site_order_create_v1(uuid,uuid,text,text,text,text,text,text,timestamptz,jsonb,text,bigint,bigint,text)
  TO service_role;
ALTER TABLE core.site_orders DROP COLUMN utm;
DROP FUNCTION core.site_order_utm_valid_v1(jsonb);
COMMIT;
