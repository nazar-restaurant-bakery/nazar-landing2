-- 004: catch-all adresleri bekletmek icin 'on_hold' durumu
BEGIN;
ALTER TABLE core.b2b_leads DROP CONSTRAINT IF EXISTS b2b_leads_status_check;
ALTER TABLE core.b2b_leads ADD CONSTRAINT b2b_leads_status_check
  CHECK (status IN ('enrichment_pending','enrichment_failed','new','contacted',
                    'qualified','converted','unsubscribed','bounced','on_hold'));
COMMIT;
