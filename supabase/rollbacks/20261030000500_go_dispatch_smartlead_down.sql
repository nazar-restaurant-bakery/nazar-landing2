-- Geri alma: GO gonderim kapisi + Smartlead (sira 32). LF, psql 18.6.
-- Gonderim kaydi varsa durur: message_log satirlari degistirilemez ve b2b_dispatches
-- onlara baglidir; 'replied' durumunda aday varsa eski kisit geri yuklenemez.
-- Once GO Worker'da gonderimi durdur (GO_SCHEDULER_ENABLED=false, Smartlead kampanyalari durdurulmus).
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('go_dispatch_smartlead_v1',0));
DO $guard$ BEGIN
  IF pg_catalog.to_regclass('core.b2b_dispatches') IS NULL THEN RAISE EXCEPTION 'GO_DISPATCH_NOT_INSTALLED'; END IF;
  IF EXISTS(SELECT 1 FROM core.b2b_dispatches) OR EXISTS(SELECT 1 FROM core.b2b_outreach_events)
    OR EXISTS(SELECT 1 FROM core.b2b_leads WHERE status='replied')
  THEN RAISE EXCEPTION 'GO_DISPATCH_ROLLBACK_DATA_PRESENT'; END IF;
END $guard$;
DROP FUNCTION public.go_smartlead_event_v1(uuid,bigint,text,text[],text,text,timestamptz),
  public.go_smartlead_campaigns_set_v1(uuid,bigint[]), public.go_smartlead_business_v1(bigint),
  public.go_dispatch_result_v1(uuid,uuid,uuid,text,bigint), public.go_dispatch_reserve_v1(uuid,uuid,integer,text),
  public.go_dispatch_due_v1(uuid,integer,uuid), public.go_dispatch_quota_v1(uuid),
  core.go_sent_today_v1(uuid), core.go_b2b_window_blocked_v1(uuid,uuid,text), core.go_suppress_v1(uuid,text,text,text);
DROP TABLE core.b2b_outreach_events, core.b2b_dispatches;
ALTER TABLE core.outreach_settings DROP COLUMN smartlead_campaign_ids;
ALTER TABLE core.b2b_leads DROP CONSTRAINT b2b_leads_status_check,
  ADD CONSTRAINT b2b_leads_status_check CHECK (status IN ('enrichment_pending','enrichment_failed','new',
    'contacted','qualified','converted','unsubscribed','bounced','on_hold'));
NOTIFY pgrst,'reload schema';
COMMIT;
