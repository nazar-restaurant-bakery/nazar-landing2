-- Forward-only customer marker fix; application order awaits coordination review.
-- No historical backfill, consent/status change, provider call or data deletion.
-- Prerequisites: reviewed baseline classifier + K3 customer is_test column.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

DO $prerequisites$
BEGIN
  IF pg_catalog.to_regprocedure('core.test_lead_reason_v1(text,text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema='core' AND table_name='customers'
         AND column_name='is_test' AND data_type='boolean' AND is_nullable='NO')
  THEN RAISE EXCEPTION 'CUSTOMER_TEST_CLASSIFIER_PREREQUISITES_REQUIRED'; END IF;
END $prerequisites$;

CREATE FUNCTION core.classify_test_customer_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  -- Apply the existing explicit marker policy to the customer INSERT itself.
  -- Do not derive marketing permission, or reclassify an existing customer from
  -- an unrelated signup snapshot. Persisted test markers cannot be cleared here.
  IF core.test_lead_reason_v1(NEW.name,NEW.email) IS NOT NULL
     OR (TG_OP='UPDATE' AND OLD.is_test) THEN
    NEW.is_test:=true;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.classify_test_customer_v1() FROM PUBLIC,anon,authenticated,service_role;

CREATE TRIGGER classify_test_customer
BEFORE INSERT OR UPDATE OF name,email,is_test ON core.customers
FOR EACH ROW EXECUTE FUNCTION core.classify_test_customer_v1();
COMMIT;
