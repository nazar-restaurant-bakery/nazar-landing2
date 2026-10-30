-- G4: GO Growth Engine tablolari platform veritabanina (tek musteri kaydi).
-- Kaynak: go-growth-engine/supabase/migrations 001-005 (son hal).
-- core.business_settings (komisyon motoru) DEGISMEZ; GO ayarlari core.outreach_settings'e.
-- core.message_log: yalniz b2b_lead_id eklenir, customer_id "musteri ya da aday" kuralina gevsetilir.
-- Mevcut Nazar kayitlari, K6 islevleri ve 168 saat kurali degismez.
-- Veri tasinmaz (G5). core semasi service_role'e kapali kalir (platform duzeni).
-- Geri alma: supabase/rollbacks/20261029000100_go_outreach_tables_down.sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('go_outreach_tables_v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('core.businesses') IS NULL
    OR pg_catalog.to_regclass('core.customers') IS NULL
    OR pg_catalog.to_regclass('core.message_log') IS NULL
    OR pg_catalog.to_regprocedure('core.message_log_immutable_v1()') IS NULL
    OR pg_catalog.to_regprocedure('public.message_send_reserve_v1(uuid,uuid,text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'G4_PLATFORM_K6_REQUIRED';
  END IF;
  IF pg_catalog.to_regclass('core.b2b_leads') IS NOT NULL
    OR pg_catalog.to_regclass('core.outreach_settings') IS NOT NULL
    OR pg_catalog.to_regclass('core.email_suppressions') IS NOT NULL
    OR pg_catalog.to_regclass('core.enrichment_log') IS NOT NULL
    OR pg_catalog.to_regclass('core.api_keys') IS NOT NULL
    OR pg_catalog.to_regclass('core.api_key_businesses') IS NOT NULL
    OR EXISTS(SELECT 1 FROM information_schema.columns
      WHERE table_schema='core' AND table_name='message_log' AND column_name='b2b_lead_id') THEN
    RAISE EXCEPTION 'G4_ALREADY_APPLIED';
  END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE') THEN
    RAISE EXCEPTION 'G4_PRIVATE_CORE_REQUIRED';
  END IF;
END $preflight$;

-- 1. Sirket ve kisi adaylari (GO 001+002+004)
CREATE TABLE core.b2b_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  company_name text NOT NULL,
  contact_name text,
  title text,
  email text CHECK (email IS NULL OR email = lower(email)),
  phone text,
  industry text,
  employee_count integer,
  city text DEFAULT 'West Haven',
  state text DEFAULT 'CT',
  source text DEFAULT 'apollo',
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('enrichment_pending','enrichment_failed','new',
    'contacted','qualified','converted','unsubscribed','bounced','on_hold')),
  apollo_person_id text,
  sequence_step integer NOT NULL DEFAULT 0,
  next_step_at timestamptz,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT b2b_leads_business_email_unique UNIQUE (business_id, email),
  CONSTRAINT b2b_leads_business_apollo_person_unique UNIQUE (business_id, apollo_person_id)
);
CREATE INDEX b2b_leads_due ON core.b2b_leads (business_id, status, next_step_at);

-- 2. GO ayarlari (GO business_settings 002+003+005; komisyon tablosundan ayri)
CREATE TABLE core.outreach_settings (
  business_id uuid PRIMARY KEY REFERENCES core.businesses(id) ON DELETE RESTRICT,
  sender_name text NOT NULL,
  sender_email text NOT NULL,
  reply_to text NOT NULL,
  physical_address text NOT NULL,
  link_base_url text NOT NULL CHECK (link_base_url LIKE 'https://%'),
  timezone text NOT NULL,
  send_days smallint[] NOT NULL CHECK (cardinality(send_days) > 0 AND send_days <@ '{1,2,3,4,5,6,7}'::smallint[]),
  send_start time NOT NULL,
  send_end time NOT NULL,
  daily_send_limit integer NOT NULL DEFAULT 10 CHECK (daily_send_limit BETWEEN 1 AND 500),
  enrichment_daily_credit_limit integer NOT NULL,
  enrichment_monthly_credit_limit integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (send_start < send_end)
);

