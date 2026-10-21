-- Forward-only contract v1.1 authorization; order 14b, before staff-management order 15.
-- No seed, membership mutation, account/invite operation, public grant or send.
-- Applied K9/order 8 remains immutable. Owner mutation guards belong to order 15.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('staff_manage_authorization_v1',0));
DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure('core.staff_authorized_v1(uuid,text)') IS NULL
    OR pg_catalog.to_regprocedure('public.staff_business_authorized_v1(uuid,text)') IS NULL
    OR pg_catalog.to_regclass('core.business_staff') IS NULL
    OR pg_catalog.to_regclass('core.platform_operators') IS NULL THEN
    RAISE EXCEPTION 'STAFF_MANAGE_K9_REQUIRED';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc
      WHERE oid='core.staff_authorized_v1(uuid,text)'::regprocedure) IS DISTINCT FROM '91693fbd873a60de9c9d5c59cad666dc' THEN
    RAISE EXCEPTION 'STAFF_MANAGE_PREDECESSOR_REVIEW_REQUIRED';
  END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
    OR pg_catalog.current_setting('session_replication_role')<>'origin' THEN
    RAISE EXCEPTION 'STAFF_MANAGE_PRIVATE_CORE_REQUIRED';
  END IF;
END $preflight$;

CREATE OR REPLACE FUNCTION core.staff_authorized_v1(p_business_id uuid,p_operation text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT COALESCE(auth.uid() IS NOT NULL AND CASE
    WHEN p_operation='platform.read' THEN p_business_id IS NULL AND EXISTS(
      SELECT 1 FROM core.platform_operators p WHERE p.staff_id=auth.uid() AND p.active)
    WHEN p_operation='staff.manage' THEN p_business_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM core.businesses b WHERE b.id=p_business_id)
      AND EXISTS(SELECT 1 FROM core.business_staff s
        WHERE s.business_id=p_business_id AND s.staff_id=auth.uid() AND s.active
          AND (s.role='owner' OR EXISTS(SELECT 1 FROM core.platform_operators p
            WHERE p.staff_id=auth.uid() AND p.active)))
    WHEN p_operation IN('crm.read','orders.read','ops.read','loyalty.read',
      'crm.write','consent.restore','orders.match','campaign.staff_mark','ops.write')
      THEN p_business_id IS NOT NULL
        AND EXISTS(SELECT 1 FROM core.businesses b WHERE b.id=p_business_id)
        AND (EXISTS(SELECT 1 FROM core.business_staff s
          WHERE s.business_id=p_business_id AND s.staff_id=auth.uid() AND s.active)
        OR (p_operation IN('crm.read','orders.read','ops.read','loyalty.read')
          AND EXISTS(SELECT 1 FROM core.platform_operators p WHERE p.staff_id=auth.uid() AND p.active)))
    ELSE false END,false)
$$;
REVOKE ALL ON FUNCTION core.staff_authorized_v1(uuid,text)
  FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
