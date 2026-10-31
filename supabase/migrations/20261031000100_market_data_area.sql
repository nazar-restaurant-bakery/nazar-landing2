-- G8 (Faz 2 Gorev 8): kisiye ait olmayan pazar verisi icin ayri alan (market semasi).
-- Places, Google Ads, Business Profile (sonra Apify ve Meta) buraya yazar; bu migration
-- yalniz alani kurar. Veri yazan baglantilar Gorev 12 ve 13'te gelir.
-- Duzen core ile ayni: anon, authenticated ve service_role'e USAGE ve tablo izni yok,
-- butun tablolarda RLS acik. Okuma/yazma ileride SECURITY DEFINER, search_path=''
-- ve yalniz service_role'un cagirabildigi fonksiyonlarla olur.
-- Kisiye ait veri (musteri, e-posta, telefon, kisi adi, yorumcu adi) bu semaya girmez.
-- core semasinda hicbir tablo ya da fonksiyon degismez.
-- Geri alma: supabase/rollbacks/20261031000100_market_data_area_down.sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('market_data_area_v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('core.businesses') IS NULL
    OR pg_catalog.to_regclass('core.b2b_leads') IS NULL THEN
    RAISE EXCEPTION 'G8_CORE_REQUIRED';
  END IF;
  IF pg_catalog.to_regnamespace('market') IS NOT NULL THEN
    RAISE EXCEPTION 'G8_ALREADY_APPLIED';
  END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE') THEN
    RAISE EXCEPTION 'G8_PRIVATE_CORE_REQUIRED';
  END IF;
END $preflight$;

CREATE SCHEMA market;
REVOKE ALL ON SCHEMA market FROM PUBLIC, anon, authenticated, service_role;

-- Ortak alanlar: business_id, source, observed_at (gozlem zamani), import_id (uygunsa),
-- is_test, created_at. source: places_api, google_ads_api, business_profile_api, csv, apify ...

-- 1. Her ice aktarma / cekim calistirmasi. Ayni dosya ayni isletmeye iki kez yuklenemez.
CREATE TABLE market.imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{1,39}$'),
  kind text NOT NULL CHECK (kind IN ('competitors','competitor_menu_items','competitor_reviews',
    'competitor_ads','area_businesses','ad_reports','business_profile_reports')),
  file_name text CHECK (file_name IS NULL OR length(file_name) BETWEEN 1 AND 255),
  file_sha256 text CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
  period_start date,
  period_end date,
  row_count integer CHECK (row_count IS NULL OR row_count >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','partial','failed')),
  observed_at timestamptz NOT NULL,
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start),
  -- API cekimlerinde dosya yok (file_sha256 NULL); NULL degerler birbirine engel olmaz.
  CONSTRAINT imports_business_file_unique UNIQUE (business_id, file_sha256),
  CONSTRAINT imports_business_id_unique UNIQUE (business_id, id)
);

-- 2. Rakipler (isletme bilgisi; kisi verisi yok)
CREATE TABLE market.competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  place_id text NOT NULL CHECK (length(place_id) BETWEEN 1 AND 255),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  address text,
  types text[] NOT NULL DEFAULT '{}',
  rating numeric(2,1) CHECK (rating IS NULL OR rating BETWEEN 0 AND 5),
  review_count integer CHECK (review_count IS NULL OR review_count >= 0),
  latitude double precision CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  website text,
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{1,39}$'),
  observed_at timestamptz NOT NULL,
  import_id uuid,
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT competitors_business_place_unique UNIQUE (business_id, place_id),
  CONSTRAINT competitors_business_id_unique UNIQUE (business_id, id),
  FOREIGN KEY (business_id, import_id) REFERENCES market.imports(business_id, id) ON DELETE RESTRICT
);

-- 3. Rakip menu ve fiyatlari (ayni gozlemde ayni urun bir kez)
CREATE TABLE market.competitor_menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  competitor_id uuid NOT NULL,
  item_name text NOT NULL CHECK (length(item_name) BETWEEN 1 AND 300),
  category text NOT NULL DEFAULT '',
  price numeric(10,2) CHECK (price IS NULL OR price >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  source_url text,
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{1,39}$'),
  observed_at timestamptz NOT NULL,
  import_id uuid,
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT competitor_menu_items_observation_unique UNIQUE (business_id, competitor_id, item_name, category, observed_at),
  FOREIGN KEY (business_id, competitor_id) REFERENCES market.competitors(business_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, import_id) REFERENCES market.imports(business_id, id) ON DELETE RESTRICT
);

-- 4. Rakip yorumlari: yorumcunun adi ve kisisel bilgisi TUTULMAZ (bu tabloda kolonu yok).
CREATE TABLE market.competitor_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  competitor_id uuid NOT NULL,
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 255),
  rating smallint CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  review_text text,
  published_at timestamptz,
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{1,39}$'),
  observed_at timestamptz NOT NULL,
  import_id uuid,
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT competitor_reviews_external_unique UNIQUE (business_id, competitor_id, external_id),
  FOREIGN KEY (business_id, competitor_id) REFERENCES market.competitors(business_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, import_id) REFERENCES market.imports(business_id, id) ON DELETE RESTRICT
);

