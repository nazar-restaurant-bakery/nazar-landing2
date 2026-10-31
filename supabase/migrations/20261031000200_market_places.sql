-- G12 (Faz 2 Gorev 12): Google Places -> market semasi.
-- Bolge reklam konusuna gore AYARDIR (market.area_settings):
--   catering   : ilce (county) listesi; bolgedeki sirketler -> market.area_businesses,
--                catering yapan rakipler -> market.competitors
--   restaurant : Nazar konumu merkezli yaricap (mil); restoran, firin, paket servis
--                rakipleri -> market.competitors
-- Cekim: market.places_run_v1 (yalniz postgres, SQL Editor) -> imzali pg_net POST ->
-- Edge market-places -> public.market_places_claim_v1 / finish_v1 (yalniz service_role).
-- Yeni gizli deger yok: vault'taki SCHEDULER_SIGNING_SECRET, imzaya 'market_places' amac
-- etiketi katilarak kullanilir; URL vault SCHEDULER_EDGE_URL'den kati kalipla turetilir.
-- market semasina dogrudan izin acilmaz; core yalniz okunur (Apollo eslestirmesi).
-- Geri alma: supabase/rollbacks/20261031000200_market_places_down.sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('market_places_v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('core.businesses') IS NULL
    OR pg_catalog.to_regclass('core.b2b_leads') IS NULL
    OR pg_catalog.to_regclass('market.imports') IS NULL
    OR pg_catalog.to_regclass('market.competitors') IS NULL
    OR pg_catalog.to_regclass('market.area_businesses') IS NULL THEN
    RAISE EXCEPTION 'G12_MARKET_AREA_REQUIRED';
  END IF;
  IF pg_catalog.to_regclass('market.area_settings') IS NOT NULL
    OR pg_catalog.to_regclass('market.places_runs') IS NOT NULL THEN
    RAISE EXCEPTION 'G12_ALREADY_APPLIED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='market.imports'::regclass
      AND conname='imports_kind_check'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%business_profile_reports%'
      AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%places_%') THEN
    RAISE EXCEPTION 'G12_UNEXPECTED_IMPORTS_KIND';
  END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
    OR pg_catalog.has_schema_privilege('anon','market','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','market','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','market','USAGE') THEN
    RAISE EXCEPTION 'G12_PRIVATE_SCHEMAS_REQUIRED';
  END IF;
END $preflight$;

-- 1. Bolge ayari: konu basina bir satir. catering = ilce listesi, restaurant = yaricap.
CREATE TABLE market.area_settings (
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  topic text NOT NULL CHECK (topic IN ('catering','restaurant')),
  mode text NOT NULL CHECK (mode IN ('county','radius')),
  state text NOT NULL DEFAULT 'CT' CHECK (state ~ '^[A-Z]{2}$'),
  counties text[] CHECK (counties IS NULL OR (cardinality(counties) BETWEEN 1 AND 20
    AND pg_catalog.array_to_string(counties, '|') ~ '^[A-Z][A-Za-z .''-]{1,60} County(\|[A-Z][A-Za-z .''-]{1,60} County)*$')),
  radius_miles numeric(5,2) CHECK (radius_miles IS NULL OR radius_miles > 0 AND radius_miles <= 25),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, topic),
  CHECK ((topic = 'catering' AND mode = 'county' AND counties IS NOT NULL AND radius_miles IS NULL)
      OR (topic = 'restaurant' AND mode = 'radius' AND radius_miles IS NOT NULL AND counties IS NULL))
);
-- Baslangic: yalniz Nazar (baska projede isletme yoksa satir olusmaz)
INSERT INTO market.area_settings(business_id, topic, mode, state, counties, radius_miles)
SELECT b.id, v.topic, v.mode, 'CT', v.counties, v.radius_miles
FROM core.businesses b
CROSS JOIN (VALUES ('catering','county',ARRAY['New Haven County']::text[],NULL::numeric),
                   ('restaurant','radius',NULL::text[],5::numeric)) AS v(topic, mode, counties, radius_miles)
WHERE b.id = 'a358eba4-b197-4309-805b-46f43a718454';

-- 2. Bir yer iki konuya girebilir; sehir ve ilce eslestirme ve ilce denetimi icindir.
ALTER TABLE market.competitors
  ADD COLUMN topics text[] NOT NULL DEFAULT '{}' CHECK (topics <@ ARRAY['catering','restaurant']::text[]),
  ADD COLUMN city text CHECK (city IS NULL OR length(city) <= 120),
  ADD COLUMN county text CHECK (county IS NULL OR length(county) <= 120);
