-- K5: durable profile-only synchronization. No marketing send, subscription API,
-- positive-consent transition, provider unblock, schedule or fixed business ID.
-- Apply these exact LF bytes with the same reviewed tool in test then production.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('klaviyo_profile_sync_v1',0));

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('core.customers') IS NULL
     OR pg_catalog.to_regclass('core.signups') IS NULL
     OR pg_catalog.to_regclass('core.crm_staff') IS NULL
     OR pg_catalog.to_regclass('core.klaviyo_email_observations') IS NULL
     OR pg_catalog.to_regprocedure('public.record_klaviyo_status_v1(uuid,text,text,timestamp with time zone,timestamp with time zone)') IS NULL
     OR pg_catalog.to_regprocedure('core.guard_email_suppression_v1()') IS NULL THEN
    RAISE EXCEPTION 'K5_REVIEWED_BASELINE_AND_K4_REQUIRED';
  END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
     OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
     OR pg_catalog.has_schema_privilege('service_role','core','USAGE') THEN
    RAISE EXCEPTION 'K5_PRIVATE_CORE_MUST_ALREADY_BE_CLOSED';
  END IF;
END
$preflight$;

CREATE TABLE core.klaviyo_profile_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  customer_id uuid NOT NULL REFERENCES core.customers(id),
  provider_account text NOT NULL CHECK (provider_account ~ '^[A-Za-z0-9_-]{1,100}$'),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','retry','succeeded','failed','blocked')),
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  email_fingerprint text NOT NULL CHECK (email_fingerprint ~ '^[0-9a-f]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 6),
  lease_id uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code text CHECK (last_error_code IN (
    'provider_timeout','provider_network','provider_rate_limited','provider_auth',
    'provider_rejected','provider_unavailable','unknown_write','configuration_missing',
    'payload_changed','customer_ineligible','lease_expired','attempts_exhausted',
    'provider_unsubscribed','provider_suppressed')),
  last_success_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT klaviyo_profile_sync_one_job UNIQUE (business_id,customer_id,provider_account),
  CONSTRAINT klaviyo_profile_sync_lease CHECK (
    (status='running' AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status<>'running' AND lease_id IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX klaviyo_profile_sync_due ON core.klaviyo_profile_sync_jobs
  (business_id,provider_account,next_attempt_at) WHERE status IN ('queued','retry','running');
ALTER TABLE core.klaviyo_profile_sync_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE core.klaviyo_profile_sync_jobs FROM PUBLIC,anon,authenticated,service_role;

-- No speculative tags or name splitting. Latest stored signup is the source.
-- Only known UTM string keys are exported; arbitrary form meta is never exported.
CREATE FUNCTION core.klaviyo_profile_sync_payload_v1(p_business_id uuid,p_customer_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' SET timezone='UTC'
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'email',pg_catalog.lower(pg_catalog.btrim(c.email)),
    'name',c.name,'source',s.source,'createdAt',c.created_at,
    'utm',CASE WHEN pg_catalog.jsonb_typeof(s.utm)='object' THEN
      COALESCE((SELECT pg_catalog.jsonb_object_agg(e.key,e.value)
      FROM pg_catalog.jsonb_each(CASE WHEN pg_catalog.jsonb_typeof(s.utm)='object'
        THEN s.utm ELSE '{}'::jsonb END) AS e(key,value)
      WHERE e.key IN ('utm_source','utm_medium','utm_campaign','utm_term','utm_content')
        AND pg_catalog.jsonb_typeof(e.value)='string'),'{}'::jsonb)
      ELSE NULL END,
    'tags',NULL)
  FROM core.customers c
  LEFT JOIN LATERAL (SELECT x.source,x.utm FROM core.signups x
    WHERE x.customer_id=c.id AND x.business_id=c.business_id
    ORDER BY x.created_at DESC,x.id DESC LIMIT 1) s ON true
  WHERE c.id=p_customer_id AND c.business_id=p_business_id
$$;

CREATE FUNCTION core.klaviyo_profile_sync_eligible_v1(p_business_id uuid,p_customer_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT EXISTS (SELECT 1 FROM core.customers c
    WHERE c.id=p_customer_id AND c.business_id=p_business_id
      AND c.email_status='subscribed' AND c.email_suppressed_at IS NULL
      AND NULLIF(pg_catalog.btrim(c.email),'') IS NOT NULL
      AND pg_catalog.length(c.email)<=254
      AND c.email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
      AND NOT COALESCE((pg_catalog.to_jsonb(c)->>'is_test')::boolean,false)
      AND c.email !~* '(@example[.]com$|[.]invalid$|[+]viptest)'
      AND COALESCE(c.name,'') !~* '(INTERNAL TEST|CRM Test|VERIFY)'
      AND NOT EXISTS (SELECT 1 FROM core.signups s
        WHERE s.customer_id=c.id AND s.business_id=c.business_id AND s.is_test)
      AND NOT EXISTS (SELECT 1 FROM core.klaviyo_email_observations o
        WHERE o.customer_id=c.id AND (o.blocked_at IS NOT NULL
          OR o.status IN ('unsubscribed','suppressed'))))
$$;

CREATE FUNCTION public.klaviyo_profile_sync_enqueue_v1(
  p_business_id uuid,p_account text,p_limit integer DEFAULT 100,p_customer_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE c record; j core.klaviyo_profile_sync_jobs%ROWTYPE; v_payload jsonb;
  v_fp text; v_email_fp text; v_enqueued integer:=0; v_unchanged integer:=0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF p_business_id IS NULL OR NOT EXISTS(SELECT 1 FROM core.businesses WHERE id=p_business_id)
     OR p_account IS NULL OR p_account !~ '^[A-Za-z0-9_-]{1,100}$'
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500
     OR (p_customer_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM core.customers
       WHERE id=p_customer_id AND business_id=p_business_id)) THEN
    RAISE EXCEPTION 'Invalid sync configuration' USING ERRCODE='22023';
  END IF;
  -- Concurrent manual collection runs cannot race the one-job upsert.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_business_id::text||':'||p_account,5));
  FOR c IN SELECT x.id FROM core.customers x
    LEFT JOIN core.klaviyo_profile_sync_jobs q ON q.business_id=x.business_id
      AND q.customer_id=x.id AND q.provider_account=p_account
    WHERE x.business_id=p_business_id
    AND (p_customer_id IS NULL OR x.id=p_customer_id)
    AND core.klaviyo_profile_sync_eligible_v1(p_business_id,x.id)
    -- Unchanged successes must not starve new/changed customers when limit is small.
    ORDER BY CASE WHEN q.id IS NULL OR q.status='blocked' OR q.payload_fingerprint <>
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        core.klaviyo_profile_sync_payload_v1(p_business_id,x.id)::text,'UTF8')),'hex')
      THEN 0 ELSE 1 END,x.updated_at DESC,x.id LIMIT p_limit
  LOOP
    v_payload:=core.klaviyo_profile_sync_payload_v1(p_business_id,c.id);
    v_fp:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload::text,'UTF8')),'hex');
    v_email_fp:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload->>'email','UTF8')),'hex');
    SELECT * INTO j FROM core.klaviyo_profile_sync_jobs
      WHERE business_id=p_business_id AND customer_id=c.id AND provider_account=p_account FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO core.klaviyo_profile_sync_jobs(business_id,customer_id,provider_account,payload_fingerprint,email_fingerprint)
        VALUES(p_business_id,c.id,p_account,v_fp,v_email_fp);
      v_enqueued:=v_enqueued+1;
    ELSIF (j.payload_fingerprint<>v_fp OR j.status='blocked')
       AND NOT(j.status='running' AND j.lease_expires_at>clock_timestamp()) THEN
      UPDATE core.klaviyo_profile_sync_jobs SET status='queued',payload_fingerprint=v_fp,
        email_fingerprint=v_email_fp,attempts=0,lease_id=NULL,lease_expires_at=NULL,
        next_attempt_at=clock_timestamp(),last_error_code=NULL,updated_at=clock_timestamp() WHERE id=j.id;
      v_enqueued:=v_enqueued+1;
    ELSE v_unchanged:=v_unchanged+1;
    END IF;
  END LOOP;
  RETURN pg_catalog.jsonb_build_object('enqueued',v_enqueued,'unchanged',v_unchanged);