-- 5. Rakip reklamlari
CREATE TABLE market.competitor_ads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  competitor_id uuid NOT NULL,
  platform text NOT NULL CHECK (platform ~ '^[a-z][a-z0-9_]{1,31}$'),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 255),
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  ad_text text,
  landing_url text,
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{1,39}$'),
  observed_at timestamptz NOT NULL,
  import_id uuid,
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (first_seen_at IS NULL OR last_seen_at IS NULL OR last_seen_at >= first_seen_at),
  CONSTRAINT competitor_ads_external_unique UNIQUE (business_id, platform, external_id),
  FOREIGN KEY (business_id, competitor_id) REFERENCES market.competitors(business_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id, import_id) REFERENCES market.imports(business_id, id) ON DELETE RESTRICT
);

-- 6. Bolgedeki sirketler; eslesen GO adayi icin bos gecilebilir bag (ayni isletmenin adayi olmali)
CREATE TABLE market.area_businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  place_id text NOT NULL CHECK (length(place_id) BETWEEN 1 AND 255),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  address text,
  types text[] NOT NULL DEFAULT '{}',
  rating numeric(2,1) CHECK (rating IS NULL OR rating BETWEEN 0 AND 5),
  review_count integer CHECK (review_count IS NULL OR review_count >= 0),
  latitude double precision CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  b2b_lead_id uuid REFERENCES core.b2b_leads(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{1,39}$'),
  observed_at timestamptz NOT NULL,
  import_id uuid,
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT area_businesses_business_place_unique UNIQUE (business_id, place_id),
  FOREIGN KEY (business_id, import_id) REFERENCES market.imports(business_id, id) ON DELETE RESTRICT
);
CREATE INDEX area_businesses_lead ON market.area_businesses (b2b_lead_id) WHERE b2b_lead_id IS NOT NULL;
-- core.b2b_leads'e dokunmadan isletme siniri: bag yalniz ayni isletmenin adayina kurulur.
CREATE FUNCTION market.area_business_lead_scope_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF NEW.b2b_lead_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM core.b2b_leads l WHERE l.id = NEW.b2b_lead_id AND l.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'G8_LEAD_OTHER_BUSINESS' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER area_businesses_lead_scope BEFORE INSERT OR UPDATE OF business_id, b2b_lead_id ON market.area_businesses
FOR EACH ROW EXECUTE FUNCTION market.area_business_lead_scope_v1();

-- 7. Reklam raporu, gunluk satir. Ayni gun iki kez gelirse guncellenir (ON CONFLICT), kopya olmaz.
CREATE TABLE market.ad_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  platform text NOT NULL CHECK (platform IN ('google_ads','meta')),
  campaign_id text NOT NULL CHECK (length(campaign_id) BETWEEN 1 AND 100),
  campaign_name text,
  report_date date NOT NULL,
  impressions bigint NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks bigint NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  spend numeric(12,2) NOT NULL DEFAULT 0 CHECK (spend >= 0),
  conversions numeric(12,2) NOT NULL DEFAULT 0 CHECK (conversions >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{1,39}$'),
  observed_at timestamptz NOT NULL,
  import_id uuid,
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ad_reports_daily_unique UNIQUE (business_id, platform, campaign_id, report_date),
  FOREIGN KEY (business_id, import_id) REFERENCES market.imports(business_id, id) ON DELETE RESTRICT
);

-- 8. Business Profile gostergeleri (dimension: ornegin arama terimi; boyutsuz gosterge icin '')
CREATE TABLE market.business_profile_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  period_start date NOT NULL,
  period_end date NOT NULL,
  metric text NOT NULL CHECK (metric ~ '^[A-Za-z][A-Za-z0-9_]{1,79}$'),
  dimension text NOT NULL DEFAULT '' CHECK (length(dimension) <= 300),
  value numeric NOT NULL,
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_]{1,39}$'),
  observed_at timestamptz NOT NULL,
  import_id uuid,
  is_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CONSTRAINT business_profile_reports_unique UNIQUE (business_id, metric, dimension, period_start, period_end),
  FOREIGN KEY (business_id, import_id) REFERENCES market.imports(business_id, id) ON DELETE RESTRICT
);

-- 9. Erisim: RLS acik, dogrudan erisim kapali (core duzeni)
ALTER TABLE market.imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE market.competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE market.competitor_menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE market.competitor_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE market.competitor_ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE market.area_businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE market.ad_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE market.business_profile_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA market FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA market FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA market FROM PUBLIC, anon, authenticated, service_role;

-- 10. Son kontrol
DO $post$
DECLARE
  r record;
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_class c
      WHERE c.relnamespace='market'::regnamespace AND c.relkind='r') <> 8 THEN
    RAISE EXCEPTION 'G8_TABLE_COUNT';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.relnamespace='market'::regnamespace AND c.relkind='r' AND NOT c.relrowsecurity) THEN
    RAISE EXCEPTION 'G8_RLS_REQUIRED';
  END IF;
  FOR r IN SELECT unnest(ARRAY['anon','authenticated','service_role']) AS role LOOP
    IF pg_catalog.has_schema_privilege(r.role,'market','USAGE')
      OR pg_catalog.has_schema_privilege(r.role,'core','USAGE')
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.relnamespace='market'::regnamespace AND c.relkind='r'
          AND pg_catalog.has_table_privilege(r.role,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) THEN
      RAISE EXCEPTION 'G8_PRIVATE_MARKET_REQUIRED';
    END IF;
  END LOOP;
END $post$;
COMMIT;