ALTER TABLE market.area_businesses
  ADD COLUMN topics text[] NOT NULL DEFAULT '{}' CHECK (topics <@ ARRAY['catering','restaurant']::text[]),
  ADD COLUMN city text CHECK (city IS NULL OR length(city) <= 120),
  ADD COLUMN county text CHECK (county IS NULL OR length(county) <= 120);

-- 3. Places calistirmalarinin turleri
ALTER TABLE market.imports DROP CONSTRAINT imports_kind_check;
ALTER TABLE market.imports ADD CONSTRAINT imports_kind_check CHECK (kind IN ('competitors','competitor_menu_items',
  'competitor_reviews','competitor_ads','area_businesses','ad_reports','business_profile_reports',
  'places_catering','places_restaurant'));

-- 4. Calistirma kaydi: imzali istek tek kullanimlik (nonce + 15 dakika + claim_token)
CREATE TABLE market.places_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  topic text NOT NULL CHECK (topic IN ('catering','restaurant')),
  dry_run boolean NOT NULL,
  max_calls integer NOT NULL CHECK (max_calls BETWEEN 1 AND 500),
  nonce uuid NOT NULL DEFAULT gen_random_uuid(),
  claim_token uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','partial','failed')),
  safe_code text CHECK (safe_code IS NULL OR safe_code ~ '^[a-z0-9_]{1,64}$'),
  request_id bigint,
  import_id uuid,
  planned_calls integer CHECK (planned_calls IS NULL OR planned_calls >= 0),
  calls_used integer CHECK (calls_used IS NULL OR calls_used >= 0),
  competitors_written integer CHECK (competitors_written IS NULL OR competitors_written >= 0),
  area_businesses_written integer CHECK (area_businesses_written IS NULL OR area_businesses_written >= 0),
  leads_matched integer CHECK (leads_matched IS NULL OR leads_matched >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  FOREIGN KEY (business_id, import_id) REFERENCES market.imports(business_id, id) ON DELETE RESTRICT
);
CREATE INDEX places_runs_active ON market.places_runs (business_id, topic, created_at) WHERE status IN ('queued','running');

-- 5. Eslestirme anahtarlari (sirket adi + sehir; buyuk/kucuk harf, noktalama ve tuzel ekler yok sayilir)
CREATE FUNCTION market.company_key_v1(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
    pg_catalog.replace(pg_catalog.lower(coalesce(p_name,'')),'&',' and '),
    '[^a-z0-9]+',' ','g'),
    '\m(the|inc|incorporated|llc|llp|pllc|ltd|limited|corp|corporation|co|company|pc)\M','','g'),
    '\s+',' ','g'))
$$;
CREATE FUNCTION market.city_key_v1(p_city text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(coalesce(p_city,'')),'[^a-z0-9]+',' ','g'))
$$;

