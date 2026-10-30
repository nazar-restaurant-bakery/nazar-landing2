-- Catering checkout follow-up (29 Oct live test). LF bytes, psql 18.6.
-- 1. Optional email marketing consent at checkout uses the existing VIP intake
--    path (submit_signup_once -> submit_signup -> core.customers/signups/
--    consent_events) with source 'catering_checkout'. Only the source allowlist
--    line of submit_signup and the signups source CHECK change; the function is
--    re-created from its live definition, so its body, owner and ACL otherwise
--    stay byte-identical. Suppression and test classification triggers unchanged.
-- 2. A server-only read of a claimed confirmation email's order lines and totals.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('catering_checkout_consent_email_lines_v1',0));

DO $guard$
DECLARE v_def text; v_old text:=$s$v_source NOT IN ('website_vip_form','website_vip_page','catering')$s$;
BEGIN
  IF pg_catalog.to_regprocedure('public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)') IS NULL
    OR pg_catalog.to_regprocedure('public.submit_signup_once(uuid,uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)') IS NULL
    OR pg_catalog.to_regclass('core.signups') IS NULL
    OR pg_catalog.to_regclass('core.consent_events') IS NULL
    OR pg_catalog.to_regclass('core.site_orders') IS NULL
    OR pg_catalog.to_regclass('core.site_order_customer_emails') IS NULL
    OR pg_catalog.to_regprocedure('public.site_order_customer_email_claim_v1(uuid,text)') IS NULL
  THEN RAISE EXCEPTION 'CATERING_CONSENT_PREREQUISITE_REQUIRED'; END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
  THEN RAISE EXCEPTION 'CATERING_CONSENT_CORE_MUST_BE_PRIVATE'; END IF;
  IF pg_catalog.to_regprocedure('public.site_order_customer_email_detail_v1(uuid,uuid)') IS NOT NULL
  THEN RAISE EXCEPTION 'CATERING_CONSENT_ALREADY_INSTALLED'; END IF;
  v_def:=pg_catalog.pg_get_functiondef('public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)'::regprocedure);
  IF (pg_catalog.length(v_def)-pg_catalog.length(pg_catalog.replace(v_def,v_old,'')))<>pg_catalog.length(v_old)
    OR pg_catalog.strpos(v_def,'catering_checkout')>0
    OR (SELECT pg_catalog.pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint
        WHERE conrelid='core.signups'::regclass AND conname='signups_source_check')
      IS DISTINCT FROM $s$CHECK ((source = ANY (ARRAY['website_vip_form'::text, 'website_vip_page'::text, 'catering'::text])))$s$
  THEN RAISE EXCEPTION 'CATERING_CONSENT_UNEXPECTED_SIGNUP_DEFINITION'; END IF;
END $guard$;

ALTER TABLE core.signups DROP CONSTRAINT signups_source_check,
  ADD CONSTRAINT signups_source_check
    CHECK (source = ANY (ARRAY['website_vip_form','website_vip_page','catering','catering_checkout']));

DO $source$
BEGIN
  EXECUTE pg_catalog.replace(
    pg_catalog.pg_get_functiondef('public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)'::regprocedure),
    $s$v_source NOT IN ('website_vip_form','website_vip_page','catering')$s$,
    $s$v_source NOT IN ('website_vip_form','website_vip_page','catering','catering_checkout')$s$);
END $source$;

-- Readable only while this order's confirmation email is claimed, i.e. only by
-- the sender between claim and finish. Totals are stored values, never recomputed.
CREATE FUNCTION public.site_order_customer_email_detail_v1(p_business_id uuid,p_site_order_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT pg_catalog.jsonb_build_object('customerName',o.customer_name,
    'preparationNote',o.preparation_note,'lines',o.lines,'subtotalCents',o.subtotal_cents,
    'taxCents',o.tax_cents,'totalCents',o.total_cents) INTO v_result
  FROM core.site_orders o
  JOIN core.site_order_customer_emails e
    ON e.business_id=o.business_id AND e.site_order_id=o.id AND e.status='claimed'
  WHERE o.business_id=p_business_id AND o.id=p_site_order_id;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.site_order_customer_email_detail_v1(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.site_order_customer_email_detail_v1(uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
