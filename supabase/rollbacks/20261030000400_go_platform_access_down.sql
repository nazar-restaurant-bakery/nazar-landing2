-- Geri alma: GO platform erisim fonksiyonlari (sira 31). LF, psql 18.6.
-- Yalniz 20261030000400 fonksiyonlarini kaldirir; tablolar ve veriler degismez.
-- Once GO Worker'i durdur ya da GO_SUPABASE_URL'i eski projeye dondur.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('go_platform_access_v1',0));
DO $guard$ BEGIN
  IF pg_catalog.to_regprocedure('core.go_scope_v1(uuid)') IS NULL THEN RAISE EXCEPTION 'GO_ACCESS_NOT_INSTALLED'; END IF;
END $guard$;
DROP FUNCTION public.go_platform_verify_v1(uuid), public.go_suppress_email_v1(uuid,text,text,text,text),
  public.go_lead_fill_v1(uuid,uuid,jsonb), public.go_leads_insert_v1(uuid,jsonb),
  public.go_suppressed_emails_v1(uuid,text[]), public.go_leads_by_email_v1(uuid,text[]),
  public.go_lead_enrichment_found_v1(uuid,uuid,text,jsonb), public.go_lead_enrichment_fail_v1(uuid,uuid,jsonb),
  public.go_lead_enrichment_note_v1(uuid,uuid,jsonb), public.go_enrichment_log_v1(uuid,uuid,text,integer,text),
  public.go_leads_enrichment_pending_v1(uuid,integer,uuid[]),
  public.go_enrichment_credits_used_v1(uuid,timestamptz,timestamptz),
  public.go_outreach_business_ids_v1(), public.go_outreach_settings_get_v1(uuid),
  public.go_business_check_v1(uuid), public.go_api_key_revoke_v1(text),
  public.go_api_key_create_v1(text,text,text,uuid[]), public.go_api_key_authorize_v1(text,uuid);
DROP FUNCTION core.go_email_v1(text), core.go_scope_v1(uuid);
NOTIFY pgrst,'reload schema';
COMMIT;