-- 6. Ayar degistirme: yalniz postgres (SQL Editor). Tek satir:
--    SELECT market.area_settings_set_v1('<business_id>','catering',ARRAY['New Haven County','Fairfield County'],NULL);
CREATE FUNCTION market.area_settings_set_v1(p_business_id uuid, p_topic text, p_counties text[],
  p_radius_miles numeric, p_enabled boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s market.area_settings;
BEGIN
  IF p_topic NOT IN ('catering','restaurant') THEN RAISE EXCEPTION 'MARKET_AREA_TOPIC_INVALID'; END IF;
  INSERT INTO market.area_settings(business_id, topic, mode, counties, radius_miles, enabled, updated_at)
  VALUES (p_business_id, p_topic, CASE p_topic WHEN 'catering' THEN 'county' ELSE 'radius' END,
    p_counties, p_radius_miles, coalesce(p_enabled, true), pg_catalog.clock_timestamp())
  ON CONFLICT (business_id, topic) DO UPDATE SET counties = EXCLUDED.counties, radius_miles = EXCLUDED.radius_miles,
    enabled = EXCLUDED.enabled, updated_at = EXCLUDED.updated_at
  RETURNING * INTO s;
  RETURN pg_catalog.jsonb_build_object('business_id', s.business_id, 'topic', s.topic, 'mode', s.mode, 'state', s.state,
    'counties', s.counties, 'radius_miles', s.radius_miles, 'enabled', s.enabled);
END $$;

-- 7. Cekimi baslatma: yalniz postgres (SQL Editor). core.daily_scheduler_run_today_v1 duzeni.
--    Geriye yalniz kimlik ve sayi doner; gizli deger donmez.
CREATE FUNCTION market.places_run_v1(p_business_id uuid, p_topic text, p_dry_run boolean DEFAULT true,
  p_max_calls integer DEFAULT 150)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r market.places_runs; v_secret text; v_endpoint text; v_issued bigint; v_signature text;
BEGIN
  IF p_dry_run IS NULL THEN RAISE EXCEPTION 'MARKET_PLACES_DRY_RUN_REQUIRED'; END IF;
  IF p_max_calls IS NULL OR p_max_calls NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'MARKET_PLACES_MAX_CALLS_INVALID'; END IF;
  PERFORM 1 FROM market.area_settings WHERE business_id = p_business_id AND topic = p_topic AND enabled FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MARKET_PLACES_SETTINGS_NOT_ENABLED'; END IF;
  IF EXISTS(SELECT 1 FROM market.places_runs WHERE business_id = p_business_id AND topic = p_topic
      AND status IN ('queued','running') AND created_at > pg_catalog.clock_timestamp() - interval '15 minutes') THEN
    RAISE EXCEPTION 'MARKET_PLACES_RUN_ACTIVE';
  END IF;
  SELECT decrypted_secret INTO STRICT v_secret FROM vault.decrypted_secrets WHERE name = 'SCHEDULER_SIGNING_SECRET';
  SELECT decrypted_secret INTO STRICT v_endpoint FROM vault.decrypted_secrets WHERE name = 'SCHEDULER_EDGE_URL';
  IF pg_catalog.length(v_secret) < 32 THEN RAISE EXCEPTION 'SCHEDULER_SECRET_TOO_SHORT'; END IF;
  IF v_endpoint !~ '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/daily-ops-run$' THEN
    RAISE EXCEPTION 'SCHEDULER_EDGE_URL_INVALID';
  END IF;
  v_endpoint := pg_catalog.regexp_replace(v_endpoint, '/daily-ops-run$', '/market-places');
  INSERT INTO market.places_runs(business_id, topic, dry_run, max_calls, created_at)
  VALUES (p_business_id, p_topic, p_dry_run, p_max_calls, pg_catalog.clock_timestamp()) RETURNING * INTO r;
  v_issued := pg_catalog.floor(EXTRACT(epoch FROM pg_catalog.clock_timestamp()));
  v_signature := pg_catalog.encode(extensions.hmac('market_places'||E'\n'||r.business_id||E'\n'||r.id||E'\n'||r.nonce||E'\n'||v_issued,
    v_secret, 'sha256'), 'hex');
  UPDATE market.places_runs SET request_id = net.http_post(url := v_endpoint,
    headers := pg_catalog.jsonb_build_object('Content-Type','application/json','X-Scheduler-Signature',v_signature),
    body := pg_catalog.jsonb_build_object('business_id',r.business_id,'run_id',r.id,'nonce',r.nonce,'issued_at',v_issued),
    timeout_milliseconds := 10000)
  WHERE id = r.id RETURNING * INTO r;
  RETURN pg_catalog.jsonb_build_object('run_id', r.id, 'topic', r.topic, 'dry_run', r.dry_run,
    'max_calls', r.max_calls, 'request_id', r.request_id);
END $$;

-- 8. Edge: calistirmayi bir kez sahiplen (yalniz service_role). Gercek ya da kuru, her
--    calistirma market.imports'a bir satir yazar.
CREATE FUNCTION public.market_places_claim_v1(p_business_id uuid, p_run_id uuid, p_nonce uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r market.places_runs; s market.area_settings; v_import uuid; v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  UPDATE market.places_runs SET status = 'running', claim_token = gen_random_uuid(), started_at = v_now
  WHERE business_id = p_business_id AND id = p_run_id AND nonce = p_nonce AND status = 'queued'
    AND created_at > v_now - interval '15 minutes'
  RETURNING * INTO r;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO s FROM market.area_settings WHERE business_id = p_business_id AND topic = r.topic AND enabled;
  IF NOT FOUND THEN
    UPDATE market.places_runs SET status = 'failed', safe_code = 'settings_disabled', finished_at = v_now WHERE id = r.id;
    RETURN NULL;
  END IF;
  INSERT INTO market.imports(business_id, source, kind, status, row_count, observed_at)
  VALUES (p_business_id, 'places_api', 'places_' || r.topic, 'running', 0, v_now) RETURNING id INTO v_import;
  UPDATE market.places_runs SET import_id = v_import WHERE id = r.id;
  RETURN pg_catalog.jsonb_build_object('claim_token', r.claim_token, 'topic', r.topic, 'mode', s.mode, 'state', s.state,
    'counties', s.counties, 'radius_miles', s.radius_miles, 'dry_run', r.dry_run, 'max_calls', r.max_calls);
END $$;

-- 9. Edge: sonucu yaz (yalniz service_role). Kayitlar place_id ile guncellenir (kopya yok).
--    Apollo baglantisi yalniz tek ve tam eslesmede (sirket adi + sehir); core.b2b_leads'e yazilmaz.
CREATE FUNCTION public.market_places_finish_v1(p_business_id uuid, p_run_id uuid, p_claim_token uuid,
  p_status text, p_safe_code text, p_planned_calls integer, p_calls_used integer,
  p_competitors jsonb, p_area_businesses jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r market.places_runs; s market.area_settings; v_now timestamptz := pg_catalog.clock_timestamp();
  v_competitors integer := 0; v_area integer := 0; v_matched integer := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM market.places_runs WHERE business_id = p_business_id AND id = p_run_id
    AND claim_token = p_claim_token AND status = 'running' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MARKET_PLACES_RUN_NOT_CLAIMED'; END IF;
  IF p_status NOT IN ('succeeded','partial','failed') OR p_safe_code !~ '^[a-z0-9_]{1,64}$'
    OR p_planned_calls IS NULL OR p_planned_calls < 0
    OR p_calls_used IS NULL OR p_calls_used < 0 OR p_calls_used > r.max_calls
    OR pg_catalog.jsonb_typeof(p_competitors) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(p_area_businesses) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(p_competitors) > 5000 OR pg_catalog.jsonb_array_length(p_area_businesses) > 5000 THEN
    RAISE EXCEPTION 'MARKET_PLACES_RESULT_INVALID';
  END IF;
  IF r.dry_run AND (p_calls_used <> 0 OR pg_catalog.jsonb_array_length(p_competitors) > 0
      OR pg_catalog.jsonb_array_length(p_area_businesses) > 0) THEN
    RAISE EXCEPTION 'MARKET_PLACES_DRY_RUN_WROTE';
  END IF;
  IF r.topic = 'restaurant' AND pg_catalog.jsonb_array_length(p_area_businesses) > 0 THEN
    RAISE EXCEPTION 'MARKET_PLACES_RESULT_INVALID';
  END IF;
  SELECT * INTO s FROM market.area_settings WHERE business_id = p_business_id AND topic = r.topic;

  DROP TABLE IF EXISTS pg_temp.market_places_rows;
  CREATE TEMP TABLE pg_temp.market_places_rows ON COMMIT DROP AS
  SELECT 'competitor'::text AS target, x.* FROM pg_catalog.jsonb_to_recordset(p_competitors) AS x(place_id text, name text,
    address text, types text[], rating numeric, review_count integer, latitude double precision, longitude double precision,
    website text, city text, county text)
  UNION ALL
  SELECT 'area'::text, x.* FROM pg_catalog.jsonb_to_recordset(p_area_businesses) AS x(place_id text, name text,
    address text, types text[], rating numeric, review_count integer, latitude double precision, longitude double precision,
    website text, city text, county text);
  IF EXISTS(SELECT 1 FROM pg_temp.market_places_rows WHERE place_id IS NULL OR place_id !~ '^[A-Za-z0-9_-]{10,255}$'
      OR name IS NULL OR pg_catalog.length(name) NOT BETWEEN 1 AND 300 OR pg_catalog.length(address) > 500
      OR pg_catalog.length(website) > 500 OR (website IS NOT NULL AND website !~ '^https?://')
      OR pg_catalog.cardinality(types) > 30) THEN
    RAISE EXCEPTION 'MARKET_PLACES_RESULT_INVALID';
  END IF;
  -- Ilce modunda ilce disi kayit yazilmaz
  IF s.mode = 'county' AND EXISTS(SELECT 1 FROM pg_temp.market_places_rows
      WHERE county IS NULL OR NOT (county = ANY (s.counties))) THEN
    RAISE EXCEPTION 'MARKET_PLACES_OUTSIDE_AREA';
  END IF;

  INSERT INTO market.competitors AS c(business_id, place_id, name, address, types, rating, review_count, latitude, longitude,
    website, city, county, topics, source, observed_at, import_id)
  SELECT DISTINCT ON (x.place_id) p_business_id, x.place_id, x.name, x.address, coalesce(x.types, '{}'), x.rating, x.review_count,
    x.latitude, x.longitude, x.website, x.city, x.county, ARRAY[r.topic], 'places_api', v_now, r.import_id
  FROM pg_temp.market_places_rows x WHERE x.target = 'competitor' ORDER BY x.place_id
  ON CONFLICT (business_id, place_id) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address, types = EXCLUDED.types,
    rating = EXCLUDED.rating, review_count = EXCLUDED.review_count, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
    website = EXCLUDED.website, city = EXCLUDED.city, county = EXCLUDED.county,
    topics = ARRAY(SELECT DISTINCT t FROM pg_catalog.unnest(c.topics || EXCLUDED.topics) t ORDER BY t),
    source = EXCLUDED.source, observed_at = EXCLUDED.observed_at, import_id = EXCLUDED.import_id;
  GET DIAGNOSTICS v_competitors = ROW_COUNT;

  INSERT INTO market.area_businesses AS a(business_id, place_id, name, address, types, rating, review_count, latitude, longitude,
    b2b_lead_id, city, county, topics, source, observed_at, import_id)
  SELECT DISTINCT ON (x.place_id) p_business_id, x.place_id, x.name, x.address, coalesce(x.types, '{}'), x.rating, x.review_count,
    x.latitude, x.longitude,
    (SELECT CASE WHEN pg_catalog.count(*) = 1 THEN (pg_catalog.array_agg(l.id))[1] END FROM core.b2b_leads l
      WHERE l.business_id = p_business_id AND market.company_key_v1(x.name) <> ''
        AND market.company_key_v1(l.company_name) = market.company_key_v1(x.name)
        AND market.city_key_v1(x.city) <> '' AND market.city_key_v1(l.city) = market.city_key_v1(x.city)),
    x.city, x.county, ARRAY[r.topic], 'places_api', v_now, r.import_id
  FROM pg_temp.market_places_rows x WHERE x.target = 'area' ORDER BY x.place_id
  ON CONFLICT (business_id, place_id) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address, types = EXCLUDED.types,
    rating = EXCLUDED.rating, review_count = EXCLUDED.review_count, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
    b2b_lead_id = EXCLUDED.b2b_lead_id, city = EXCLUDED.city, county = EXCLUDED.county,
    topics = ARRAY(SELECT DISTINCT t FROM pg_catalog.unnest(a.topics || EXCLUDED.topics) t ORDER BY t),
    source = EXCLUDED.source, observed_at = EXCLUDED.observed_at, import_id = EXCLUDED.import_id;
  GET DIAGNOSTICS v_area = ROW_COUNT;
  SELECT pg_catalog.count(*) INTO v_matched FROM market.area_businesses
  WHERE business_id = p_business_id AND import_id = r.import_id AND b2b_lead_id IS NOT NULL;

  UPDATE market.imports SET status = p_status, row_count = v_competitors + v_area WHERE id = r.import_id;
  UPDATE market.places_runs SET status = p_status, safe_code = p_safe_code, planned_calls = p_planned_calls,
    calls_used = p_calls_used, competitors_written = v_competitors, area_businesses_written = v_area,
    leads_matched = v_matched, finished_at = v_now
  WHERE id = r.id;
  RETURN pg_catalog.jsonb_build_object('competitors', v_competitors, 'area_businesses', v_area, 'leads_matched', v_matched);
END $$;

-- 10. Erisim: market tablolari kapali; ayar ve baslatma yalniz postgres; Edge RPC'leri yalniz service_role
ALTER TABLE market.area_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE market.places_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA market FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA market FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA market FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.market_places_claim_v1(uuid,uuid,uuid),
  public.market_places_finish_v1(uuid,uuid,uuid,text,text,integer,integer,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_places_claim_v1(uuid,uuid,uuid),
  public.market_places_finish_v1(uuid,uuid,uuid,text,text,integer,integer,jsonb,jsonb) TO service_role;

-- 11. Son kontrol
DO $post$
DECLARE r record;
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.relnamespace='market'::regnamespace AND c.relkind='r' AND NOT c.relrowsecurity) THEN
    RAISE EXCEPTION 'G12_RLS_REQUIRED';
  END IF;
  FOR r IN SELECT unnest(ARRAY['anon','authenticated','service_role']) AS role LOOP
    IF pg_catalog.has_schema_privilege(r.role,'market','USAGE')
      OR pg_catalog.has_schema_privilege(r.role,'core','USAGE')
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.relnamespace='market'::regnamespace AND c.relkind='r'
          AND pg_catalog.has_table_privilege(r.role,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='market'::regnamespace
        AND pg_catalog.has_function_privilege(r.role,p.oid,'EXECUTE')) THEN
      RAISE EXCEPTION 'G12_PRIVATE_MARKET_REQUIRED';
    END IF;
  END LOOP;
  IF pg_catalog.has_function_privilege('anon','public.market_places_finish_v1(uuid,uuid,uuid,text,text,integer,integer,jsonb,jsonb)','EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated','public.market_places_claim_v1(uuid,uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'G12_RPC_EXPOSED';
  END IF;
END $post$;
COMMIT;
