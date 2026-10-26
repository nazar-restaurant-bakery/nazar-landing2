-- 2026-10-26 FORWARD CANDIDATE ONLY. Root assigns sequence later; NOT a canonical migration.
-- Requires the normal-consumer forward candidate, pg_cron, pg_net, Vault, pgcrypto.
-- Vault NAMES ONLY: COUPON_AUTOMATION_SIGNING_SECRET, COUPON_AUTOMATION_EDGE_URL.
-- No key creation, secret value, consumer-flag change, or existing settings seed here.
-- ROOT ARCHITECTURE DECISION / LIMITATION: pg_net may follow redirects; do not claim
-- no-follow for this scheduler hop. It carries ONLY a 60s HMAC signature + public
-- UUID/time body, never a static service/process/provider key. Exact own-project
-- HTTPS endpoint + consumer replay fencing remain required. Static-key HTTP hops
-- retain their no-redirect rules. Hosted enable is still a separate user decision.
-- Installs ONLY a disabled cron job; no cron target rows are seeded.
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF to_regclass('core.installation') IS NULL OR to_regclass('core.coupon_automation_settings') IS NULL
 OR to_regprocedure('public.coupon_automation_start_v1(uuid,uuid)') IS NULL
 OR to_regclass('cron.job') IS NULL OR to_regclass('vault.decrypted_secrets') IS NULL
 OR to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL
 OR to_regprocedure('extensions.hmac(bytea,bytea,text)') IS NULL THEN
  RAISE EXCEPTION 'COUPON_AUTOMATION_CRON_BASE_REQUIRED';
 END IF;
 IF EXISTS(SELECT FROM cron.job WHERE jobname='coupon-automation-normal') THEN
  RAISE EXCEPTION 'COUPON_AUTOMATION_CRON_ALREADY_PRESENT';
 END IF;
END $$;
CREATE TABLE core.coupon_automation_cron_targets (
 business_id uuid PRIMARY KEY REFERENCES core.coupon_automation_settings(business_id),
 enabled boolean NOT NULL DEFAULT false,
 last_enqueued_minute timestamptz,
 last_run_id uuid,
 last_request_id bigint,
 CHECK((last_run_id IS NULL)=(last_request_id IS NULL))
);
ALTER TABLE core.coupon_automation_cron_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE core.coupon_automation_cron_targets FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION core.coupon_automation_cron_canonical_v1(p_business_id uuid,p_run_id uuid,p_issued_at bigint)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $$
 SELECT '["coupon.automation.v1",1,"'||p_business_id::text||'","'||p_run_id::text||'",'||p_issued_at::text||']'
$$;
CREATE FUNCTION core.coupon_automation_cron_tick_v1() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE t core.coupon_automation_cron_targets; secret text; endpoint text;
 secret_count bigint; endpoint_count bigint; installation_count bigint; project_ref text; run_id uuid; issued_at bigint; signature text;
 payload jsonb; request_id bigint; queued integer:=0; minute_at timestamptz;