-- 3. Engel listesi (GO 002) — kayit silinmez, degistirilmez (Platform Tanimi 9)
CREATE TABLE core.email_suppressions (
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (email = lower(email)),
  suppressed_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  source text,
  PRIMARY KEY (business_id, email)
);
CREATE FUNCTION core.email_suppressions_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  RAISE EXCEPTION 'G4_SUPPRESSION_IMMUTABLE' USING ERRCODE='42501';
END $$;
CREATE TRIGGER email_suppressions_no_change BEFORE UPDATE OR DELETE ON core.email_suppressions
FOR EACH ROW EXECUTE FUNCTION core.email_suppressions_immutable_v1();
CREATE TRIGGER email_suppressions_no_truncate BEFORE TRUNCATE ON core.email_suppressions
FOR EACH STATEMENT EXECUTE FUNCTION core.email_suppressions_immutable_v1();
ALTER TABLE core.email_suppressions ENABLE ALWAYS TRIGGER email_suppressions_no_change;
ALTER TABLE core.email_suppressions ENABLE ALWAYS TRIGGER email_suppressions_no_truncate;

-- 4. Zenginlestirme kaydi (GO 002)
CREATE TABLE core.enrichment_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  b2b_lead_id uuid REFERENCES core.b2b_leads(id) ON DELETE SET NULL,
  apollo_person_id text,
  credits_used integer NOT NULL DEFAULT 0,
  result text NOT NULL CHECK (result IN ('found','not_found','error')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX enrichment_log_business_time ON core.enrichment_log (business_id, created_at);

-- 5. API anahtarlari (GO 003; yalniz ozet saklanir, isletmeye baglanti tablosuyla ayrilir)
CREATE TABLE core.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE TABLE core.api_key_businesses (
  api_key_id uuid NOT NULL REFERENCES core.api_keys(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES core.businesses(id) ON DELETE RESTRICT,
  PRIMARY KEY (api_key_id, business_id)
);

-- 6. Gonderim kaydi: musteri ya da aday (tam olarak biri)
ALTER TABLE core.message_log ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE core.message_log ADD COLUMN b2b_lead_id uuid REFERENCES core.b2b_leads(id);
ALTER TABLE core.message_log ADD CONSTRAINT message_log_target_one
  CHECK (num_nonnulls(customer_id, b2b_lead_id) = 1);
CREATE INDEX message_log_b2b_quota ON core.message_log (business_id, b2b_lead_id, status, sent_at)
  WHERE b2b_lead_id IS NOT NULL;
-- Mevcut K6 degismezlik tetigine dokunulmaz; aday baglantisi ayri tetikle sabitlenir.
CREATE FUNCTION core.message_log_b2b_lead_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF NEW.b2b_lead_id IS DISTINCT FROM OLD.b2b_lead_id THEN
    RAISE EXCEPTION 'G4_MESSAGE_LOG_TARGET_IMMUTABLE' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_log_b2b_lead_immutable BEFORE UPDATE ON core.message_log
FOR EACH ROW EXECUTE FUNCTION core.message_log_b2b_lead_immutable_v1();
ALTER TABLE core.message_log ENABLE ALWAYS TRIGGER message_log_b2b_lead_immutable;

-- 7. Erisim: RLS acik, dogrudan erisim kapali (platform duzeni)
ALTER TABLE core.b2b_leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.outreach_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.email_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.enrichment_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.api_key_businesses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE core.b2b_leads, core.outreach_settings, core.email_suppressions,
  core.enrichment_log, core.api_keys, core.api_key_businesses
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION core.email_suppressions_immutable_v1(), core.message_log_b2b_lead_immutable_v1()
  FROM PUBLIC, anon, authenticated, service_role;

-- 8. Son kontrol
DO $post$
BEGIN
  IF EXISTS(SELECT 1 FROM core.message_log WHERE customer_id IS NULL OR b2b_lead_id IS NOT NULL) THEN
    RAISE EXCEPTION 'G4_EXISTING_MESSAGE_LOG_CHANGED';
  END IF;
  IF pg_catalog.has_schema_privilege('service_role','core','USAGE') THEN
    RAISE EXCEPTION 'G4_PRIVATE_CORE_REQUIRED';
  END IF;
END $post$;
COMMIT;
