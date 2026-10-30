-- Geri alma: catering odeme izni + onay e-postasi satirlari. LF, psql 18.6.
-- 'catering_checkout' kaynakli kayit varsa durur: izin kayitlari yalniz
-- eklenebilir (core.consent_events degistirilemez), silinmez.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('catering_checkout_consent_email_lines_v1',0));
DO $guard$ BEGIN
  IF pg_catalog.to_regprocedure('public.site_order_customer_email_detail_v1(uuid,uuid)') IS NULL
  THEN RAISE EXCEPTION 'CATERING_CONSENT_NOT_INSTALLED'; END IF;
  IF EXISTS(SELECT 1 FROM core.signups WHERE source='catering_checkout')
  THEN RAISE EXCEPTION 'CATERING_CONSENT_ROLLBACK_DATA_PRESENT'; END IF;
END $guard$;
DROP FUNCTION public.site_order_customer_email_detail_v1(uuid,uuid);
DO $source$
BEGIN
  EXECUTE pg_catalog.replace(
    pg_catalog.pg_get_functiondef('public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)'::regprocedure),
    $s$v_source NOT IN ('website_vip_form','website_vip_page','catering','catering_checkout')$s$,
    $s$v_source NOT IN ('website_vip_form','website_vip_page','catering')$s$);
END $source$;
ALTER TABLE core.signups DROP CONSTRAINT signups_source_check,
  ADD CONSTRAINT signups_source_check
    CHECK (source = ANY (ARRAY['website_vip_form'::text,'website_vip_page'::text,'catering'::text]));
NOTIFY pgrst,'reload schema';
COMMIT;
