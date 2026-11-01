-- G13 (Faz 2 Gorev 13): Business Profile "GMB insights Performance Report" CSV ->
-- market.business_profile_reports. Talip CSV icerigini SQL Editor'de tek bir cagriya yapistirir:
--   SELECT jsonb_pretty(market.business_profile_import_v1('<business_id>'::uuid, '<dosya adi>', $csv$<icerik>$csv$));
-- Donem dosyada yok, yalniz dosya adinda. Baslik satiri birebir dogrulanir; aciklama satiri
-- atlanir; tam bir veri satiri (tek isletme) beklenir. Store code ilk ice aktarmada isletmeye
-- baglanir. "***" ya da bos deger yazilmaz. Ayni dosya (sha256) ikinci kez yuklenemez.
-- Yalniz postgres cagirir; market semasina izin acilmaz; core yalniz okunur.
-- Geri alma: supabase/rollbacks/20261031000400_market_business_profile_import_down.sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('market_business_profile_import_v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('core.businesses') IS NULL
    OR pg_catalog.to_regclass('market.imports') IS NULL
    OR pg_catalog.to_regclass('market.business_profile_reports') IS NULL THEN
    RAISE EXCEPTION 'G13_BP_MARKET_AREA_REQUIRED';
  END IF;
  IF pg_catalog.to_regclass('market.business_profile_settings') IS NOT NULL
    OR pg_catalog.to_regprocedure('market.business_profile_import_v1(uuid,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'G13_BP_ALREADY_APPLIED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='market.imports'::regclass
      AND conname='imports_kind_check' AND pg_catalog.pg_get_constraintdef(oid) LIKE '%''business_profile_reports''%') THEN
    RAISE EXCEPTION 'G13_BP_UNEXPECTED_IMPORTS_KIND';
  END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
    OR pg_catalog.has_schema_privilege('anon','market','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','market','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','market','USAGE') THEN
    RAISE EXCEPTION 'G13_BP_PRIVATE_SCHEMAS_REQUIRED';
  END IF;
END $preflight$;

-- 1. Isletmenin Business Profile store code'u: ilk ice aktarmada baglanir, sonra degismez.
CREATE TABLE market.business_profile_settings (
  business_id uuid PRIMARY KEY REFERENCES core.businesses(id) ON DELETE RESTRICT,
  store_code text NOT NULL CHECK (store_code ~ '^[A-Za-z0-9_-]{1,64}$'),
  bound_at timestamptz NOT NULL DEFAULT now(),
  bound_import_id uuid NOT NULL,
  FOREIGN KEY (business_id, bound_import_id) REFERENCES market.imports(business_id, id) ON DELETE RESTRICT
);

-- 2. CSV ayristirici (RFC 4180: tirnakli alan, "" kacisi, tirnak icinde virgul/satir sonu; CRLF; BOM).
CREATE FUNCTION market.csv_rows_v1(p_csv text) RETURNS TABLE(line_no integer, fields text[])
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE chars text[]; n integer; i integer := 1; c text; field text := ''; cur text[] := '{}';
  quoted boolean := false; v_line integer := 0;
BEGIN
  chars := pg_catalog.regexp_split_to_array(coalesce(p_csv, ''), '');
  n := coalesce(pg_catalog.array_length(chars, 1), 0);
  IF n > 0 AND chars[1] = pg_catalog.chr(65279) THEN i := 2; END IF;
  WHILE i <= n LOOP
    c := chars[i];
    IF quoted THEN
      IF c = '"' THEN
        IF i < n AND chars[i + 1] = '"' THEN field := field || '"'; i := i + 1; ELSE quoted := false; END IF;
      ELSE field := field || c; END IF;
    ELSIF c = '"' AND field = '' THEN quoted := true;
    ELSIF c = ',' THEN cur := cur || field; field := '';
    ELSIF c = E'\r' THEN NULL;
    ELSIF c = E'\n' THEN
      v_line := v_line + 1; line_no := v_line; fields := cur || field; RETURN NEXT;
      cur := '{}'; field := '';
    ELSE field := field || c; END IF;
    i := i + 1;
  END LOOP;
  IF quoted THEN RAISE EXCEPTION 'BUSINESS_PROFILE_CSV_INVALID: kapanmayan tirnak'; END IF;
  IF field <> '' OR pg_catalog.cardinality(cur) > 0 THEN
    v_line := v_line + 1; line_no := v_line; fields := cur || field; RETURN NEXT;
  END IF;
END $$;

-- 3. Ice aktarma: yalniz postgres (SQL Editor).
CREATE FUNCTION market.business_profile_import_v1(p_business_id uuid, p_file_name text, p_csv text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  c_header constant text[] := ARRAY['Store code','Business name','Address','Labels','Google Search - Mobile',
    'Google Search - Desktop','Google Maps - Mobile','Google Maps - Desktop','Calls','Messages','Bookings','Directions',
    'Website clicks','Food orders','Food menu clicks','Hotel bookings'];
  c_metrics constant text[] := ARRAY['search_mobile_views','search_desktop_views','maps_mobile_views','maps_desktop_views',
    'calls','messages','bookings','directions','website_clicks','food_orders','food_menu_clicks','hotel_bookings'];
  m text[]; v_start date; v_end date; v_header text[]; v_data text[]; v_rows integer; v_store text; v_bound text;
  v_sha text; v_import uuid; v_now timestamptz := pg_catalog.clock_timestamp(); v_value text;
  v_written integer := 0; v_skipped text[] := '{}'; k integer;
BEGIN
  IF p_business_id IS NULL OR NOT EXISTS(SELECT 1 FROM core.businesses WHERE id = p_business_id) THEN
    RAISE EXCEPTION 'BUSINESS_PROFILE_BUSINESS_UNKNOWN: isletme bulunamadi';
  END IF;
  IF p_csv IS NULL OR pg_catalog.length(p_csv) = 0 OR pg_catalog.length(p_csv) > 100000 THEN
    RAISE EXCEPTION 'BUSINESS_PROFILE_CSV_INVALID: dosya icerigi bos ya da cok buyuk';
  END IF;

  -- Donem dosya adindan: GMB_insights_Performance_Report_-_2026-9-29_-_2026-10-28_-_<hash>.csv
  m := pg_catalog.regexp_match(coalesce(p_file_name, ''),
    '^GMB_insights_Performance_Report_-_([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})_-_([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})_-_[A-Za-z0-9_-]{1,100}( \([0-9]{1,3}\))?\.csv$');
  IF m IS NULL THEN
    RAISE EXCEPTION 'BUSINESS_PROFILE_FILE_NAME_INVALID: dosya adi GMB_insights_Performance_Report_-_YYYY-M-D_-_YYYY-M-D_-_<kod>.csv olmali';
  END IF;
  BEGIN
    v_start := pg_catalog.make_date(m[1]::integer, m[2]::integer, m[3]::integer);
    v_end := pg_catalog.make_date(m[4]::integer, m[5]::integer, m[6]::integer);
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format OR data_exception THEN
    RAISE EXCEPTION 'BUSINESS_PROFILE_FILE_NAME_INVALID: dosya adindaki tarih gecersiz';
  END;
  IF v_end < v_start THEN RAISE EXCEPTION 'BUSINESS_PROFILE_PERIOD_INVALID: bitis tarihi baslangictan once'; END IF;

  -- Baslik birebir; aciklama satiri (ilk dort hucre bos) ve bos satirlar atlanir; tam bir veri satiri.
  SELECT r.fields INTO v_header FROM market.csv_rows_v1(p_csv) r WHERE r.line_no = 1;
  IF v_header IS DISTINCT FROM c_header THEN
    RAISE EXCEPTION 'BUSINESS_PROFILE_HEADER_MISMATCH: baslik satiri beklenen Google bicimiyle ayni degil';
  END IF;
  DROP TABLE IF EXISTS pg_temp.business_profile_rows;
  CREATE TEMP TABLE pg_temp.business_profile_rows ON COMMIT DROP AS
  SELECT r.line_no, r.fields FROM market.csv_rows_v1(p_csv) r
  WHERE r.line_no > 1
    AND pg_catalog.array_to_string(r.fields, '') <> ''
    AND NOT (coalesce(r.fields[1], '') = '' AND coalesce(r.fields[2], '') = '' AND coalesce(r.fields[3], '') = ''
      AND coalesce(r.fields[4], '') = '');
  SELECT pg_catalog.count(*) INTO v_rows FROM pg_temp.business_profile_rows;
  SELECT x.fields INTO v_data FROM pg_temp.business_profile_rows x ORDER BY x.line_no LIMIT 1;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'BUSINESS_PROFILE_ROW_COUNT_INVALID: tam bir veri satiri (tek isletme) bekleniyor, % bulundu', v_rows;
  END IF;
  IF pg_catalog.cardinality(v_data) IS DISTINCT FROM 16 THEN
    RAISE EXCEPTION 'BUSINESS_PROFILE_CSV_INVALID: veri satirinda 16 sutun bekleniyor';
  END IF;
  v_store := pg_catalog.btrim(v_data[1]);
  IF v_store IS NULL OR v_store !~ '^[A-Za-z0-9_-]{1,64}$' THEN RAISE EXCEPTION 'BUSINESS_PROFILE_STORE_CODE_INVALID: store code gecersiz'; END IF;

  -- Store code baglantisi (kilitli okuma; eszamanli iki ilk ice aktarma farkli kod baglayamaz)
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('business_profile_import:' || p_business_id::text, 0));
  SELECT store_code INTO v_bound FROM market.business_profile_settings WHERE business_id = p_business_id;
  IF v_bound IS NOT NULL AND v_bound <> v_store THEN
    RAISE EXCEPTION 'BUSINESS_PROFILE_STORE_CODE_MISMATCH: dosyadaki store code bu isletmeye bagli olan kodla ayni degil';
  END IF;

  v_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_csv, 'UTF8')), 'hex');
  BEGIN
    INSERT INTO market.imports(business_id, source, kind, file_name, file_sha256, period_start, period_end, row_count,
      status, observed_at)
    VALUES (p_business_id, 'business_profile_csv', 'business_profile_reports', p_file_name, v_sha, v_start, v_end, 0,
      'running', v_now)
    RETURNING id INTO v_import;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'BUSINESS_PROFILE_FILE_ALREADY_IMPORTED: bu dosya zaten yuklenmis (ayni icerik, sha256 %)', pg_catalog.left(v_sha, 12);
  END;
  IF v_bound IS NULL THEN
    INSERT INTO market.business_profile_settings(business_id, store_code, bound_at, bound_import_id)
    VALUES (p_business_id, v_store, v_now, v_import);
  END IF;

  -- Sutun 5..16 -> 12 gosterge. "***" ya da bos deger yazilmaz.
  FOR k IN 1..12 LOOP
    v_value := pg_catalog.btrim(v_data[k + 4]);
    IF v_value = '' OR v_value = '***' THEN v_skipped := v_skipped || c_metrics[k]; CONTINUE; END IF;
    IF v_value ~ '^[0-9]{1,3}(,[0-9]{3})+$' THEN v_value := pg_catalog.replace(v_value, ',', ''); END IF;
    IF v_value !~ '^[0-9]{1,15}$' THEN
      RAISE EXCEPTION 'BUSINESS_PROFILE_VALUE_INVALID: "%" sutununda sayi bekleniyor', c_header[k + 4];
    END IF;
    INSERT INTO market.business_profile_reports AS b(business_id, period_start, period_end, metric, dimension, value,
      source, observed_at, import_id, updated_at)
    VALUES (p_business_id, v_start, v_end, c_metrics[k], '', v_value::numeric, 'business_profile_csv', v_now, v_import, v_now)
    ON CONFLICT (business_id, metric, dimension, period_start, period_end) DO UPDATE SET value = EXCLUDED.value,
      source = EXCLUDED.source, observed_at = EXCLUDED.observed_at, import_id = EXCLUDED.import_id, updated_at = EXCLUDED.updated_at;
    v_written := v_written + 1;
  END LOOP;

  UPDATE market.imports SET row_count = v_written,
    status = CASE WHEN pg_catalog.cardinality(v_skipped) = 0 THEN 'succeeded' WHEN v_written = 0 THEN 'failed' ELSE 'partial' END
  WHERE id = v_import;
  RETURN pg_catalog.jsonb_build_object('import_id', v_import, 'period_start', v_start, 'period_end', v_end,
    'store_code', v_store, 'metrics_written', v_written, 'skipped', pg_catalog.to_jsonb(v_skipped),
    'file_sha256', v_sha);
END $$;

-- 4. Erisim: market tablolari kapali; ice aktarma yalniz postgres
ALTER TABLE market.business_profile_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA market FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA market FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA market FROM PUBLIC, anon, authenticated, service_role;

-- 5. Son kontrol
DO $post$
DECLARE r record;
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.relnamespace='market'::regnamespace AND c.relkind='r' AND NOT c.relrowsecurity) THEN
    RAISE EXCEPTION 'G13_BP_RLS_REQUIRED';
  END IF;
  FOR r IN SELECT unnest(ARRAY['anon','authenticated','service_role']) AS role LOOP
    IF pg_catalog.has_schema_privilege(r.role,'market','USAGE')
      OR pg_catalog.has_schema_privilege(r.role,'core','USAGE')
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.relnamespace='market'::regnamespace AND c.relkind='r'
          AND pg_catalog.has_table_privilege(r.role,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='market'::regnamespace
        AND pg_catalog.has_function_privilege(r.role,p.oid,'EXECUTE')) THEN
      RAISE EXCEPTION 'G13_BP_PRIVATE_MARKET_REQUIRED';
    END IF;
  END LOOP;
END $post$;
COMMIT;