END
$$;

CREATE FUNCTION public.klaviyo_profile_sync_claim_v1(
  p_business_id uuid,p_account text,p_customer_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE j core.klaviyo_profile_sync_jobs%ROWTYPE; v_payload jsonb; v_fp text;
  v_lease uuid; v_expiry timestamptz; v_attempt integer; v_skipped integer:=0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF p_business_id IS NULL OR p_account IS NULL OR p_account !~ '^[A-Za-z0-9_-]{1,100}$'
     OR NOT EXISTS(SELECT 1 FROM core.businesses WHERE id=p_business_id)
     OR (p_customer_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM core.customers
       WHERE id=p_customer_id AND business_id=p_business_id)) THEN
    RAISE EXCEPTION 'Invalid sync configuration' USING ERRCODE='22023';
  END IF;
  LOOP
    SELECT * INTO j FROM core.klaviyo_profile_sync_jobs
      WHERE business_id=p_business_id AND provider_account=p_account
        AND (p_customer_id IS NULL OR customer_id=p_customer_id)
        AND ((status IN ('queued','retry') AND next_attempt_at<=clock_timestamp())
          OR (status='running' AND lease_expires_at<=clock_timestamp()))
      ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
    PERFORM 1 FROM core.customers WHERE id=j.customer_id AND business_id=j.business_id FOR UPDATE;
    IF NOT core.klaviyo_profile_sync_eligible_v1(j.business_id,j.customer_id) THEN
      UPDATE core.klaviyo_profile_sync_jobs SET status='blocked',lease_id=NULL,lease_expires_at=NULL,
        last_error_code='customer_ineligible',updated_at=clock_timestamp() WHERE id=j.id;
    ELSE
      v_payload:=core.klaviyo_profile_sync_payload_v1(j.business_id,j.customer_id);
      v_fp:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload::text,'UTF8')),'hex');
      v_attempt:=CASE WHEN j.payload_fingerprint<>v_fp THEN 1 ELSE j.attempts+1 END;
      IF v_attempt>6 THEN
        UPDATE core.klaviyo_profile_sync_jobs SET status='failed',lease_id=NULL,lease_expires_at=NULL,
          last_error_code='attempts_exhausted',updated_at=clock_timestamp() WHERE id=j.id;
      ELSE
        v_lease:=gen_random_uuid(); v_expiry:=clock_timestamp()+interval '120 seconds';
        UPDATE core.klaviyo_profile_sync_jobs SET status='running',attempts=v_attempt,
          payload_fingerprint=v_fp,email_fingerprint=pg_catalog.encode(pg_catalog.sha256(
            pg_catalog.convert_to(v_payload->>'email','UTF8')),'hex'),
          lease_id=v_lease,lease_expires_at=v_expiry,updated_at=clock_timestamp() WHERE id=j.id;
        RETURN pg_catalog.jsonb_build_object('jobId',j.id,'leaseId',v_lease,
          'attempt',v_attempt,'leaseExpiresAt',v_expiry);
      END IF;
    END IF;
    v_skipped:=v_skipped+1;
    IF v_skipped>=100 THEN RETURN NULL; END IF;
  END LOOP;
