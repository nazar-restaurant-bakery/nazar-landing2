-- G13 geri alma. Ads verisi yokken calisir; veri varsa durur. G8 ve G12 kalir.
-- core semasina ve diger cron islerine dokunmaz; yalniz 'market-ads-daily' kaldirilir.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('market_ads_v1',0));
DO $guard$
BEGIN
  IF pg_catalog.to_regclass('market.ads_runs') IS NULL THEN
    RAISE EXCEPTION 'G13_NOT_APPLIED';
  END IF;
  IF EXISTS(SELECT 1 FROM market.ads_runs)
    OR EXISTS(SELECT 1 FROM market.imports WHERE kind = 'ads_google')
    OR EXISTS(SELECT 1 FROM market.ad_reports WHERE source = 'google_ads_api') THEN
    RAISE EXCEPTION 'G13_ROLLBACK_DATA_PRESENT';
  END IF;
END $guard$;
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'market-ads-daily';
DROP FUNCTION public.market_ads_alert_v1(uuid,uuid,uuid,text);
DROP FUNCTION public.market_ads_finish_v1(uuid,uuid,uuid,text,text,integer,jsonb);
DROP FUNCTION public.market_ads_claim_v1(uuid,uuid,uuid);
DROP FUNCTION market.ads_cron_tick_v1(timestamptz);
DROP FUNCTION market.ads_run_v1(uuid,integer,boolean,integer);
DROP FUNCTION market.ads_dispatch_v1(uuid,text,integer,boolean,integer);
DROP FUNCTION market.ads_expire_v1(uuid);
DROP TABLE market.ads_alerts;
DROP TABLE market.ads_runs;
DROP TABLE market.ads_settings;
ALTER TABLE market.imports DROP CONSTRAINT imports_kind_check;
ALTER TABLE market.imports ADD CONSTRAINT imports_kind_check CHECK (kind IN ('competitors','competitor_menu_items',
  'competitor_reviews','competitor_ads','area_businesses','ad_reports','business_profile_reports',
  'places_catering','places_restaurant'));
COMMIT;
