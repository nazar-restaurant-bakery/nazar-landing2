-- Proposed 21a: Production-only prerequisite repair. Not an all-marker K3 replay.
-- Existing rows acquire false; no name/email backfill, consent or status update.
-- A repeat or an unexpected existing column is a review-required failure.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
LOCK TABLE core.customers IN ACCESS EXCLUSIVE MODE;
DO $prerequisites$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres'
     OR NOT (SELECT count(*) = 1
                    AND min(declared_project_ref) = 'khgczybubufouraqyrcj'
             FROM core.installation)
  THEN
    RAISE EXCEPTION 'CUSTOMER_MARKER_REPAIR_PRODUCTION_TARGET_REQUIRED';
  END IF;
  IF to_regprocedure('core.test_lead_reason_v1(text,text)') IS NULL
     OR to_regprocedure('core.classify_test_customer_v1()') IS NOT NULL
     OR EXISTS (SELECT FROM pg_trigger
                WHERE tgrelid = 'core.customers'::regclass
                  AND tgname = 'classify_test_customer')
     OR EXISTS (SELECT FROM pg_attribute
                WHERE attrelid = 'core.customers'::regclass
                  AND attname = 'is_test' AND NOT attisdropped)
  THEN
    RAISE EXCEPTION 'CUSTOMER_MARKER_REPAIR_REVIEW_REQUIRED';
  END IF;
END
$prerequisites$;
ALTER TABLE core.customers ADD COLUMN is_test boolean NOT NULL DEFAULT false;
COMMIT;
