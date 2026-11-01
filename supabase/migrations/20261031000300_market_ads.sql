-- G13 (Faz 2 Gorev 13): Google Ads -> market.ad_reports (kampanya x gun).
-- Cekim: market.ads_run_v1 (elle, yalniz postgres) ya da market.ads_cron_tick_v1 (pg_cron,
-- her gun 08:30 New York) -> imzali pg_net POST -> Edge market-ads ->
-- public.market_ads_claim_v1 / finish_v1 / alert_v1 (yalniz service_role).
-- Her calistirma son p_days gunu (dun dahil, bugun haric; New York tarihi) yeniden yazar:
-- baglanti birkac gun duserse aradaki gunler bir sonraki calistirmada kendiliginden dolar.
-- Yeni gizli deger yok: vault'taki SCHEDULER_SIGNING_SECRET, imzaya 'market_ads' amac
-- etiketi katilarak kullanilir; URL vault SCHEDULER_EDGE_URL'den kati kalipla turetilir.
-- Mevcut cron islerine ve daily_scheduler'a dokunulmaz; ayri bir cron isi kurulur.
-- market semasina dogrudan izin acilmaz; core yalniz okunur.
-- Geri alma: supabase/rollbacks/20261031000300_market_ads_down.sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('market_ads_v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('core.businesses') IS NULL
    OR pg_catalog.to_regclass('market.imports') IS NULL
    OR pg_catalog.to_regclass('market.ad_reports') IS NULL
    OR pg_catalog.to_regclass('market.places_runs') IS NULL THEN
    RAISE EXCEPTION 'G13_MARKET_PLACES_REQUIRED';
  END IF;
  IF pg_catalog.to_regclass('market.ads_runs') IS NOT NULL
    OR pg_catalog.to_regclass('market.ads_settings') IS NOT NULL
    OR pg_catalog.to_regclass('market.ads_alerts') IS NOT NULL THEN
    RAISE EXCEPTION 'G13_ALREADY_APPLIED';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid='market.imports'::regclass
      AND conname='imports_kind_check'
      AND pg_catalog.pg_get_constraintdef(oid) LIKE '%places_restaurant%'
      AND pg_catalog.pg_get_constraintdef(oid) NOT LIKE '%ads_google%') THEN
    RAISE EXCEPTION 'G13_UNEXPECTED_IMPORTS_KIND';
  END IF;
  IF pg_catalog.to_regclass('cron.job') IS NULL OR pg_catalog.to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'G13_PG_CRON_REQUIRED';
  END IF;
  IF EXISTS(SELECT 1 FROM cron.job WHERE jobname = 'market-ads-daily') THEN
    RAISE EXCEPTION 'G13_CRON_JOB_EXISTS';
  END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
    OR pg_catalog.has_schema_privilege('anon','market','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','market','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','market','USAGE') THEN
    RAISE EXCEPTION 'G13_PRIVATE_SCHEMAS_REQUIRED';
  END IF;
END $preflight$;

-- 1. Gunluk otomatik calistirmanin acik/kapali ayari (elle calistirma bundan bagimsizdir)
CREATE TABLE market.ads_settings (
  business_id uuid PRIMARY KEY REFERENCES core.businesses(id) ON DELETE RESTRICT,
  daily_enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO market.ads_settings(business_id)
SELECT b.id FROM core.businesses b WHERE b.id = 'a358eba4-b197-4309-805b-46f43a718454';

-- 2. Ads iceri aktarmalarinin turu
ALTER TABLE market.imports DROP CONSTRAINT imports_kind_check;
ALTER TABLE market.imports ADD CONSTRAINT imports_kind_check CHECK (kind IN ('competitors','competitor_menu_items',
  'competitor_reviews','competitor_ads','area_businesses','ad_reports','business_profile_reports',
  'places_catering','places_restaurant','ads_google'));

-- 3. Calistirma kaydi: imzali istek tek kullanimlik (nonce + 15 dakika + claim_token)
CREATE TABLE market.ads_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  trigger text NOT NULL CHECK (trigger IN ('manual','cron')),
  days integer NOT NULL CHECK (days BETWEEN 1 AND 90),
  dry_run boolean NOT NULL,
  max_calls integer NOT NULL CHECK (max_calls BETWEEN 1 AND 50),
  nonce uuid NOT NULL DEFAULT gen_random_uuid(),
  claim_token uuid,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  safe_code text CHECK (safe_code IS NULL OR safe_code ~ '^[a-z0-9_]{1,64}$'),
  request_id bigint,
  import_id uuid,
  period_start date,
  period_end date,
  calls_used integer CHECK (calls_used IS NULL OR calls_used >= 0),
  rows_written integer CHECK (rows_written IS NULL OR rows_written >= 0),
  alert_status text CHECK (alert_status IS NULL OR alert_status IN ('pending','sent','not_accepted','provider_error',
    'alert_not_configured','already_sent_today')),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start),
  FOREIGN KEY (business_id, import_id) REFERENCES market.imports(business_id, id) ON DELETE RESTRICT
);
CREATE INDEX ads_runs_active ON market.ads_runs (business_id, created_at) WHERE status IN ('queued','running');

