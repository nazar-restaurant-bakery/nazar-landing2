-- G21 (Faz 2 Gorev 21): olcum katmani, catering siparisleriyle sinirli.
-- Kampanya kaynagi (UTM + gclid) -> catering siparisi -> Clover webhook ile dogrulanmis odeme
-- -> musteri tek gorunumde. Kaynagi bilinmeyen sonuc kampanya basarisi sayilmaz; test kayitlari
-- haric; tam iade ciroya girmez (ayri gosterilir), kismi iade dusulur.
--  * core.site_orders.utm + public.site_order_create_v1(..., p_utm DEFAULT NULL)
--  * core.measurement_catering_orders_v1 (siparis bazinda gorunum; disariya kapali)
--  * core.measurement_campaign_summary_v1 (kampanya ozeti; Google Ads harcamasi market.ad_reports'tan)
--  * core.customer_campaign_attribution (musterinin ilk/son atfedilen kampanyasi) + yenileme
--  * public.measurement_report_v1 (yalniz service_role; forvet okumasi, donem parametreli)
--  * public.crm_customer_attribution_v1 (yalniz yetkili personel, crm.read)
-- Odeme mantigi, tutar, Clover cagrilari ve webhook degismez.
-- Geri alma: supabase/rollbacks/20261101000100_measurement_layer_down.sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('measurement_layer_v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('core.customer_campaign_attribution') IS NOT NULL THEN RAISE EXCEPTION 'G21_ALREADY_APPLIED'; END IF;
  IF pg_catalog.to_regclass('core.site_orders') IS NULL
    OR pg_catalog.to_regclass('core.site_order_payments') IS NULL
    OR pg_catalog.to_regclass('core.site_order_clover_reversals') IS NULL
    OR pg_catalog.to_regclass('core.orders') IS NULL
    OR pg_catalog.to_regclass('core.customers') IS NULL
    OR pg_catalog.to_regclass('market.ad_reports') IS NULL
    OR pg_catalog.to_regprocedure('core.test_lead_reason_v1(text,text)') IS NULL
    OR pg_catalog.to_regprocedure('core.staff_authorized_v1(uuid,text)') IS NULL
    OR pg_catalog.to_regprocedure('public.site_order_create_v1(uuid,uuid,text,text,text,text,text,text,timestamptz,jsonb,text,bigint,bigint,text)') IS NULL THEN
    RAISE EXCEPTION 'G21_PREREQUISITES_REQUIRED';
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='core' AND table_name='site_orders' AND column_name='utm')
    OR pg_catalog.to_regclass('core.customer_campaign_attribution') IS NOT NULL THEN
    RAISE EXCEPTION 'G21_ALREADY_APPLIED';
  END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE') THEN
    RAISE EXCEPTION 'G21_PRIVATE_CORE_REQUIRED';
  END IF;
END $preflight$;

-- 1. Siparisin kampanya kaynagi. Yalniz bilinen anahtarlar, metin degerler, uzunluk siniri.
CREATE FUNCTION core.site_order_utm_valid_v1(p_utm jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT p_utm IS NULL OR (pg_catalog.jsonb_typeof(p_utm) = 'object'
    AND pg_catalog.octet_length(p_utm::text) <= 4096
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.jsonb_each(p_utm) e
      WHERE e.key NOT IN ('utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid','ttclid','landing_page')
        OR pg_catalog.jsonb_typeof(e.value) <> 'string'
        OR pg_catalog.length(e.value #>> '{}') NOT BETWEEN 1 AND 200
        OR (e.value #>> '{}') ~ '[[:cntrl:]]'
        OR (e.key = 'landing_page' AND (e.value #>> '{}') !~ '^/[A-Za-z0-9/_-]{0,100}$')))
$$;
ALTER TABLE core.site_orders ADD COLUMN utm jsonb CONSTRAINT site_orders_utm_valid CHECK (core.site_order_utm_valid_v1(utm));

-- 2. Siparis RPC'si: ayni govde, yalniz istege bagli p_utm eklendi (yeni sipariste yazilir).
DROP FUNCTION public.site_order_create_v1(uuid,uuid,text,text,text,text,text,text,timestamptz,jsonb,text,bigint,bigint,text);
CREATE FUNCTION public.site_order_create_v1(
  p_business_id uuid,p_request_id uuid,p_request_hash text,p_kind text,
  p_fulfillment text,p_customer_name text,p_customer_email text,p_customer_phone text,
  p_requested_at timestamptz,p_lines jsonb,p_note text,
  p_subtotal_cents bigint,p_tax_cents bigint,p_department text,p_utm jsonb DEFAULT NULL
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
    OR pg_catalog.jsonb_typeof(p_lines)<>'array' OR pg_catalog.jsonb_array_length(p_lines)=0
    OR NOT core.site_order_utm_valid_v1(p_utm) THEN
    RAISE EXCEPTION 'Invalid site order' USING ERRCODE='22023';
  END IF;
  INSERT INTO core.site_orders(business_id,request_id,request_hash,kind,fulfillment_method,
    customer_name,customer_email,customer_phone,requested_at,lines,preparation_note,
    subtotal_cents,tax_cents,utm)
  VALUES(p_business_id,p_request_id,p_request_hash,p_kind,p_fulfillment,
    p_customer_name,p_customer_email,p_customer_phone,p_requested_at,p_lines,
    coalesce(p_note,''),p_subtotal_cents,p_tax_cents,nullif(p_utm,'{}'::jsonb))
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
REVOKE ALL ON FUNCTION public.site_order_create_v1(uuid,uuid,text,text,text,text,text,text,timestamptz,jsonb,text,bigint,bigint,text,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.site_order_create_v1(uuid,uuid,text,text,text,text,text,text,timestamptz,jsonb,text,bigint,bigint,text,jsonb)
  TO service_role;

-- 3. Siparis bazinda olcum gorunumu (yalniz catering). Ciro yalniz Clover webhook ile dogrulanmis
--    odemeden gelir; tam iade 'refunded' (ciro 0), kismi iade dusulur. Musteri: Clover eslesmesi
--    (exact/staff_resolved) ya da e-posta kimligi; yoksa NULL (musteri uydurulmaz).
CREATE VIEW core.measurement_catering_orders_v1 AS
SELECT s.business_id, s.id AS site_order_id, s.created_at AS ordered_at, s.status AS order_status,
  coalesce(
    (SELECT o.customer_id FROM core.orders o WHERE o.id = p.clover_order_id AND o.business_id = s.business_id
       AND o.match_status IN ('exact','staff_resolved')),
    (SELECT c.id FROM core.customers c WHERE c.business_id = s.business_id
       AND c.identity_key = 'email:' || pg_catalog.lower(pg_catalog.btrim(s.customer_email)))) AS customer_id,
  (b.is_test OR core.test_lead_reason_v1(s.customer_name, s.customer_email) IS NOT NULL
    OR EXISTS(SELECT 1 FROM core.customers c WHERE c.business_id = s.business_id AND c.is_test
      AND (c.identity_key = 'email:' || pg_catalog.lower(pg_catalog.btrim(s.customer_email))
        OR c.id = (SELECT o.customer_id FROM core.orders o WHERE o.id = p.clover_order_id)))) AS is_test,
  CASE p.status WHEN 'verified' THEN 'verified' WHEN 'refunded' THEN 'refunded' ELSE 'unverified' END AS revenue_state,
  p.verified_at, p.verified_cents,
  CASE p.status WHEN 'refunded' THEN p.verified_cents WHEN 'verified' THEN coalesce(r.partial_cents, 0) ELSE 0 END AS refunded_cents,
  CASE p.status WHEN 'verified' THEN p.verified_cents - coalesce(r.partial_cents, 0) ELSE 0 END AS revenue_cents,
  s.utm ->> 'utm_source' AS utm_source, s.utm ->> 'utm_medium' AS utm_medium, s.utm ->> 'utm_campaign' AS utm_campaign,
  s.utm ->> 'utm_term' AS utm_term, s.utm ->> 'utm_content' AS utm_content,
  (s.utm ? 'gclid') AS has_gclid,
  CASE WHEN s.utm ? 'gclid' OR (pg_catalog.lower(s.utm ->> 'utm_source') = 'google' AND pg_catalog.lower(s.utm ->> 'utm_medium') = 'cpc')
         THEN 'google_ads'
       WHEN s.utm ? 'utm_source' THEN 'other_campaign'
       ELSE 'unknown' END AS source_class
FROM core.site_orders s
JOIN core.businesses b ON b.id = s.business_id
LEFT JOIN LATERAL (
  SELECT x.* FROM core.site_order_payments x
  WHERE x.business_id = s.business_id AND x.site_order_id = s.id AND x.status IN ('verified','refunded') AND x.verified_at IS NOT NULL
  ORDER BY (x.status = 'verified') DESC, x.verified_at DESC LIMIT 1) p ON true
LEFT JOIN LATERAL (
  SELECT pg_catalog.max(v.refunded_total_cents) AS partial_cents FROM core.site_order_clover_reversals v
  WHERE v.business_id = s.business_id AND v.site_order_id = s.id AND v.outcome = 'partial_refund') r ON true
WHERE s.kind = 'catering';

-- 4. Kampanya ozeti (donem: odeme dogrulama tarihi, New York). Kaynagi bilinmeyen siparis burada
--    yer almaz. Google Ads'te utm_campaign kampanya kimligiyse ayni donemin harcamasi
--    market.ad_reports'tan; eslesme yoksa harcama NULL (uydurulmaz).
CREATE FUNCTION core.measurement_campaign_summary_v1(p_business_id uuid, p_from date, p_to date)
RETURNS TABLE(source_class text, utm_source text, utm_medium text, utm_campaign text, orders bigint, customers bigint,
  revenue_cents bigint, refunded_orders bigint, refunded_cents bigint, ad_spend_usd numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  WITH o AS (
    SELECT m.* FROM core.measurement_catering_orders_v1 m
    WHERE m.business_id = p_business_id AND NOT m.is_test AND m.revenue_state IN ('verified','refunded')
      AND m.source_class <> 'unknown'
      AND (m.verified_at AT TIME ZONE 'America/New_York')::date BETWEEN p_from AND p_to),
  g AS (
    SELECT o.source_class, pg_catalog.lower(coalesce(o.utm_source, CASE WHEN o.has_gclid THEN 'google' END)) AS utm_source,
      pg_catalog.lower(o.utm_medium) AS utm_medium, o.utm_campaign,
      pg_catalog.count(*) FILTER (WHERE o.revenue_state = 'verified') AS orders,
      pg_catalog.count(DISTINCT o.customer_id) FILTER (WHERE o.revenue_state = 'verified') AS customers,
      coalesce(pg_catalog.sum(o.revenue_cents), 0)::bigint AS revenue_cents,
      pg_catalog.count(*) FILTER (WHERE o.revenue_state = 'refunded') AS refunded_orders,
      coalesce(pg_catalog.sum(o.refunded_cents), 0)::bigint AS refunded_cents
    FROM o GROUP BY 1, 2, 3, 4)
  SELECT g.source_class, g.utm_source, g.utm_medium, g.utm_campaign, g.orders, g.customers, g.revenue_cents,
    g.refunded_orders, g.refunded_cents,
    CASE WHEN g.source_class = 'google_ads' AND g.utm_campaign ~ '^[0-9]{1,20}$' THEN
      (SELECT pg_catalog.sum(a.spend) FROM market.ad_reports a WHERE a.business_id = p_business_id AND a.platform = 'google_ads'
         AND a.campaign_id = g.utm_campaign AND a.report_date BETWEEN p_from AND p_to AND NOT a.is_test) END
  FROM g ORDER BY g.revenue_cents DESC, g.source_class, g.utm_campaign NULLS LAST
$$;

-- 5. Musteri kaydina isleme: ilk ve son atfedilen kampanya. Yalniz dogrulanmis (iade edilmemis),
--    test olmayan ve kaynagi bilinen siparisler; kaynagi bilinmeyen siparis yazilmaz.
CREATE TABLE core.customer_campaign_attribution (
  customer_id uuid PRIMARY KEY REFERENCES core.customers(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  first_source_class text NOT NULL CHECK (first_source_class IN ('google_ads','other_campaign')),
  first_utm_source text, first_utm_campaign text,
  first_at timestamptz NOT NULL, first_site_order_id uuid NOT NULL,
  last_source_class text NOT NULL CHECK (last_source_class IN ('google_ads','other_campaign')),
  last_utm_source text, last_utm_campaign text,
  last_at timestamptz NOT NULL, last_site_order_id uuid NOT NULL,
  attributed_orders integer NOT NULL CHECK (attributed_orders >= 1),
  attributed_revenue_cents bigint NOT NULL CHECK (attributed_revenue_cents >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (first_site_order_id, business_id) REFERENCES core.site_orders(id, business_id),
  FOREIGN KEY (last_site_order_id, business_id) REFERENCES core.site_orders(id, business_id)
);
CREATE INDEX customer_campaign_attribution_business ON core.customer_campaign_attribution(business_id);

CREATE FUNCTION core.measurement_attribution_refresh_v1(p_business_id uuid, p_customer_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count integer;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS pg_temp.measurement_attribution_rows (customer_id uuid PRIMARY KEY) ON COMMIT DROP;
  TRUNCATE pg_temp.measurement_attribution_rows;
  WITH a AS (
    SELECT m.* FROM core.measurement_catering_orders_v1 m
    WHERE m.business_id = p_business_id AND (p_customer_id IS NULL OR m.customer_id = p_customer_id)
      AND m.customer_id IS NOT NULL AND NOT m.is_test AND m.revenue_state = 'verified' AND m.source_class <> 'unknown'),
  r AS (
    SELECT DISTINCT ON (a.customer_id) a.customer_id,
      pg_catalog.first_value(a.source_class) OVER w AS first_source_class,
      pg_catalog.first_value(coalesce(a.utm_source, CASE WHEN a.has_gclid THEN 'google' END)) OVER w AS first_utm_source,
      pg_catalog.first_value(a.utm_campaign) OVER w AS first_utm_campaign,
      pg_catalog.first_value(a.verified_at) OVER w AS first_at, pg_catalog.first_value(a.site_order_id) OVER w AS first_site_order_id,
      pg_catalog.last_value(a.source_class) OVER w AS last_source_class,
      pg_catalog.last_value(coalesce(a.utm_source, CASE WHEN a.has_gclid THEN 'google' END)) OVER w AS last_utm_source,
      pg_catalog.last_value(a.utm_campaign) OVER w AS last_utm_campaign,
      pg_catalog.last_value(a.verified_at) OVER w AS last_at, pg_catalog.last_value(a.site_order_id) OVER w AS last_site_order_id,
      pg_catalog.count(*) OVER w AS attributed_orders, pg_catalog.sum(a.revenue_cents) OVER w AS attributed_revenue_cents
    FROM a
    WINDOW w AS (PARTITION BY a.customer_id ORDER BY a.verified_at, a.site_order_id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)),
  up AS (
    INSERT INTO core.customer_campaign_attribution AS t(customer_id, business_id, first_source_class, first_utm_source,
      first_utm_campaign, first_at, first_site_order_id, last_source_class, last_utm_source, last_utm_campaign, last_at,
      last_site_order_id, attributed_orders, attributed_revenue_cents, updated_at)
    SELECT r.customer_id, p_business_id, r.first_source_class, r.first_utm_source, r.first_utm_campaign, r.first_at,
      r.first_site_order_id, r.last_source_class, r.last_utm_source, r.last_utm_campaign, r.last_at, r.last_site_order_id,
      r.attributed_orders, r.attributed_revenue_cents, pg_catalog.clock_timestamp()
    FROM r
    ON CONFLICT (customer_id) DO UPDATE SET first_source_class = EXCLUDED.first_source_class,
      first_utm_source = EXCLUDED.first_utm_source, first_utm_campaign = EXCLUDED.first_utm_campaign,
      first_at = EXCLUDED.first_at, first_site_order_id = EXCLUDED.first_site_order_id,
      last_source_class = EXCLUDED.last_source_class, last_utm_source = EXCLUDED.last_utm_source,
      last_utm_campaign = EXCLUDED.last_utm_campaign, last_at = EXCLUDED.last_at,
      last_site_order_id = EXCLUDED.last_site_order_id, attributed_orders = EXCLUDED.attributed_orders,
      attributed_revenue_cents = EXCLUDED.attributed_revenue_cents, updated_at = EXCLUDED.updated_at
    WHERE t.business_id = p_business_id
    RETURNING t.customer_id)
  INSERT INTO pg_temp.measurement_attribution_rows SELECT customer_id FROM up;
  -- Artik atfedilen siparisi kalmayan musteri (or. sonradan tam iade) kayittan cikar.
  DELETE FROM core.customer_campaign_attribution t
  WHERE t.business_id = p_business_id AND (p_customer_id IS NULL OR t.customer_id = p_customer_id)
    AND NOT EXISTS(SELECT 1 FROM pg_temp.measurement_attribution_rows x WHERE x.customer_id = t.customer_id);
  SELECT pg_catalog.count(*) INTO v_count FROM pg_temp.measurement_attribution_rows;
  RETURN v_count;
END $$;

-- 6. Forvet okumasi: tek fonksiyon, yalniz service_role, donem parametreli (en cok 366 gun).
CREATE FUNCTION public.measurement_report_v1(p_business_id uuid, p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_campaigns jsonb; v_unattributed jsonb; v_refunded jsonb; v_customers integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF p_business_id IS NULL OR p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'MEASUREMENT_PERIOD_INVALID' USING ERRCODE='22023';
  END IF;
  v_customers := core.measurement_attribution_refresh_v1(p_business_id);
  SELECT coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s)), '[]'::jsonb) INTO v_campaigns
  FROM core.measurement_campaign_summary_v1(p_business_id, p_from, p_to) s;
  SELECT pg_catalog.jsonb_build_object('orders', pg_catalog.count(*), 'revenue_cents', coalesce(pg_catalog.sum(m.revenue_cents), 0))
    INTO v_unattributed FROM core.measurement_catering_orders_v1 m
  WHERE m.business_id = p_business_id AND NOT m.is_test AND m.revenue_state = 'verified' AND m.source_class = 'unknown'
    AND (m.verified_at AT TIME ZONE 'America/New_York')::date BETWEEN p_from AND p_to;
  SELECT pg_catalog.jsonb_build_object('orders', pg_catalog.count(*) FILTER (WHERE m.revenue_state = 'refunded'),
      'refunded_cents', coalesce(pg_catalog.sum(m.refunded_cents), 0))
    INTO v_refunded FROM core.measurement_catering_orders_v1 m
  WHERE m.business_id = p_business_id AND NOT m.is_test AND m.revenue_state IN ('verified','refunded')
    AND (m.verified_at AT TIME ZONE 'America/New_York')::date BETWEEN p_from AND p_to;
  RETURN pg_catalog.jsonb_build_object('period_start', p_from, 'period_end', p_to, 'currency', 'USD',
    'scope', 'catering_site_orders', 'campaigns', v_campaigns,
    'unattributed', v_unattributed, 'refunds', v_refunded, 'attributed_customers', v_customers);
END $$;

-- 7. Personel CRM'i: musteri kartinda atfedilen kampanya (yalniz crm.read yetkili personel).
CREATE FUNCTION public.crm_customer_attribution_v1(p_customer_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_business uuid; v_row core.customer_campaign_attribution;
BEGIN
  SELECT c.business_id INTO v_business FROM core.customers c WHERE c.id = p_customer_id;
  IF v_business IS NULL OR NOT core.staff_authorized_v1(v_business, 'crm.read') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  PERFORM core.measurement_attribution_refresh_v1(v_business, p_customer_id);
  SELECT * INTO v_row FROM core.customer_campaign_attribution WHERE customer_id = p_customer_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN pg_catalog.jsonb_build_object(
    'first', pg_catalog.jsonb_build_object('source_class', v_row.first_source_class, 'utm_source', v_row.first_utm_source,
      'utm_campaign', v_row.first_utm_campaign, 'at', v_row.first_at, 'site_order_id', v_row.first_site_order_id),
    'last', pg_catalog.jsonb_build_object('source_class', v_row.last_source_class, 'utm_source', v_row.last_utm_source,
      'utm_campaign', v_row.last_utm_campaign, 'at', v_row.last_at, 'site_order_id', v_row.last_site_order_id),
    'attributed_orders', v_row.attributed_orders, 'attributed_revenue_cents', v_row.attributed_revenue_cents);
END $$;

-- 8. Erisim: core kapali; gorunum ve ic fonksiyonlar yalniz postgres.
ALTER TABLE core.customer_campaign_attribution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.customer_campaign_attribution, core.measurement_catering_orders_v1 FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION core.site_order_utm_valid_v1(jsonb), core.measurement_campaign_summary_v1(uuid,date,date),
  core.measurement_attribution_refresh_v1(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.measurement_report_v1(uuid,date,date), public.crm_customer_attribution_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.measurement_report_v1(uuid,date,date) TO service_role;
GRANT EXECUTE ON FUNCTION public.crm_customer_attribution_v1(uuid) TO authenticated;

DO $post$
BEGIN
  IF pg_catalog.has_schema_privilege('anon','core','USAGE') OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
    OR pg_catalog.has_function_privilege('anon','public.measurement_report_v1(uuid,date,date)','EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated','public.measurement_report_v1(uuid,date,date)','EXECUTE')
    OR pg_catalog.has_function_privilege('anon','public.crm_customer_attribution_v1(uuid)','EXECUTE')
    OR pg_catalog.has_function_privilege('anon','public.site_order_create_v1(uuid,uuid,text,text,text,text,text,text,timestamptz,jsonb,text,bigint,bigint,text,jsonb)','EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated','public.site_order_create_v1(uuid,uuid,text,text,text,text,text,text,timestamptz,jsonb,text,bigint,bigint,text,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'G21_ACCESS_CHECK_FAILED';
  END IF;
END $post$;
COMMIT;
