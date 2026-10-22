-- Forward-only offer activation. Apply after the Ops panel and test-marker migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$ BEGIN
  IF to_regclass('core.offers') IS NULL
     OR to_regclass('core.ops_offer_approvals') IS NULL
     OR to_regprocedure('public.ops_apply_offer_action(uuid,uuid)') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'core' AND table_name = 'offers' AND column_name = 'is_test'
     ) THEN
    RAISE EXCEPTION 'OFFER_CALENDAR_PREDECESSOR_REQUIRED';
  END IF;
END $guard$;

-- A code must identify only one offer within a business, regardless of case.
CREATE UNIQUE INDEX offers_business_code_ci_uidx
  ON core.offers (business_id, lower(code)) WHERE code IS NOT NULL;

CREATE FUNCTION public.set_offer_active(p_offer_id uuid, p_active boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_offer core.offers; v_business_id uuid; v_fingerprint text;
BEGIN
  -- Only the server-side Ops collector may execute this function.
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  IF p_offer_id IS NULL OR p_active IS NULL THEN
    RAISE EXCEPTION 'Invalid offer action' USING ERRCODE = '22023';
  END IF;

  SELECT business_id INTO v_business_id FROM core.offers WHERE id = p_offer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offer not found' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_business_id::text, 0));
  SELECT * INTO v_offer FROM core.offers WHERE id = p_offer_id FOR UPDATE;
  v_fingerprint := md5((to_jsonb(v_offer)-'active'-'created_at'-'updated_at')::text);
  IF NOT coalesce(v_offer.is_test, false) AND NOT EXISTS (
    SELECT 1 FROM core.ops_offer_approvals a
    WHERE a.business_id = v_offer.business_id AND a.offer_id = v_offer.id
      AND a.condition_fingerprint = v_fingerprint
  ) THEN
    RAISE EXCEPTION 'offer_approval_or_schema_unavailable' USING ERRCODE = '55000';
  END IF;

  -- This also protects against schedules changed outside the import template.
  IF p_active AND EXISTS (
    SELECT 1 FROM core.offers other
    WHERE other.business_id = v_offer.business_id AND other.id <> v_offer.id
      AND other.active AND other.channel_target = v_offer.channel_target
      AND other.starts_at <= v_offer.ends_at AND other.ends_at >= v_offer.starts_at
  ) THEN
    RAISE EXCEPTION 'offer_date_overlap' USING ERRCODE = '22023';
  END IF;
  UPDATE core.offers SET active = p_active WHERE id = v_offer.id;
  RETURN jsonb_build_object('id', v_offer.id, 'active', p_active);
END $fn$;
REVOKE ALL ON FUNCTION public.set_offer_active(uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_offer_active(uuid,boolean) TO service_role;

-- Test offers can be exercised in Sandbox without appearing on the public page.
CREATE OR REPLACE FUNCTION public.get_active_offers(p_business_id uuid)
RETURNS TABLE(id uuid, name text, description text, code text, channel_target text, starts_at date, ends_at date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$
  SELECT o.id, o.name, o.description, o.code, o.channel_target, o.starts_at, o.ends_at
  FROM core.offers o JOIN core.businesses b ON b.id = o.business_id
  WHERE o.business_id = p_business_id AND o.active AND NOT o.is_test
    AND (now() AT TIME ZONE b.timezone)::date BETWEEN o.starts_at AND o.ends_at
  ORDER BY o.starts_at DESC, o.id
$fn$;
REVOKE ALL ON FUNCTION public.get_active_offers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_active_offers(uuid) TO anon, authenticated;
COMMIT;
