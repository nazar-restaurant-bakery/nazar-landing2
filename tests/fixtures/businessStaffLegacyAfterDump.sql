-- LOCAL SYNTHETIC DATABASE ONLY. Run after the exact reviewed baseline bytes.
SET check_function_bodies=true;
SET search_path='';
REVOKE ALL ON SCHEMA core FROM PUBLIC,anon,authenticated,service_role;
-- Ops' historical installation guard expects its recorded project binding.
-- Synthetic local metadata only; this is not a hosted project reference.
SELECT pg_catalog.set_config('app.ops_project_ref','local-k9-unified',false);
INSERT INTO core.installation(version,declared_project_ref)
VALUES('local-synthetic-k9-unified','local-k9-unified');
-- The existing baseline intentionally has a single-business constraint. A local
-- fixture alone may remove it so the shared-contract business-B denial tests can
-- execute. Neither the canonical baseline nor a hosted DB is altered by this.
ALTER TABLE core.businesses DROP CONSTRAINT businesses_id_check;
