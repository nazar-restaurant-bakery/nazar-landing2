-- K8: private Clover app webhook inbox and durable pull attempts. LF, psql 18.6.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('clover_webhook_v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('core.orders') IS NULL
    OR pg_catalog.to_regprocedure('public.clover_order_ingest_v1(uuid,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'K8_K7_REQUIRED';
  END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE') THEN
    RAISE EXCEPTION 'K8_CORE_MUST_BE_PRIVATE';
  END IF;
END $preflight$;

-- One active merchant belongs to one business. Secret names are runtime settings,
-- never secret values. Clover app auth code is shared at app level.
CREATE TABLE core.clover_merchant_bindings (
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  merchant_id text PRIMARY KEY CHECK (merchant_id ~ '^[A-Za-z0-9]{8,32}$'),
  environment text NOT NULL CHECK (environment IN ('sandbox','production')),
  token_secret_name text NOT NULL CHECK (token_secret_name ~ '^CLOVER_[A-Z0-9_]{4,80}$'),
  online_order_type_ids text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id,merchant_id)
);

CREATE TABLE core.clover_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  clover_event_id text NOT NULL CHECK (pg_catalog.length(clover_event_id)=64),
  merchant_id text NOT NULL REFERENCES core.clover_merchant_bindings(merchant_id),
  event_type text NOT NULL CHECK (event_type IN ('order','payment')),
  event_action text NOT NULL CHECK (event_action IN ('CREATE','UPDATE','DELETE')),
  object_id text NOT NULL CHECK (object_id ~ '^[A-Za-z0-9]{8,32}$'),
  raw_event jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(raw_event)='object'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','processed','failed')),
  error_step text,
  error_code text,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 10),
  UNIQUE (business_id,clover_event_id)
);
CREATE INDEX clover_webhook_events_retry ON core.clover_webhook_events(business_id,received_at)
  WHERE status='failed';

CREATE TABLE core.clover_pull_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  source text NOT NULL CHECK (source IN ('manual','webhook','scheduled')),
  for_day date NOT NULL,
  step text NOT NULL CHECK (step ~ '^[a-z_]{2,40}$'),
  error_code text CHECK (error_code ~ '^[a-z_]{2,60}$'),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  fetched_count integer NOT NULL DEFAULT 0 CHECK (fetched_count>=0),
  upserted_count integer NOT NULL DEFAULT 0 CHECK (upserted_count>=0),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (finished_at>=started_at)
);
CREATE INDEX clover_pull_attempts_recent ON core.clover_pull_attempts(business_id,started_at DESC);

