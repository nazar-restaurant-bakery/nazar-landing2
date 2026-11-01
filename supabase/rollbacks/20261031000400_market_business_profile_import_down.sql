-- G13 Business Profile ice aktarma geri alma. CSV'den yazilmis veri yokken calisir; veri varsa
-- durur. G8, G12 ve G13 Ads kalir; imports.kind kurali degismez. core semasina dokunmaz.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('market_business_profile_import_v1',0));
DO $guard$
BEGIN
  IF pg_catalog.to_regclass('market.business_profile_settings') IS NULL THEN
    RAISE EXCEPTION 'G13_BP_NOT_APPLIED';
  END IF;
  IF EXISTS(SELECT 1 FROM market.business_profile_settings)
    OR EXISTS(SELECT 1 FROM market.imports WHERE source = 'business_profile_csv')
    OR EXISTS(SELECT 1 FROM market.business_profile_reports WHERE source = 'business_profile_csv') THEN
    RAISE EXCEPTION 'G13_BP_ROLLBACK_DATA_PRESENT';
  END IF;
END $guard$;
DROP FUNCTION market.business_profile_import_v1(uuid,text,text);
DROP FUNCTION market.csv_rows_v1(text);
DROP TABLE market.business_profile_settings;
COMMIT;