-- 4. Uyari tekilligi: ayni hata kodu icin New York gunu basina en cok bir e-posta
CREATE TABLE market.ads_alerts (
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  alert_date date NOT NULL,
  safe_code text NOT NULL CHECK (safe_code ~ '^[a-z0-9_]{1,64}$'),
  run_id uuid NOT NULL REFERENCES market.ads_runs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, alert_date, safe_code)
);

-- 5. Takili kalan calistirmalari kapat: 15 dakikayi gecen 'queued'/'running' -> 'failed' / 'expired'.
--    Her yeni calistirmadan once uygulanir.
CREATE FUNCTION market.ads_expire_v1(p_business_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now timestamptz := pg_catalog.clock_timestamp(); v_count integer;
BEGIN
  WITH expired AS (
    UPDATE market.ads_runs SET status = 'failed', safe_code = 'expired', finished_at = v_now
    WHERE business_id = p_business_id AND status IN ('queued','running') AND created_at <= v_now - interval '15 minutes'
    RETURNING import_id),
  imports AS (
    UPDATE market.imports i SET status = 'failed' FROM expired e WHERE i.id = e.import_id AND i.status = 'running' RETURNING 1)
  SELECT pg_catalog.count(*) INTO v_count FROM expired;
  RETURN v_count;
END $$;

-- 6. Imzali istegi gonder (ic yardimci; elle ve cron calistirmasi ortak)
CREATE FUNCTION market.ads_dispatch_v1(p_business_id uuid, p_trigger text, p_days integer, p_dry_run boolean,
  p_max_calls integer)
RETURNS market.ads_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r market.ads_runs; v_secret text; v_endpoint text; v_issued bigint; v_signature text;
BEGIN
  IF p_days IS NULL OR p_days NOT BETWEEN 1 AND 90 THEN RAISE EXCEPTION 'MARKET_ADS_DAYS_INVALID'; END IF;
  IF p_dry_run IS NULL THEN RAISE EXCEPTION 'MARKET_ADS_DRY_RUN_REQUIRED'; END IF;
  IF p_max_calls IS NULL OR p_max_calls NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'MARKET_ADS_MAX_CALLS_INVALID'; END IF;
  PERFORM 1 FROM core.businesses WHERE id = p_business_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MARKET_ADS_BUSINESS_UNKNOWN'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('market_ads_run:' || p_business_id::text, 0));
  PERFORM market.ads_expire_v1(p_business_id);
  IF EXISTS(SELECT 1 FROM market.ads_runs WHERE business_id = p_business_id AND status IN ('queued','running')) THEN
    RAISE EXCEPTION 'MARKET_ADS_RUN_ACTIVE';
  END IF;
  SELECT decrypted_secret INTO STRICT v_secret FROM vault.decrypted_secrets WHERE name = 'SCHEDULER_SIGNING_SECRET';
  SELECT decrypted_secret INTO STRICT v_endpoint FROM vault.decrypted_secrets WHERE name = 'SCHEDULER_EDGE_URL';
  IF pg_catalog.length(v_secret) < 32 THEN RAISE EXCEPTION 'SCHEDULER_SECRET_TOO_SHORT'; END IF;
  IF v_endpoint !~ '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/daily-ops-run$' THEN
    RAISE EXCEPTION 'SCHEDULER_EDGE_URL_INVALID';
  END IF;
  v_endpoint := pg_catalog.regexp_replace(v_endpoint, '/daily-ops-run$', '/market-ads');
  INSERT INTO market.ads_runs(business_id, trigger, days, dry_run, max_calls, created_at)
  VALUES (p_business_id, p_trigger, p_days, p_dry_run, p_max_calls, pg_catalog.clock_timestamp()) RETURNING * INTO r;
  v_issued := pg_catalog.floor(EXTRACT(epoch FROM pg_catalog.clock_timestamp()));
  v_signature := pg_catalog.encode(extensions.hmac('market_ads'||E'\n'||r.business_id||E'\n'||r.id||E'\n'||r.nonce||E'\n'||v_issued,
    v_secret, 'sha256'), 'hex');
  UPDATE market.ads_runs SET request_id = net.http_post(url := v_endpoint,
    headers := pg_catalog.jsonb_build_object('Content-Type','application/json','X-Scheduler-Signature',v_signature),
    body := pg_catalog.jsonb_build_object('business_id',r.business_id,'run_id',r.id,'nonce',r.nonce,'issued_at',v_issued),
    timeout_milliseconds := 10000)
  WHERE id = r.id RETURNING * INTO r;
  RETURN r;
END $$;

-- 7. Elle calistirma: yalniz postgres (SQL Editor). Geriye yalniz kimlik ve sayi doner.
--    Ilk calistirma icin p_days en cok 90; gunluk otomatik calistirma 30 gun yazar.
CREATE FUNCTION market.ads_run_v1(p_business_id uuid, p_days integer DEFAULT 30, p_dry_run boolean DEFAULT false,
  p_max_calls integer DEFAULT 10)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r market.ads_runs;
BEGIN
  r := market.ads_dispatch_v1(p_business_id, 'manual', p_days, p_dry_run, p_max_calls);
  RETURN pg_catalog.jsonb_build_object('run_id', r.id, 'days', r.days, 'dry_run', r.dry_run,
    'max_calls', r.max_calls, 'request_id', r.request_id);
END $$;

-- 8. Gunluk otomatik calistirma: cron her saatin 30. dakikasinda cagirir; yalniz New York
--    saati 08:30-08:59 arasinda ve o gun henuz cron calistirmasi yoksa is uretir (yaz/kis
--    saati degisiminden etkilenmez). Clover cekimi 07:00'dedir.
CREATE FUNCTION market.ads_cron_tick_v1(p_now timestamptz DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_local timestamp := coalesce(p_now, pg_catalog.clock_timestamp()) AT TIME ZONE 'America/New_York';
  s record; v_started integer := 0;
BEGIN
  IF EXTRACT(hour FROM v_local) <> 8 OR EXTRACT(minute FROM v_local) < 30 THEN RETURN 0; END IF;
  FOR s IN SELECT business_id FROM market.ads_settings WHERE daily_enabled ORDER BY business_id LOOP
    PERFORM market.ads_expire_v1(s.business_id);
    CONTINUE WHEN EXISTS(SELECT 1 FROM market.ads_runs WHERE business_id = s.business_id AND trigger = 'cron'
      AND (created_at AT TIME ZONE 'America/New_York')::date = v_local::date);
    CONTINUE WHEN EXISTS(SELECT 1 FROM market.ads_runs WHERE business_id = s.business_id AND status IN ('queued','running'));
    PERFORM market.ads_dispatch_v1(s.business_id, 'cron', 30, false, 10);
    v_started := v_started + 1;
  END LOOP;
  RETURN v_started;
END $$;

-- 9. Edge: calistirmayi bir kez sahiplen (yalniz service_role). Donem New York tarihine gore
--    hesaplanir: dun dahil, bugun haric, son 'days' gun.
CREATE FUNCTION public.market_ads_claim_v1(p_business_id uuid, p_run_id uuid, p_nonce uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r market.ads_runs; v_import uuid; v_now timestamptz := pg_catalog.clock_timestamp(); v_end date;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  v_end := (v_now AT TIME ZONE 'America/New_York')::date - 1;
  UPDATE market.ads_runs SET status = 'running', claim_token = gen_random_uuid(), started_at = v_now,
    period_end = v_end, period_start = v_end - (days - 1)
  WHERE business_id = p_business_id AND id = p_run_id AND nonce = p_nonce AND status = 'queued'
    AND created_at > v_now - interval '15 minutes'
  RETURNING * INTO r;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO market.imports(business_id, source, kind, period_start, period_end, status, row_count, observed_at)
  VALUES (p_business_id, 'google_ads_api', 'ads_google', r.period_start, r.period_end, 'running', 0, v_now) RETURNING id INTO v_import;
  UPDATE market.ads_runs SET import_id = v_import WHERE id = r.id;
  RETURN pg_catalog.jsonb_build_object('claim_token', r.claim_token, 'dry_run', r.dry_run, 'max_calls', r.max_calls,
    'days', r.days, 'period_start', r.period_start, 'period_end', r.period_end);
END $$;

-- 10. Edge: sonucu yaz (yalniz service_role). Satirlar (isletme, platform, kampanya, gun) ile
--     guncellenir; ayni gun yeniden yazilinca kopya olusmaz. Bos rapor sifir satir uydurmaz.
--     'failed' sonuc, ayni gun ayni kod icin ilk kez ise uyari hakki (alert_due) doner.
CREATE FUNCTION public.market_ads_finish_v1(p_business_id uuid, p_run_id uuid, p_claim_token uuid,
  p_status text, p_safe_code text, p_calls_used integer, p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r market.ads_runs; v_now timestamptz := pg_catalog.clock_timestamp(); v_rows integer := 0; v_due boolean := false;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO r FROM market.ads_runs WHERE business_id = p_business_id AND id = p_run_id
    AND claim_token = p_claim_token AND status = 'running' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MARKET_ADS_RUN_NOT_CLAIMED'; END IF;
  IF p_status NOT IN ('succeeded','failed') OR p_safe_code IS NULL OR p_safe_code !~ '^[a-z0-9_]{1,64}$'
    OR p_calls_used IS NULL OR p_calls_used < 0 OR p_calls_used > r.max_calls
    OR pg_catalog.jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_rows) > 20000 THEN
    RAISE EXCEPTION 'MARKET_ADS_RESULT_INVALID';
  END IF;
  IF (r.dry_run AND (p_calls_used <> 0 OR pg_catalog.jsonb_array_length(p_rows) > 0))
    OR (p_status = 'failed' AND pg_catalog.jsonb_array_length(p_rows) > 0) THEN
    RAISE EXCEPTION 'MARKET_ADS_RESULT_INVALID';
  END IF;

  DROP TABLE IF EXISTS pg_temp.market_ads_rows;
  CREATE TEMP TABLE pg_temp.market_ads_rows ON COMMIT DROP AS
  SELECT x.* FROM pg_catalog.jsonb_to_recordset(p_rows) AS x(campaign_id text, campaign_name text, report_date date,
    impressions bigint, clicks bigint, spend numeric, conversions numeric);
  IF EXISTS(SELECT 1 FROM pg_temp.market_ads_rows WHERE campaign_id IS NULL OR campaign_id !~ '^[0-9]{1,20}$'
      OR pg_catalog.length(campaign_name) > 300 OR report_date IS NULL
      OR report_date NOT BETWEEN r.period_start AND r.period_end
      OR impressions IS NULL OR impressions < 0 OR clicks IS NULL OR clicks < 0
      OR spend IS NULL OR spend < 0 OR spend >= 10000000000 OR conversions IS NULL OR conversions < 0 OR conversions >= 10000000000)
    OR (SELECT pg_catalog.count(*) <> pg_catalog.count(DISTINCT (campaign_id, report_date)) FROM pg_temp.market_ads_rows) THEN
    RAISE EXCEPTION 'MARKET_ADS_RESULT_INVALID';
  END IF;

  INSERT INTO market.ad_reports AS a(business_id, platform, campaign_id, campaign_name, report_date, impressions, clicks,
    spend, conversions, currency, source, observed_at, import_id, updated_at)
  SELECT p_business_id, 'google_ads', x.campaign_id, x.campaign_name, x.report_date, x.impressions, x.clicks,
    pg_catalog.round(x.spend, 2), pg_catalog.round(x.conversions, 2), 'USD', 'google_ads_api', v_now, r.import_id, v_now
  FROM pg_temp.market_ads_rows x
  ON CONFLICT (business_id, platform, campaign_id, report_date) DO UPDATE SET campaign_name = EXCLUDED.campaign_name,
    impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks, spend = EXCLUDED.spend, conversions = EXCLUDED.conversions,
    currency = EXCLUDED.currency, source = EXCLUDED.source, observed_at = EXCLUDED.observed_at,
    import_id = EXCLUDED.import_id, updated_at = EXCLUDED.updated_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF p_status = 'failed' THEN
    INSERT INTO market.ads_alerts(business_id, alert_date, safe_code, run_id)
    VALUES (p_business_id, (v_now AT TIME ZONE 'America/New_York')::date, p_safe_code, r.id)
    ON CONFLICT DO NOTHING;
    v_due := FOUND;
  END IF;
  UPDATE market.imports SET status = p_status, row_count = v_rows WHERE id = r.import_id;
  UPDATE market.ads_runs SET status = p_status, safe_code = p_safe_code, calls_used = p_calls_used, rows_written = v_rows,
    alert_status = CASE WHEN p_status <> 'failed' THEN NULL WHEN v_due THEN 'pending' ELSE 'already_sent_today' END,
    finished_at = v_now
  WHERE id = r.id;
  RETURN pg_catalog.jsonb_build_object('rows_written', v_rows, 'alert_due', v_due);
END $$;

-- 11. Edge: uyari e-postasinin sonucunu yaz (yalniz service_role; yalniz bekleyen uyari icin)
CREATE FUNCTION public.market_ads_alert_v1(p_business_id uuid, p_run_id uuid, p_claim_token uuid, p_alert_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF p_alert_status NOT IN ('sent','not_accepted','provider_error','alert_not_configured') THEN
    RAISE EXCEPTION 'MARKET_ADS_ALERT_STATUS_INVALID';
  END IF;
  UPDATE market.ads_runs SET alert_status = p_alert_status
  WHERE business_id = p_business_id AND id = p_run_id AND claim_token = p_claim_token
    AND status = 'failed' AND alert_status = 'pending';
  RETURN FOUND;
END $$;

-- 12. Erisim: market tablolari kapali; baslatma yalniz postgres; Edge RPC'leri yalniz service_role
ALTER TABLE market.ads_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE market.ads_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE market.ads_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA market FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA market FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA market FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.market_ads_claim_v1(uuid,uuid,uuid),
  public.market_ads_finish_v1(uuid,uuid,uuid,text,text,integer,jsonb),
  public.market_ads_alert_v1(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.market_ads_claim_v1(uuid,uuid,uuid),
  public.market_ads_finish_v1(uuid,uuid,uuid,text,text,integer,jsonb),
  public.market_ads_alert_v1(uuid,uuid,uuid,text) TO service_role;

-- 13. Ayri cron isi (mevcut islere dokunulmaz). pg_cron UTC calisir; saat secimi tick icindedir.
SELECT cron.schedule('market-ads-daily', '30 * * * *', 'SELECT market.ads_cron_tick_v1();');

-- 14. Son kontrol
DO $post$
DECLARE r record;
BEGIN
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.relnamespace='market'::regnamespace AND c.relkind='r' AND NOT c.relrowsecurity) THEN
    RAISE EXCEPTION 'G13_RLS_REQUIRED';
  END IF;
  FOR r IN SELECT unnest(ARRAY['anon','authenticated','service_role']) AS role LOOP
    IF pg_catalog.has_schema_privilege(r.role,'market','USAGE')
      OR pg_catalog.has_schema_privilege(r.role,'core','USAGE')
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_class c
        WHERE c.relnamespace='market'::regnamespace AND c.relkind='r'
          AND pg_catalog.has_table_privilege(r.role,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace='market'::regnamespace
        AND pg_catalog.has_function_privilege(r.role,p.oid,'EXECUTE')) THEN
      RAISE EXCEPTION 'G13_PRIVATE_MARKET_REQUIRED';
    END IF;
  END LOOP;
  IF pg_catalog.has_function_privilege('anon','public.market_ads_finish_v1(uuid,uuid,uuid,text,text,integer,jsonb)','EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated','public.market_ads_claim_v1(uuid,uuid,uuid)','EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated','public.market_ads_alert_v1(uuid,uuid,uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'G13_RPC_EXPOSED';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM cron.job WHERE jobname = 'market-ads-daily' AND schedule = '30 * * * *'
      AND command = 'SELECT market.ads_cron_tick_v1();') <> 1 THEN
    RAISE EXCEPTION 'G13_CRON_JOB_MISSING';
  END IF;
END $post$;
COMMIT;