END
$$;

CREATE FUNCTION public.klaviyo_profile_sync_context_v1(p_job_id uuid,p_lease_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE j core.klaviyo_profile_sync_jobs%ROWTYPE; v_payload jsonb; v_fp text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  SELECT * INTO j FROM core.klaviyo_profile_sync_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.status<>'running' OR p_lease_id IS NULL
    OR j.lease_id IS DISTINCT FROM p_lease_id OR j.lease_expires_at<=clock_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object('eligible',false,'reason','lease_expired',
      'status',COALESCE(j.status,'missing'));
  END IF;
  PERFORM 1 FROM core.customers WHERE id=j.customer_id AND business_id=j.business_id FOR UPDATE;
  IF NOT core.klaviyo_profile_sync_eligible_v1(j.business_id,j.customer_id) THEN
    UPDATE core.klaviyo_profile_sync_jobs SET status='blocked',lease_id=NULL,lease_expires_at=NULL,
      last_error_code='customer_ineligible',updated_at=clock_timestamp() WHERE id=j.id;
    RETURN pg_catalog.jsonb_build_object('eligible',false,'reason','customer_ineligible','status','blocked');
  END IF;
  v_payload:=core.klaviyo_profile_sync_payload_v1(j.business_id,j.customer_id);
  v_fp:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload::text,'UTF8')),'hex');
  IF v_fp<>j.payload_fingerprint THEN
    UPDATE core.klaviyo_profile_sync_jobs SET status='queued',payload_fingerprint=v_fp,
      email_fingerprint=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload->>'email','UTF8')),'hex'),
      attempts=0,lease_id=NULL,lease_expires_at=NULL,next_attempt_at=clock_timestamp(),
      last_error_code='payload_changed',updated_at=clock_timestamp() WHERE id=j.id;
    RETURN pg_catalog.jsonb_build_object('eligible',false,'reason','payload_changed','status','queued');
  END IF;
  RETURN pg_catalog.jsonb_build_object('eligible',true,'jobId',j.id,'businessId',j.business_id,
    'customerId',j.customer_id,'eligibility',(
      SELECT pg_catalog.jsonb_build_object('emailStatus',c.email_status,
        'isTest',COALESCE((pg_catalog.to_jsonb(c)->>'is_test')::boolean,false)
          OR EXISTS(SELECT 1 FROM core.signups s WHERE s.customer_id=c.id AND s.is_test),
        'suppressedAt',c.email_suppressed_at)
      FROM core.customers c WHERE c.id=j.customer_id AND c.business_id=j.business_id),
    'account',j.provider_account,'fingerprint',j.payload_fingerprint,
    'idempotencyKey','k5:'||j.id::text||':'||j.payload_fingerprint,'profile',v_payload);
