-- Faz 1 / Gorev 17: daily Clover pull activation support. LF bytes, psql 18.6.
-- Uses the existing K12 design unchanged: pg_cron -> core.daily_scheduler_tick()
-- -> signed pg_net POST to Edge daily-ops-run -> signed POST to Cloudflare
-- /api/internal/daily-clover-pull -> clover_order_ingest_v1. This migration
-- 1. adds Nazar's scheduler settings row DISABLED (no cron job, no secret);
-- 2. allows one 'manual_today' run per New York day (target = today);
-- 3. adds core.daily_scheduler_run_today_v1, callable only by the database owner
--    (SQL Editor), which dispatches today's run through the same signed path.
-- Existing functions, the daily_collect schedule and existing rows are unchanged.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('daily_clover_activation_v1',0));

DO $guard$ BEGIN
  IF pg_catalog.to_regclass('core.daily_scheduler_settings') IS NULL
    OR pg_catalog.to_regclass('core.daily_scheduler_runs') IS NULL
    OR pg_catalog.to_regprocedure('core.daily_scheduler_tick(timestamptz)') IS NULL
    OR pg_catalog.to_regprocedure('public.daily_scheduler_start(uuid,uuid,uuid)') IS NULL
    OR pg_catalog.to_regprocedure('public.clover_order_ingest_v1(uuid,text,jsonb)') IS NULL
  THEN RAISE EXCEPTION 'DAILY_CLOVER_PREREQUISITE_REQUIRED'; END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
  THEN RAISE EXCEPTION 'DAILY_CLOVER_CORE_MUST_BE_PRIVATE'; END IF;
  IF pg_catalog.to_regprocedure('core.daily_scheduler_run_today_v1(uuid)') IS NOT NULL
  THEN RAISE EXCEPTION 'DAILY_CLOVER_ALREADY_INSTALLED'; END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_constraint WHERE conrelid='core.daily_scheduler_runs'::regclass
      AND contype='c' AND pg_catalog.pg_get_constraintdef(oid) IN
        ($c$CHECK ((job_type = 'daily_collect'::text))$c$,$c$CHECK ((target_date = (local_date - 1)))$c$))<>2
  THEN RAISE EXCEPTION 'DAILY_CLOVER_UNEXPECTED_RUN_CONSTRAINTS'; END IF;
END $guard$;

DO $constraints$
DECLARE v_name text;
BEGIN
  FOR v_name IN SELECT conname FROM pg_catalog.pg_constraint WHERE conrelid='core.daily_scheduler_runs'::regclass
    AND contype='c' AND pg_catalog.pg_get_constraintdef(oid) IN
      ($c$CHECK ((job_type = 'daily_collect'::text))$c$,$c$CHECK ((target_date = (local_date - 1)))$c$) LOOP
    EXECUTE pg_catalog.format('ALTER TABLE core.daily_scheduler_runs DROP CONSTRAINT %I',v_name);
  END LOOP;
END $constraints$;
ALTER TABLE core.daily_scheduler_runs
  ADD CONSTRAINT daily_scheduler_runs_job_type_check CHECK (job_type IN ('daily_collect','manual_today')),
  ADD CONSTRAINT daily_scheduler_runs_target_check CHECK (
    (job_type='daily_collect' AND target_date=local_date-1) OR
    (job_type='manual_today' AND target_date=local_date));

-- Nazar production only; another project (sandbox) gets no row. Disabled: the
-- tick and every machine RPC require enabled=true. An existing row is kept as is.
INSERT INTO core.daily_scheduler_settings(business_id,enabled,clover_url)
SELECT b.id,false,'https://www.nazarrestaurantandbakery.com/api/internal/daily-clover-pull'
FROM core.businesses b WHERE b.id='a358eba4-b197-4309-805b-46f43a718454'
ON CONFLICT (business_id) DO NOTHING;

-- Same signing, endpoint and timeouts as core.daily_scheduler_tick. Today's
-- window is 00:00 New York today -> 00:00 tomorrow. One run per day; a failed
-- or missed one may be dispatched again. Returns identifiers only, no secret.
CREATE FUNCTION core.daily_scheduler_run_today_v1(p_business_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_now timestamptz:=clock_timestamp(); v_day date:=(clock_timestamp() AT TIME ZONE 'America/New_York')::date;
  r core.daily_scheduler_runs; v_secret text; v_endpoint text; v_issued bigint; v_signature text;
BEGIN
  PERFORM 1 FROM core.daily_scheduler_settings WHERE business_id=p_business_id AND enabled FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SCHEDULER_TENANT_NOT_ENABLED'; END IF;
  SELECT decrypted_secret INTO STRICT v_secret FROM vault.decrypted_secrets WHERE name='SCHEDULER_SIGNING_SECRET';
  SELECT decrypted_secret INTO STRICT v_endpoint FROM vault.decrypted_secrets WHERE name='SCHEDULER_EDGE_URL';
  IF pg_catalog.length(v_secret)<32 THEN RAISE EXCEPTION 'SCHEDULER_SECRET_TOO_SHORT'; END IF;
  IF v_endpoint !~ '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/daily-ops-run$' THEN
    RAISE EXCEPTION 'SCHEDULER_EDGE_URL_INVALID'; END IF;
  INSERT INTO core.daily_scheduler_runs(business_id,local_date,job_type,target_date,status,safe_code,created_at)
  VALUES(p_business_id,v_day,'manual_today',v_day,'queued','queued',v_now)
  ON CONFLICT(business_id,local_date,job_type) DO UPDATE SET status='queued',safe_code='queued',
    clover_status='pending',ops_status='pending',nonce=gen_random_uuid(),claim_token=NULL,request_id=NULL,
    created_at=v_now,started_at=NULL,finished_at=NULL
    WHERE core.daily_scheduler_runs.status IN ('failed','missed')
  RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'MANUAL_RUN_ALREADY_ACTIVE_OR_DONE_TODAY'; END IF;
  v_issued:=floor(extract(epoch FROM v_now));
  v_signature:=encode(extensions.hmac('daily.dispatch.v1'||E'\n'||r.business_id||E'\n'||r.id||E'\n'||r.nonce||E'\n'||v_issued,
    v_secret,'sha256'),'hex');
  UPDATE core.daily_scheduler_runs SET request_id=net.http_post(url:=v_endpoint,
    headers:=jsonb_build_object('Content-Type','application/json','X-Scheduler-Signature',v_signature),
    body:=jsonb_build_object('business_id',r.business_id,'run_id',r.id,'nonce',r.nonce,'issued_at',v_issued),
    timeout_milliseconds:=10000)
  WHERE business_id=r.business_id AND id=r.id RETURNING * INTO r;
  RETURN jsonb_build_object('run_id',r.id,'local_date',r.local_date,'target_date',r.target_date,
    'job_type',r.job_type,'request_id',r.request_id,
    'window_start',(r.target_date::timestamp AT TIME ZONE 'America/New_York'),
    'window_end',((r.target_date+1)::timestamp AT TIME ZONE 'America/New_York'));
END $$;
REVOKE ALL ON FUNCTION core.daily_scheduler_run_today_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
