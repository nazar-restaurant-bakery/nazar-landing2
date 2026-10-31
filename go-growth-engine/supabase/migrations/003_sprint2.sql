BEGIN;

-- 1. İşletme ayarları: bağlantı adresi ve mesai penceresi
ALTER TABLE core.business_settings
  ADD COLUMN IF NOT EXISTS outreach_link_base_url TEXT,
  ADD COLUMN IF NOT EXISTS outreach_timezone TEXT,
  ADD COLUMN IF NOT EXISTS outreach_send_days SMALLINT[],
  ADD COLUMN IF NOT EXISTS outreach_send_start TIME,
  ADD COLUMN IF NOT EXISTS outreach_send_end TIME;

UPDATE core.business_settings SET
  outreach_link_base_url = 'https://links.nazarrestaurantandbakery.com',
  outreach_timezone = 'America/New_York',
  outreach_send_days = '{1,2,3,4,5}',
  outreach_send_start = '09:00',
  outreach_send_end = '16:00',
  updated_at = now()
WHERE business_id = 'b10a2938-7481-4233-a261-291823901a11';

ALTER TABLE core.business_settings
  ALTER COLUMN outreach_link_base_url SET NOT NULL,
  ALTER COLUMN outreach_timezone SET NOT NULL,
  ALTER COLUMN outreach_send_days SET NOT NULL,
  ALTER COLUMN outreach_send_start SET NOT NULL,
  ALTER COLUMN outreach_send_end SET NOT NULL;

ALTER TABLE core.business_settings
  ADD CONSTRAINT business_settings_link_https_check
    CHECK (outreach_link_base_url LIKE 'https://%'),
  ADD CONSTRAINT business_settings_send_window_check
    CHECK (outreach_send_start < outreach_send_end),
  ADD CONSTRAINT business_settings_send_days_check
    CHECK (cardinality(outreach_send_days) > 0
           AND outreach_send_days <@ '{1,2,3,4,5,6,7}'::SMALLINT[]);

-- 2. API anahtarları (yalnız özet saklanır)
CREATE TABLE IF NOT EXISTS core.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
ALTER TABLE core.api_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE core.api_keys FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE core.api_keys TO service_role;

CREATE TABLE IF NOT EXISTS core.api_key_businesses (
  api_key_id UUID NOT NULL REFERENCES core.api_keys(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  PRIMARY KEY (api_key_id, business_id)
);
ALTER TABLE core.api_key_businesses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE core.api_key_businesses FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE core.api_key_businesses TO service_role;

-- 3. Webhook eşleştirmesi için sağlayıcı mesaj kimliği
ALTER TABLE core.message_log ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_log_provider_message_id
  ON core.message_log (provider_message_id) WHERE provider_message_id IS NOT NULL;

COMMIT;