END
$$;

CREATE FUNCTION public.klaviyo_profile_sync_finish_v1(p_job_id uuid,p_lease_id uuid,p_outcome jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE j core.klaviyo_profile_sync_jobs%ROWTYPE; v_status text; v_error text;
  v_provider_status text; v_provider_updated timestamptz; v_delay integer;
  v_payload jsonb; v_fp text; v_email_fp text; v_customer core.customers%ROWTYPE;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF p_outcome IS NULL OR pg_catalog.jsonb_typeof(p_outcome)<>'object'
    OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(p_outcome) k
      WHERE k NOT IN ('status','errorCode','retryAfterSeconds','providerStatus','providerUpdatedAt')) THEN
    RAISE EXCEPTION 'Invalid sync outcome' USING ERRCODE='22023';
  END IF;
  v_status:=p_outcome->>'status'; v_error:=p_outcome->>'errorCode';
  v_provider_status:=p_outcome->>'providerStatus';
  IF v_status IS NULL OR v_status NOT IN ('succeeded','retry','failed','provider_blocked')
    OR (v_error IS NOT NULL AND v_error NOT IN (
      'provider_timeout','provider_network','provider_rate_limited','provider_auth',
      'provider_rejected','provider_unavailable','unknown_write','configuration_missing',
      'payload_changed','customer_ineligible','lease_expired','attempts_exhausted',
      'provider_unsubscribed','provider_suppressed'))
    OR (v_status IN ('retry','failed') AND v_error IS NULL)
    OR (v_status='succeeded' AND (v_error IS NOT NULL OR v_provider_status IS NOT NULL
       OR p_outcome ? 'providerUpdatedAt' OR p_outcome ? 'retryAfterSeconds'))
    OR (v_status<>'provider_blocked' AND (p_outcome ? 'providerStatus' OR p_outcome ? 'providerUpdatedAt'))
    OR (v_status='provider_blocked' AND (v_provider_status IS NULL
       OR v_provider_status NOT IN ('unsubscribed','suppressed'))) THEN
    RAISE EXCEPTION 'Invalid sync outcome' USING ERRCODE='22023';
  END IF;
  IF p_outcome ? 'retryAfterSeconds' THEN
    IF v_status<>'retry' OR pg_catalog.jsonb_typeof(p_outcome->'retryAfterSeconds')<>'number'
      OR (p_outcome->>'retryAfterSeconds') !~ '^[0-9]{1,5}$'
      OR (p_outcome->>'retryAfterSeconds')::integer>86400 THEN
      RAISE EXCEPTION 'Invalid retry delay' USING ERRCODE='22023';
    END IF;
  END IF;
  IF p_outcome ? 'providerUpdatedAt' AND p_outcome->>'providerUpdatedAt' IS NOT NULL THEN
    BEGIN
      v_provider_updated:=(p_outcome->>'providerUpdatedAt')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid provider timestamp' USING ERRCODE='22023';
    END;
    IF NOT pg_catalog.isfinite(v_provider_updated)
       OR v_provider_updated>clock_timestamp()+interval '1 minute' THEN
      RAISE EXCEPTION 'Invalid provider timestamp' USING ERRCODE='22023';
    END IF;
  END IF;
  SELECT * INTO j FROM core.klaviyo_profile_sync_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.status<>'running' OR p_lease_id IS NULL
    OR j.lease_id IS DISTINCT FROM p_lease_id OR j.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'Sync lease is stale' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_customer FROM core.customers
    WHERE id=j.customer_id AND business_id=j.business_id FOR UPDATE;
  v_payload:=core.klaviyo_profile_sync_payload_v1(j.business_id,j.customer_id);
  v_fp:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload::text,'UTF8')),'hex');
  v_email_fp:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload->>'email','UTF8')),'hex');
  IF v_status='provider_blocked' AND v_email_fp=j.email_fingerprint THEN
    -- Only negative provider evidence uses the existing sanctioned readback RPC.
    -- It preserves K4 suppression and immutable evidence; no positive status is written.
    PERFORM public.record_klaviyo_status_v1(j.customer_id,v_payload->>'email',
      v_provider_status,clock_timestamp(),v_provider_updated);
    v_status:='blocked'; v_error:='provider_'||v_provider_status;
  ELSIF NOT core.klaviyo_profile_sync_eligible_v1(j.business_id,j.customer_id) THEN
    v_status:='blocked'; v_error:='customer_ineligible';
  ELSIF v_fp IS DISTINCT FROM j.payload_fingerprint THEN
    -- Do not mark an old successful write as synchronization of a new payload.
    UPDATE core.klaviyo_profile_sync_jobs SET status='queued',payload_fingerprint=v_fp,
      email_fingerprint=v_email_fp,attempts=0,lease_id=NULL,lease_expires_at=NULL,
      next_attempt_at=clock_timestamp(),last_error_code='payload_changed',updated_at=clock_timestamp(),
      last_success_at=CASE WHEN v_status='succeeded' THEN clock_timestamp() ELSE last_success_at END
      WHERE id=j.id;
    RETURN pg_catalog.jsonb_build_object('status','queued','attempts',0,
      'nextAttemptAt',clock_timestamp(),'lastErrorCode','payload_changed');
  ELSIF v_status='provider_blocked' THEN
    -- The email identity changed: never apply an old address's block to a new one.
    v_status:='failed'; v_error:='payload_changed';
  ELSIF v_status='retry' AND j.attempts>=6 THEN
    v_status:='failed';
  END IF;
  v_delay:=GREATEST(5*(2^(GREATEST(j.attempts-1,0)))::integer,
    COALESCE((p_outcome->>'retryAfterSeconds')::integer,0));
  UPDATE core.klaviyo_profile_sync_jobs SET status=v_status,lease_id=NULL,lease_expires_at=NULL,
    next_attempt_at=CASE WHEN v_status='retry' THEN clock_timestamp()+pg_catalog.make_interval(secs=>v_delay)
      ELSE next_attempt_at END,last_error_code=v_error,updated_at=clock_timestamp(),
    last_success_at=CASE WHEN v_status='succeeded' THEN clock_timestamp() ELSE last_success_at END
    WHERE id=j.id RETURNING * INTO j;
  RETURN pg_catalog.jsonb_build_object('status',j.status,'attempts',j.attempts,
    'nextAttemptAt',j.next_attempt_at,'lastErrorCode',j.last_error_code);
