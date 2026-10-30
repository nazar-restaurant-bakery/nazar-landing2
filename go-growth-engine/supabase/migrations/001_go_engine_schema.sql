BEGIN;

CREATE TABLE IF NOT EXISTS core.b2b_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
    company_name TEXT NOT NULL,
    contact_name TEXT,
    title TEXT,
    email TEXT NOT NULL,
    phone TEXT,
    industry TEXT,
    employee_count INT,
    city TEXT DEFAULT 'West Haven',
    state TEXT DEFAULT 'CT',
    source TEXT DEFAULT 'apollo',
    status TEXT NOT NULL DEFAULT 'new' 
        CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'unsubscribed', 'bounced')),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT b2b_leads_business_email_unique UNIQUE (business_id, email)
);

ALTER TABLE core.b2b_leads ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS core.message_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id UUID NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
    customer_id UUID REFERENCES core.customers(id) ON DELETE SET NULL,
    b2b_lead_id UUID REFERENCES core.b2b_leads(id) ON DELETE SET NULL,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
    campaign_type TEXT NOT NULL CHECK (campaign_type IN ('b2b_outreach', 'b2c_campaign', 'automated_flow', 'cart_abandonment')),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'sent', 'skipped_frequency_limit', 'failed')),
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ,
    payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT message_log_target_check CHECK (customer_id IS NOT NULL OR b2b_lead_id IS NOT NULL)
);

ALTER TABLE core.message_log ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_message_log_customer_lookup 
    ON core.message_log (business_id, customer_id, reserved_at DESC) 
    WHERE customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_log_b2b_lookup 
    ON core.message_log (business_id, b2b_lead_id, reserved_at DESC) 
    WHERE b2b_lead_id IS NOT NULL;

CREATE OR REPLACE FUNCTION core.check_and_reserve_dispatch_gate_v1(
    p_business_id UUID,
    p_customer_id UUID,
    p_b2b_lead_id UUID,
    p_channel TEXT,
    p_campaign_type TEXT,
    p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_last_reserved TIMESTAMPTZ;
    v_reservation_id UUID;
    v_dummy_id UUID;
BEGIN
    IF NOT (core.staff_authorized_v1(p_business_id, 'crm.write') OR core.staff_authorized_v1(p_business_id, 'platform.read')) THEN
        RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
    END IF;

    IF p_customer_id IS NULL AND p_b2b_lead_id IS NULL THEN
        RAISE EXCEPTION 'Either p_customer_id or p_b2b_lead_id must be provided' USING ERRCODE = '22023';
    END IF;

    IF p_customer_id IS NOT NULL THEN
        SELECT id INTO v_dummy_id 
        FROM core.customers 
        WHERE id = p_customer_id AND business_id = p_business_id 
        FOR UPDATE;
    ELSIF p_b2b_lead_id IS NOT NULL THEN
        SELECT id INTO v_dummy_id 
        FROM core.b2b_leads 
        WHERE id = p_b2b_lead_id AND business_id = p_business_id 
        FOR UPDATE;
    END IF;

    SELECT reserved_at INTO v_last_reserved
    FROM core.message_log
    WHERE business_id = p_business_id
      AND (
          (p_customer_id IS NOT NULL AND customer_id = p_customer_id) OR
          (p_b2b_lead_id IS NOT NULL AND b2b_lead_id = p_b2b_lead_id)
      )
      AND status IN ('reserved', 'sent')
      AND reserved_at > (now() - INTERVAL '168 hours')
    ORDER BY reserved_at DESC
    LIMIT 1;

    IF v_last_reserved IS NOT NULL THEN
        INSERT INTO core.message_log (
            business_id, customer_id, b2b_lead_id, channel, campaign_type, status, payload
        ) VALUES (
            p_business_id, p_customer_id, p_b2b_lead_id, p_channel, p_campaign_type, 'skipped_frequency_limit',
            p_payload || jsonb_build_object('reason', '168_hour_window_active', 'last_sent_at', v_last_reserved)
        );
        RETURN NULL;
    END IF;

    INSERT INTO core.message_log (
        business_id, customer_id, b2b_lead_id, channel, campaign_type, status, payload
    ) VALUES (
        p_business_id, p_customer_id, p_b2b_lead_id, p_channel, p_campaign_type, 'reserved', p_payload
    )
    RETURNING id INTO v_reservation_id;

    RETURN v_reservation_id;
END;
$$;

REVOKE ALL ON FUNCTION core.check_and_reserve_dispatch_gate_v1 FROM PUBLIC, anon, authenticated;

COMMIT;