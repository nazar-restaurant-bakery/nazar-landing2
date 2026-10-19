-- Additive test markers. Run only after the reviewed schema baseline.
-- No provider action, consent change or production execution is part of K3.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
ALTER TABLE core.businesses ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
ALTER TABLE core.customers ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
ALTER TABLE core.offers ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
COMMIT;
