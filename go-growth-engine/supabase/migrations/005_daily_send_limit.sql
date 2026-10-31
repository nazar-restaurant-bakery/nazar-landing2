-- 005: isletme basina gunluk gonderim siniri (alan adi isinmasi icin)
BEGIN;
ALTER TABLE core.business_settings
  ADD COLUMN IF NOT EXISTS outreach_daily_send_limit INTEGER NOT NULL DEFAULT 10;
ALTER TABLE core.business_settings
  ADD CONSTRAINT business_settings_daily_send_limit_check
    CHECK (outreach_daily_send_limit BETWEEN 1 AND 500);
COMMIT;
