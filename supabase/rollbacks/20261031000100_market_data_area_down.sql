-- G8 geri alma. Yalniz market semasinda veri yokken calisir; veri varsa durur.
-- core semasina dokunmaz. Beklenmeyen bir nesne kalirsa DROP SCHEMA (CASCADE olmadan) durur.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('market_data_area_v1',0));
DO $guard$
BEGIN
  IF pg_catalog.to_regnamespace('market') IS NULL THEN
    RAISE EXCEPTION 'G8_NOT_APPLIED';
  END IF;
  IF EXISTS(SELECT 1 FROM market.imports) OR EXISTS(SELECT 1 FROM market.competitors)
    OR EXISTS(SELECT 1 FROM market.competitor_menu_items) OR EXISTS(SELECT 1 FROM market.competitor_reviews)
    OR EXISTS(SELECT 1 FROM market.competitor_ads) OR EXISTS(SELECT 1 FROM market.area_businesses)
    OR EXISTS(SELECT 1 FROM market.ad_reports) OR EXISTS(SELECT 1 FROM market.business_profile_reports) THEN
    RAISE EXCEPTION 'G8_ROLLBACK_DATA_PRESENT';
  END IF;
END $guard$;
DROP TABLE market.competitor_menu_items, market.competitor_reviews, market.competitor_ads,
  market.area_businesses, market.ad_reports, market.business_profile_reports;
DROP TABLE market.competitors;
DROP TABLE market.imports;
DROP FUNCTION market.area_business_lead_scope_v1();
DROP SCHEMA market;
COMMIT;