END
$$;

CREATE FUNCTION public.crm_profile_sync_queue_v1(p_business_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE v_items jsonb; v_counts jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
    OR NOT EXISTS(SELECT 1 FROM core.crm_staff WHERE auth_user_id=auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF p_business_id IS NULL OR NOT EXISTS(SELECT 1 FROM core.businesses WHERE id=p_business_id) THEN
    RAISE EXCEPTION 'Invalid business' USING ERRCODE='22023';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(x)),'[]'::jsonb) INTO v_items FROM (
    SELECT id AS "jobId",customer_id AS "customerId",provider_account AS account,status,
      attempts,6 AS "maxAttempts",next_attempt_at AS "nextAttemptAt",
      lease_expires_at AS "leaseExpiresAt",updated_at AS "updatedAt",
      last_success_at AS "lastSuccessAt",last_error_code AS "lastErrorCode"
    FROM core.klaviyo_profile_sync_jobs WHERE business_id=p_business_id
    ORDER BY updated_at DESC,id LIMIT 100
  ) x;
  SELECT pg_catalog.jsonb_build_object('total',count(*),
    'queued',count(*) FILTER(WHERE status='queued'),'running',count(*) FILTER(WHERE status='running'),
    'retry',count(*) FILTER(WHERE status='retry'),'succeeded',count(*) FILTER(WHERE status='succeeded'),
    'failed',count(*) FILTER(WHERE status='failed'),'blocked',count(*) FILTER(WHERE status='blocked'))
    INTO v_counts FROM core.klaviyo_profile_sync_jobs WHERE business_id=p_business_id;
  RETURN pg_catalog.jsonb_build_object('items',v_items,'counts',v_counts);
END
$$;

REVOKE ALL ON FUNCTION core.klaviyo_profile_sync_payload_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION core.klaviyo_profile_sync_eligible_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.klaviyo_profile_sync_enqueue_v1(uuid,text,integer,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.klaviyo_profile_sync_claim_v1(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.klaviyo_profile_sync_context_v1(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.klaviyo_profile_sync_finish_v1(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.crm_profile_sync_queue_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.klaviyo_profile_sync_enqueue_v1(uuid,text,integer,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.klaviyo_profile_sync_claim_v1(uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.klaviyo_profile_sync_context_v1(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.klaviyo_profile_sync_finish_v1(uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.crm_profile_sync_queue_v1(uuid) TO authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
