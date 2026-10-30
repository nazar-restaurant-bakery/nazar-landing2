-- G4 geri alma. Yalniz GO verisi yokken calisir; veri varsa durur (engel listesi silinmez).
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('go_outreach_tables_v1',0));
DO $guard$
BEGIN
  IF EXISTS(SELECT 1 FROM core.message_log WHERE b2b_lead_id IS NOT NULL OR customer_id IS NULL)
    OR EXISTS(SELECT 1 FROM core.b2b_leads) OR EXISTS(SELECT 1 FROM core.email_suppressions)
    OR EXISTS(SELECT 1 FROM core.enrichment_log) OR EXISTS(SELECT 1 FROM core.api_keys)
    OR EXISTS(SELECT 1 FROM core.outreach_settings) THEN
    RAISE EXCEPTION 'G4_ROLLBACK_DATA_PRESENT';
  END IF;
END $guard$;
DROP TRIGGER message_log_b2b_lead_immutable ON core.message_log;
DROP FUNCTION core.message_log_b2b_lead_immutable_v1();
DROP INDEX core.message_log_b2b_quota;
ALTER TABLE core.message_log DROP CONSTRAINT message_log_target_one;
ALTER TABLE core.message_log DROP COLUMN b2b_lead_id;
ALTER TABLE core.message_log ALTER COLUMN customer_id SET NOT NULL;
DROP TABLE core.api_key_businesses, core.api_keys, core.enrichment_log,
  core.email_suppressions, core.outreach_settings, core.b2b_leads;
DROP FUNCTION core.email_suppressions_immutable_v1();
COMMIT;