-- Developer Dashboard sends an unsigned one-time verification challenge before
-- it starts sending X-Clover-Auth. Keep only the latest code, privately.
CREATE TABLE core.clover_webhook_verification (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  verification_code text NOT NULL CHECK (verification_code ~ '^[A-Za-z0-9-]{20,80}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE core.clover_merchant_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.clover_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.clover_pull_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.clover_webhook_verification ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.clover_merchant_bindings,core.clover_webhook_events,core.clover_pull_attempts
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON core.clover_webhook_verification FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.clover_webhook_verification_v1(p_code text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF p_code !~ '^[A-Za-z0-9-]{20,80}$' THEN RETURN false; END IF;
  INSERT INTO core.clover_webhook_verification(singleton,verification_code)
    VALUES(true,p_code) ON CONFLICT(singleton) DO UPDATE SET
    verification_code=EXCLUDED.verification_code,received_at=clock_timestamp();
  RETURN true;
END $$;

CREATE FUNCTION public.clover_webhook_claim_v1(p_merchant_id text,p_event_id text,
  p_event_type text,p_event_action text,p_object_id text,p_raw_event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_binding core.clover_merchant_bindings%ROWTYPE; v_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF p_merchant_id !~ '^[A-Za-z0-9]{8,32}$' OR p_event_id !~ '^[a-f0-9]{64}$'
    OR p_event_type NOT IN ('order','payment') OR p_event_action NOT IN ('CREATE','UPDATE','DELETE')
    OR p_object_id !~ '^[A-Za-z0-9]{8,32}$' OR pg_catalog.jsonb_typeof(p_raw_event)<>'object' THEN
    RAISE EXCEPTION 'Invalid webhook event' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_binding FROM core.clover_merchant_bindings
    WHERE merchant_id=p_merchant_id AND active=true;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO core.clover_webhook_events(business_id,clover_event_id,merchant_id,
    event_type,event_action,object_id,raw_event)
  VALUES(v_binding.business_id,p_event_id,p_merchant_id,p_event_type,p_event_action,p_object_id,p_raw_event)
  ON CONFLICT (business_id,clover_event_id) DO UPDATE
    SET status='processing',received_at=clock_timestamp(),processed_at=NULL,
      error_step=NULL,error_code=NULL,
      attempts=core.clover_webhook_events.attempts+1
    WHERE (core.clover_webhook_events.status='failed'
      OR (core.clover_webhook_events.status='processing'
        AND core.clover_webhook_events.received_at<clock_timestamp()-interval '5 minutes'))
      AND core.clover_webhook_events.attempts<10
  RETURNING id INTO v_id;
  RETURN pg_catalog.jsonb_build_object('claimed',v_id IS NOT NULL,'eventId',v_id,
    'businessId',v_binding.business_id,'environment',v_binding.environment,
    'tokenSecretName',v_binding.token_secret_name,'onlineOrderTypeIds',v_binding.online_order_type_ids);
END $$;

CREATE FUNCTION public.clover_webhook_finish_v1(p_business_id uuid,p_event_id uuid,
  p_status text,p_step text,p_error_code text,p_http_status integer,p_started_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF p_status NOT IN ('processed','failed') OR p_step !~ '^[a-z_]{2,40}$'
    OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z_]{2,60}$')
    OR p_started_at IS NULL THEN RAISE EXCEPTION 'Invalid webhook result' USING ERRCODE='22023'; END IF;
  UPDATE core.clover_webhook_events SET status=p_status,processed_at=clock_timestamp(),
    error_step=CASE WHEN p_status='failed' THEN p_step END,
    error_code=CASE WHEN p_status='failed' THEN p_error_code END
    WHERE id=p_event_id AND business_id=p_business_id AND status='processing';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RETURN false; END IF;
  INSERT INTO core.clover_pull_attempts(business_id,source,for_day,step,error_code,http_status,
    fetched_count,upserted_count,started_at)
  VALUES(p_business_id,'webhook',(p_started_at AT TIME ZONE 'America/New_York')::date,
    p_step,p_error_code,p_http_status,CASE WHEN p_status='processed' THEN 1 ELSE 0 END,
    CASE WHEN p_status='processed' THEN 1 ELSE 0 END,p_started_at);
  RETURN true;
END $$;

CREATE FUNCTION public.clover_pull_attempt_record_v1(p_business_id uuid,p_source text,
  p_step text,p_error_code text,p_http_status integer,p_fetched_count integer,
  p_upserted_count integer,p_started_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM core.businesses WHERE id=p_business_id)
    OR p_source NOT IN ('manual','scheduled') OR p_step !~ '^[a-z_]{2,40}$'
    OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z_]{2,60}$')
    OR p_fetched_count<0 OR p_upserted_count<0 OR p_started_at IS NULL THEN
    RAISE EXCEPTION 'Invalid pull attempt' USING ERRCODE='22023';
  END IF;
  INSERT INTO core.clover_pull_attempts(business_id,source,for_day,step,error_code,http_status,
    fetched_count,upserted_count,started_at)
  VALUES(p_business_id,p_source,(p_started_at AT TIME ZONE 'America/New_York')::date,
    p_step,p_error_code,p_http_status,p_fetched_count,p_upserted_count,p_started_at);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.clover_webhook_claim_v1(text,text,text,text,text,jsonb),
  public.clover_webhook_finish_v1(uuid,uuid,text,text,text,integer,timestamptz),
  public.clover_pull_attempt_record_v1(uuid,text,text,text,integer,integer,integer,timestamptz),
  public.clover_webhook_verification_v1(text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.clover_webhook_claim_v1(text,text,text,text,text,jsonb),
  public.clover_webhook_finish_v1(uuid,uuid,text,text,text,integer,timestamptz),
  public.clover_pull_attempt_record_v1(uuid,text,text,text,integer,integer,integer,timestamptz),
  public.clover_webhook_verification_v1(text)
  TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
