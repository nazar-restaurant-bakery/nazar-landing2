BEGIN;

-- 1. b2b_leads
ALTER TABLE core.b2b_leads ALTER COLUMN email DROP NOT NULL;
ALTER TABLE core.b2b_leads DROP CONSTRAINT IF EXISTS b2b_leads_status_check;
ALTER TABLE core.b2b_leads ADD CONSTRAINT b2b_leads_status_check
  CHECK (status IN ('enrichment_pending','enrichment_failed','new','contacted',
                    'qualified','converted','unsubscribed','bounced'));
ALTER TABLE core.b2b_leads ADD CONSTRAINT b2b_leads_email_lowercase_check
  CHECK (email IS NULL OR email = lower(email));
ALTER TABLE core.b2b_leads ADD COLUMN IF NOT EXISTS apollo_person_id TEXT;
ALTER TABLE core.b2b_leads ADD COLUMN IF NOT EXISTS sequence_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE core.b2b_leads ADD COLUMN IF NOT EXISTS next_step_at TIMESTAMPTZ;
ALTER TABLE core.b2b_leads ADD CONSTRAINT b2b_leads_business_apollo_person_unique
  UNIQUE (business_id, apollo_person_id);
CREATE INDEX IF NOT EXISTS idx_b2b_leads_due
  ON core.b2b_leads (business_id, status, next_step_at);

-- 2. business_settings (şemada işletme verisi yok)
CREATE TABLE IF NOT EXISTS core.business_settings (
  business_id UUID PRIMARY KEY REFERENCES core.businesses(id) ON DELETE RESTRICT,
  outreach_sender_name TEXT NOT NULL,
  outreach_sender_email TEXT NOT NULL,
  outreach_reply_to TEXT NOT NULL,
  outreach_physical_address TEXT NOT NULL,
  enrichment_daily_credit_limit INTEGER NOT NULL,
  enrichment_monthly_credit_limit INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE core.business_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE core.business_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE core.business_settings TO service_role;

INSERT INTO core.business_settings (
  business_id, outreach_sender_name, outreach_sender_email, outreach_reply_to,
  outreach_physical_address, enrichment_daily_credit_limit, enrichment_monthly_credit_limit
) VALUES (
  'b10a2938-7481-4233-a261-291823901a11',
  'Nazar Restaurant & Bakery',
  'catering@mail.nazarrestaurantandbakery.com',
  'catering@nazarrestaurantandbakery.com',
  '39 Elm Street, Unit 1, West Haven, CT 06516',
  25, 300
) ON CONFLICT (business_id) DO UPDATE SET
  outreach_sender_name = EXCLUDED.outreach_sender_name,
  outreach_sender_email = EXCLUDED.outreach_sender_email,
  outreach_reply_to = EXCLUDED.outreach_reply_to,
  outreach_physical_address = EXCLUDED.outreach_physical_address,
  enrichment_daily_credit_limit = EXCLUDED.enrichment_daily_credit_limit,
  enrichment_monthly_credit_limit = EXCLUDED.enrichment_monthly_credit_limit,
  updated_at = now();

-- 3. email_suppressions
CREATE TABLE IF NOT EXISTS core.email_suppressions (
  business_id UUID NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  email TEXT NOT NULL CHECK (email = lower(email)),
  suppressed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT,
  source TEXT,
  PRIMARY KEY (business_id, email)
);
ALTER TABLE core.email_suppressions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE core.email_suppressions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE core.email_suppressions TO service_role;

-- 4. enrichment_log
CREATE TABLE IF NOT EXISTS core.enrichment_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  b2b_lead_id UUID REFERENCES core.b2b_leads(id) ON DELETE SET NULL,
  apollo_person_id TEXT,
  credits_used INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL CHECK (result IN ('found','not_found','error')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_enrichment_log_business_time
  ON core.enrichment_log (business_id, created_at);
ALTER TABLE core.enrichment_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE core.enrichment_log FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE core.enrichment_log TO service_role;

-- 5. Gönderim kapısı v2
CREATE OR REPLACE FUNCTION core.check_and_reserve_dispatch_gate_v2(
  p_business_id UUID,
  p_b2b_lead_id UUID,
  p_campaign_type TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (reservation_id UUID, allowed BOOLEAN, reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_email TEXT;
  v_status TEXT;
  v_last TIMESTAMPTZ;
  v_id UUID;
BEGIN
  SELECT email, status INTO v_email, v_status
  FROM core.b2b_leads
  WHERE id = p_b2b_lead_id AND business_id = p_business_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, 'lead_not_found'::TEXT; RETURN;
  END IF;

  IF v_email IS NOT NULL AND EXISTS (
    SELECT 1 FROM core.email_suppressions
    WHERE business_id = p_business_id AND email = v_email
  ) THEN
    UPDATE core.b2b_leads SET status = 'unsubscribed', updated_at = now()
    WHERE id = p_b2b_lead_id AND status <> 'unsubscribed';
    RETURN QUERY SELECT NULL::UUID, FALSE, 'suppressed'::TEXT; RETURN;
  END IF;

  IF v_email IS NULL OR v_status NOT IN ('new', 'contacted') THEN
    RETURN QUERY SELECT NULL::UUID, FALSE, ('status_' || v_status)::TEXT; RETURN;
  END IF;

  SELECT MAX(reserved_at) INTO v_last
  FROM core.message_log
  WHERE business_id = p_business_id
    AND b2b_lead_id = p_b2b_lead_id
    AND status IN ('reserved', 'sent')
    AND reserved_at > now() - INTERVAL '168 hours';

  IF v_last IS NOT NULL THEN
    INSERT INTO core.message_log (business_id, b2b_lead_id, channel, campaign_type, status, payload)
    VALUES (p_business_id, p_b2b_lead_id, 'email', p_campaign_type, 'skipped_frequency_limit',
            p_payload || jsonb_build_object('reason', '168_hour_window_active', 'last_sent_at', v_last));
    RETURN QUERY SELECT NULL::UUID, FALSE, 'cooldown_active'::TEXT; RETURN;
  END IF;

  INSERT INTO core.message_log (business_id, b2b_lead_id, channel, campaign_type, status, payload)
  VALUES (p_business_id, p_b2b_lead_id, 'email', p_campaign_type, 'reserved', p_payload)
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id, TRUE, 'reserved'::TEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION core.check_and_reserve_dispatch_gate_v2(UUID, UUID, TEXT, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION core.check_and_reserve_dispatch_gate_v2(UUID, UUID, TEXT, JSONB)
  TO service_role;

COMMIT;
