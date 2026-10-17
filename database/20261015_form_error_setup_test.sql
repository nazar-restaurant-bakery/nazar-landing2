-- Only adds an explicit synthetic test code; no customer records or roles change.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='20s';
DO $guard$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM core.installation WHERE declared_project_ref='khgczybubufouraqyrcj') OR to_regclass('core.form_errors') IS NULL THEN RAISE EXCEPTION 'Wrong project'; END IF;
END $guard$;
ALTER TABLE core.form_errors DROP CONSTRAINT form_errors_error_code_check;
ALTER TABLE core.form_errors ADD CONSTRAINT form_errors_error_code_check CHECK(error_code IN (
 'missing_server_configuration','challenge_unavailable','database_unavailable','upstream_timeout','upstream_network_error','controlled_delivery_test'));
COMMIT;