BEGIN
 -- Admin/cron only. No browser RPC, service JWT, staff impersonation or role mutation.
 IF session_user<>'postgres' OR coalesce(current_setting('role',true),'none') NOT IN('none','postgres') THEN
  RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
 END IF;
 minute_at:=date_trunc('minute',clock_timestamp());
 -- Default OFF exits before touching Vault, crypto or net. Missing target/settings is OFF.
 IF NOT EXISTS(SELECT FROM core.coupon_automation_cron_targets x
  JOIN core.coupon_automation_settings s USING(business_id)
  WHERE x.enabled AND s.enabled AND (x.last_enqueued_minute IS NULL OR x.last_enqueued_minute<minute_at)) THEN
  RETURN jsonb_build_object('code','cron_disabled_or_already_queued','queued',0);
 END IF;
 SELECT count(*),min(declared_project_ref) INTO installation_count,project_ref FROM core.installation;
 IF installation_count<>1 OR project_ref IS NULL OR project_ref !~ '^[a-z0-9]{20}$' THEN
  RETURN jsonb_build_object('code','cron_installation_unconfirmed','queued',0);
 END IF;
 SELECT count(*),min(decrypted_secret) INTO secret_count,secret
  FROM vault.decrypted_secrets WHERE name='COUPON_AUTOMATION_SIGNING_SECRET';
 SELECT count(*),min(decrypted_secret) INTO endpoint_count,endpoint
  FROM vault.decrypted_secrets WHERE name='COUPON_AUTOMATION_EDGE_URL';
 IF secret_count<>1 OR endpoint_count<>1 OR secret IS NULL OR secret !~ '^[A-Za-z0-9_-]{32,200}$'
 OR endpoint IS NULL OR endpoint<>('https://'||project_ref||'.supabase.co/functions/v1/coupon-welcome-run') THEN
  RETURN jsonb_build_object('code','cron_configuration_unconfirmed','queued',0);
 END IF;
 FOR t IN SELECT x.* FROM core.coupon_automation_cron_targets x
  JOIN core.coupon_automation_settings s USING(business_id)
  WHERE x.enabled AND s.enabled AND (x.last_enqueued_minute IS NULL OR x.last_enqueued_minute<minute_at)
  ORDER BY x.business_id LIMIT 8 FOR UPDATE OF x SKIP LOCKED LOOP
  -- Current identity/time, never a historical target timestamp. One fresh UUID per tick target.
  run_id:=gen_random_uuid(); issued_at:=floor(extract(epoch FROM clock_timestamp()))::bigint;
  payload:=jsonb_build_object('version',1,'businessId',t.business_id::text,'runId',run_id::text,'issuedAt',issued_at);
  signature:=encode(extensions.hmac(convert_to(core.coupon_automation_cron_canonical_v1(t.business_id,run_id,issued_at),'UTF8'),convert_to(secret,'UTF8'),'sha256'),'hex');
  -- One enqueue only. pg_net starts HTTP after COMMIT; no follow-up/retry request here.
  request_id:=net.http_post(url:=endpoint,body:=payload,params:='{}'::jsonb,
   headers:=jsonb_build_object('Content-Type','application/json','X-Coupon-Automation-Signature',signature),timeout_milliseconds:=180000);
  IF request_id IS NULL OR request_id<1 THEN RAISE EXCEPTION 'CRON_ENQUEUE_UNCONFIRMED';END IF;
  UPDATE core.coupon_automation_cron_targets SET last_enqueued_minute=minute_at,last_run_id=run_id,last_request_id=request_id WHERE business_id=t.business_id;
  queued:=queued+1;
 END LOOP;
 secret:=NULL;
 -- Consumer performs existing start/run replay+lease, next durable attempt, record+finish RPCs.
 -- Cron does NOT claim/reopen dispatches, reset K6/outbox, choose coupons, or send an event.
 RETURN jsonb_build_object('code','cron_queued','queued',queued);
EXCEPTION WHEN OTHERS THEN
 -- Transactional enqueue/target writes in this block roll back together. Never expose error text.
 secret:=NULL; RETURN jsonb_build_object('code','cron_enqueue_unconfirmed','queued',0);
END $$;
ALTER FUNCTION core.coupon_automation_cron_canonical_v1(uuid,uuid,bigint) OWNER TO postgres;
ALTER FUNCTION core.coupon_automation_cron_tick_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION core.coupon_automation_cron_canonical_v1(uuid,uuid,bigint),core.coupon_automation_cron_tick_v1() FROM PUBLIC,anon,authenticated,service_role;
-- New job only; same transaction pauses it before it becomes visible to the scheduler.
DO $$ DECLARE job_id bigint; BEGIN
 job_id:=cron.schedule('coupon-automation-normal','* * * * *','SELECT core.coupon_automation_cron_tick_v1();');
 PERFORM cron.alter_job(job_id,active:=false);
 IF EXISTS(SELECT FROM cron.job WHERE jobid=job_id AND active) THEN RAISE EXCEPTION 'CRON_DISABLE_UNCONFIRMED';END IF;
END $$;
COMMIT;
-- Future Root-approved enable requires ALL: target.enabled, existing normal settings.enabled,
-- cron.job.active, deployed Edge COUPON_AUTOMATION_ENABLED and existing Cloudflare/K6 gates.
-- Emergency pause is target.enabled=false AND only coupon-automation-normal active=false.
-- No enable/secret/user command is executed or supplied by this candidate.
