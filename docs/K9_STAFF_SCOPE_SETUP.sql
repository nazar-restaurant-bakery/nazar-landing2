-- MANUAL SETUP ONLY, AFTER migration 8 and its test-environment acceptance.
-- Not a migration or seed. Talip verifies the Auth UUIDs and target first.
-- Same psql18.6/TLS runner; supply business_id, talip_staff_id, yucel_staff_id,
-- talip_role as psql variables. Never supply a password as a variable/argument.
-- In sandbox use synthetic test accounts; never copy real customer data.
\if :{?business_id}
\else
  \echo 'Required: business_id'
  \quit 3
\endif
\if :{?talip_staff_id}
\else
  \echo 'Required: talip_staff_id (verified Auth UUID)'
  \quit 3
\endif
\if :{?yucel_staff_id}
\else
  \echo 'Required: yucel_staff_id (verified Auth UUID)'
  \quit 3
\endif
\if :{?talip_role}
\else
  \echo 'Required: talip_role (owner / manager / staff; Talip decides)'
  \quit 3
\endif
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
CREATE TEMP TABLE staff_setup_input ON COMMIT DROP AS SELECT
  :'business_id'::uuid AS business_id, :'talip_staff_id'::uuid AS talip_id,
  :'yucel_staff_id'::uuid AS yucel_id, :'talip_role'::text AS talip_role;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM staff_setup_input i WHERE i.talip_id=i.yucel_id
    OR i.talip_role NOT IN('owner','manager','staff')
    OR NOT EXISTS(SELECT 1 FROM core.businesses b WHERE b.id=i.business_id)
    OR NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=i.talip_id)
    OR NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=i.yucel_id)) THEN
    RAISE EXCEPTION 'STAFF_SETUP_VERIFIED_DISTINCT_AUTH_IDS_AND_BUSINESS_REQUIRED';
  END IF;
END $$;
INSERT INTO core.platform_operators(staff_id,active)
  SELECT talip_id,true FROM staff_setup_input
  ON CONFLICT(staff_id) DO UPDATE SET active=true;
INSERT INTO core.business_staff(business_id,staff_id,role,active)
  SELECT business_id,talip_id,talip_role,true FROM staff_setup_input
  UNION ALL SELECT business_id,yucel_id,'owner',true FROM staff_setup_input
  ON CONFLICT(business_id,staff_id) DO UPDATE SET role=excluded.role,active=true;
-- Aggregate receipt only; no email, password or Auth UUID is emitted.
SELECT (SELECT count(*) FROM core.platform_operators p JOIN staff_setup_input i
  ON p.staff_id=i.talip_id WHERE p.active)=1 AS platform_mapping_ok,
 (SELECT count(*) FROM core.business_staff s JOIN staff_setup_input i
  ON s.business_id=i.business_id WHERE s.staff_id IN(i.talip_id,i.yucel_id) AND s.active)=2
  AS business_mappings_ok;
COMMIT;
