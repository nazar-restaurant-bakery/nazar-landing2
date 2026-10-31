-- G12 geri alma. Places verisi yokken calisir; veri varsa durur. G8 (market semasi) kalir.
-- core semasina dokunmaz.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('market_places_v1',0));
DO $guard$
BEGIN
  IF pg_catalog.to_regclass('market.places_runs') IS NULL THEN
    RAISE EXCEPTION 'G12_NOT_APPLIED';
  END IF;
  IF EXISTS(SELECT 1 FROM market.places_runs)
    OR EXISTS(SELECT 1 FROM market.imports WHERE kind IN ('places_catering','places_restaurant'))
    OR EXISTS(SELECT 1 FROM market.competitors WHERE topics <> '{}' OR city IS NOT NULL OR county IS NOT NULL)
    OR EXISTS(SELECT 1 FROM market.area_businesses WHERE topics <> '{}' OR city IS NOT NULL OR county IS NOT NULL) THEN
    RAISE EXCEPTION 'G12_ROLLBACK_DATA_PRESENT';
  END IF;
END $guard$;
DROP FUNCTION public.market_places_finish_v1(uuid,uuid,uuid,text,text,integer,integer,jsonb,jsonb);
DROP FUNCTION public.market_places_claim_v1(uuid,uuid,uuid);
DROP FUNCTION market.places_run_v1(uuid,text,boolean,integer);
DROP FUNCTION market.area_settings_set_v1(uuid,text,text[],numeric,boolean);
DROP FUNCTION market.company_key_v1(text);
DROP FUNCTION market.city_key_v1(text);
DROP TABLE market.places_runs;
DROP TABLE market.area_settings;
ALTER TABLE market.competitors DROP COLUMN topics, DROP COLUMN city, DROP COLUMN county;
ALTER TABLE market.area_businesses DROP COLUMN topics, DROP COLUMN city, DROP COLUMN county;
ALTER TABLE market.imports DROP CONSTRAINT imports_kind_check;
ALTER TABLE market.imports ADD CONSTRAINT imports_kind_check CHECK (kind IN ('competitors','competitor_menu_items',
  'competitor_reviews','competitor_ads','area_businesses','ad_reports','business_profile_reports'));
COMMIT;
