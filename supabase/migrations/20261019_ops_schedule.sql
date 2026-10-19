-- OPTIONAL / PR ONLY. Talip reviews prerequisites and applies separately.
-- Prepares pg_cron + pg_net; never deploys Edge code, writes Vault secrets,
-- changes global timezone, dispatches HTTP, or activates the job on installation.
-- Fixed 10:00 UTC means 06:00 EDT / 05:00 EST in New York (DST is intentional).
-- Required Vault names: nazar_ops_schedule_secret (64 hex) and
-- nazar_ops_gateway_anon_jwt (legacy anon JWT for this project; NOT service_role).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.installation WHERE declared_project_ref='khgczybubufouraqyrcj')
 OR to_regclass('core.ops_actions') IS NULL OR to_regprocedure('public.ops_finish_action(uuid,uuid,text,jsonb,jsonb,jsonb)') IS NULL THEN
  RAISE EXCEPTION 'STOP: Nazar ops base migration is required'; END IF;
 IF to_regclass('cron.job') IS NULL OR to_regclass('vault.decrypted_secrets') IS NULL
 OR to_regclass('net.http_request_queue') IS NULL
 OR to_regprocedure('cron.schedule(text,text,text)') IS NULL
 OR to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') IS NULL
 OR to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL THEN
  RAISE EXCEPTION 'STOP: Talip must verify pg_cron, pg_net and Vault prerequisites'; END IF;
 -- Protect the name check from another transaction replacing/inserting a job
 -- before cron.schedule runs. No existing job is retargeted by preparation.
 LOCK TABLE cron.job IN SHARE ROW EXCLUSIVE MODE;
 IF coalesce(current_setting('cron.timezone',true),'') NOT IN('UTC','GMT','Etc/UTC','Etc/GMT') THEN
  RAISE EXCEPTION 'STOP: cron.timezone must already be UTC/GMT; no global change is made'; END IF;
 IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='nazar-ops-collect') THEN
  RAISE EXCEPTION 'STOP: existing nazar-ops-collect job must be reviewed; it will not be overwritten'; END IF;
 IF has_table_privilege('anon','net.http_request_queue','SELECT') OR has_table_privilege('authenticated','net.http_request_queue','SELECT') THEN
  RAISE EXCEPTION 'STOP: pg_net request queue must not expose private request headers'; END IF;
END $guard$;

ALTER TABLE core.ops_actions ADD COLUMN actor_kind text NOT NULL DEFAULT 'staff'
 CHECK(actor_kind IN('staff','scheduler'));
ALTER TABLE core.ops_actions ALTER COLUMN requested_by DROP NOT NULL;
ALTER TABLE core.ops_actions ADD CONSTRAINT ops_action_actor_valid CHECK(
 (actor_kind='staff' AND requested_by IS NOT NULL) OR
 (actor_kind='scheduler' AND requested_by IS NULL AND action='collect'));
-- A manual retry also executes collectors. Serialize both types with the
-- scheduled/manual collect path rather than running two provider reads at once.
CREATE UNIQUE INDEX ops_one_collection_inflight ON core.ops_actions(business_id)
 WHERE action IN('collect','retry_failed_job') AND status IN('queued','running');
CREATE FUNCTION core.ops_actor_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $fn$
BEGIN
 IF NEW.actor_kind IS DISTINCT FROM OLD.actor_kind OR NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
  RAISE EXCEPTION 'Ops action actor is immutable'; END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER ops_action_actor_immutable BEFORE UPDATE ON core.ops_actions
 FOR EACH ROW EXECUTE FUNCTION core.ops_actor_immutable();
REVOKE ALL ON FUNCTION core.ops_actor_immutable() FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION core.ops_safe_action(p_row core.ops_actions) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $fn$
 SELECT jsonb_build_object('id',p_row.id,'request_key',p_row.request_key,'action',p_row.action,
 'requested_by',p_row.requested_by,'actor_kind',p_row.actor_kind,'requested_at',p_row.requested_at,
 'status',p_row.status,'result',p_row.result,'finished_at',p_row.finished_at);
$fn$;

-- Preserve existing manual behavior; nullable scheduler actors require a
-- null-safe actor check on recovery of an existing client request key.
CREATE OR REPLACE FUNCTION public.ops_request_action(p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE row core.ops_actions; target uuid; allowed text[]; v_request_key uuid; fingerprint text; not_ready boolean:=false;
BEGIN
 PERFORM core.ops_assert_staff();
 IF p_action NOT IN('collect','sync_clover_csv','retry_failed_job','offer_set_active','ads_set_status','product_set_channel','commission_report') OR p_action IS NULL
 OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>1100000 THEN RAISE EXCEPTION 'Invalid ops action' USING ERRCODE='22023'; END IF;
 allowed:=CASE p_action WHEN 'collect' THEN ARRAY[]::text[] WHEN 'sync_clover_csv' THEN ARRAY['csv','fileName','periodStart','periodEnd']
 WHEN 'retry_failed_job' THEN ARRAY['actionId'] WHEN 'offer_set_active' THEN ARRAY['offerId','active','approvalReference']
 WHEN 'ads_set_status' THEN ARRAY['source','campaignId','status'] WHEN 'product_set_channel' THEN ARRAY['productId','channel','available'] ELSE ARRAY['month'] END;
 allowed:=array_append(allowed,'clientRequestId');
 IF coalesce(p_payload->>'clientRequestId','') !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'Invalid client request key' USING ERRCODE='22023'; END IF;
 v_request_key:=(p_payload->>'clientRequestId')::uuid; fingerprint:=md5(p_action||p_payload::text);
 SELECT * INTO row FROM core.ops_actions a WHERE a.business_id='a358eba4-b197-4309-805b-46f43a718454' AND a.request_key=v_request_key;
 IF FOUND THEN
  IF row.actor_kind<>'staff' OR row.requested_by IS DISTINCT FROM auth.uid() OR row.request_fingerprint IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'Conflicting request key' USING ERRCODE='22023'; END IF;
  RETURN core.ops_safe_action(row);
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload)k WHERE NOT k=ANY(allowed)) THEN RAISE EXCEPTION 'Unsupported action fields' USING ERRCODE='22023'; END IF;
 not_ready:=p_action IN('ads_set_status','product_set_channel') OR
 (p_action IN('offer_set_active','retry_failed_job','commission_report') AND NOT(core.ops_capabilities('supabase') ? p_action));
 IF not_ready THEN
  INSERT INTO core.ops_actions(business_id,action,requested_by,payload,request_key,request_fingerprint,status,result,finished_at)
  VALUES('a358eba4-b197-4309-805b-46f43a718454',p_action,auth.uid(),'{}',v_request_key,fingerprint,'not_connected',jsonb_build_object('code','capability_not_connected','message','Bağlantı veya doğrulanmış yetki bekleniyor; işlem uygulanmadı.'),now()) RETURNING * INTO row;
  RETURN core.ops_safe_action(row);
 END IF;
 IF p_action='sync_clover_csv' AND (coalesce(jsonb_typeof(p_payload->'csv'),'')<>'string' OR octet_length(p_payload->>'csv') NOT BETWEEN 1 AND 1048576
 OR coalesce(length(p_payload->>'fileName'),0) NOT BETWEEN 1 AND 120 OR coalesce(p_payload->>'periodStart','') !~ '^\d{4}-\d{2}-\d{2}$' OR coalesce(p_payload->>'periodEnd','') !~ '^\d{4}-\d{2}-\d{2}$') THEN RAISE EXCEPTION 'Invalid CSV input' USING ERRCODE='22023'; END IF;
 IF p_action='offer_set_active' AND (coalesce(p_payload->>'offerId','') !~* '^[a-f0-9-]{36}$' OR coalesce(jsonb_typeof(p_payload->'active'),'')<>'boolean' OR length(coalesce(p_payload->>'approvalReference',''))>300) THEN RAISE EXCEPTION 'Invalid offer input' USING ERRCODE='22023'; END IF;
 IF p_action='ads_set_status' AND (coalesce(p_payload->>'source','') NOT IN('google_ads','meta') OR coalesce(p_payload->>'campaignId','') !~ '^[0-9]{1,30}$' OR coalesce(p_payload->>'status','') NOT IN('ENABLED','PAUSED')) THEN RAISE EXCEPTION 'Invalid ad input' USING ERRCODE='22023'; END IF;
 IF p_action='product_set_channel' AND (coalesce(p_payload->>'productId','') !~ '^[A-Za-z0-9_-]{1,80}$' OR coalesce(p_payload->>'channel','') NOT IN('pickup','delivery','dine-in','catering') OR coalesce(jsonb_typeof(p_payload->'available'),'')<>'boolean') THEN RAISE EXCEPTION 'Invalid product input' USING ERRCODE='22023'; END IF;
 IF p_action='commission_report' AND coalesce(p_payload->>'month','') !~ '^\d{4}-(0[1-9]|1[0-2])$' THEN RAISE EXCEPTION 'Invalid month' USING ERRCODE='22023'; END IF;
 IF p_action='retry_failed_job' THEN
  IF coalesce(p_payload->>'actionId','') !~* '^[a-f0-9-]{36}$' THEN RAISE EXCEPTION 'Invalid retry' USING ERRCODE='22023'; END IF;
  target:=(p_payload->>'actionId')::uuid;
  PERFORM 1 FROM core.ops_actions WHERE id=target AND business_id='a358eba4-b197-4309-805b-46f43a718454' AND action='collect' AND status='failed' AND requested_at>=now()-interval '24 hours' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Only a known failed manual collection can be retried once' USING ERRCODE='22023'; END IF;
 END IF;
 INSERT INTO core.ops_actions(business_id,action,requested_by,payload,retry_of,request_key,request_fingerprint) VALUES('a358eba4-b197-4309-805b-46f43a718454',p_action,auth.uid(),p_payload-'clientRequestId',target,v_request_key,fingerprint) RETURNING * INTO row;
 RETURN core.ops_safe_action(row);
END $fn$;

CREATE TABLE core.ops_schedule_settings (
 business_id uuid PRIMARY KEY CHECK(business_id='a358eba4-b197-4309-805b-46f43a718454'),
 enabled boolean NOT NULL DEFAULT false, job_id bigint NOT NULL UNIQUE,
 job_owner text NOT NULL, edge_reference text CHECK(length(edge_reference) BETWEEN 8 AND 300),
 credentials_fingerprint text CHECK(credentials_fingerprint ~ '^[a-f0-9]{32}$'),
 reviewed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(NOT enabled OR (edge_reference IS NOT NULL AND credentials_fingerprint IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE TABLE core.ops_schedule_dispatches (
 run_key uuid PRIMARY KEY, day_ny date NOT NULL UNIQUE,
 request_id bigint NOT NULL UNIQUE, queued_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE core.ops_scheduled_runs (
 action_id uuid PRIMARY KEY REFERENCES core.ops_actions(id), run_key uuid NOT NULL UNIQUE,
 credentials_fingerprint text NOT NULL CHECK(credentials_fingerprint ~ '^[a-f0-9]{32}$'),
 enqueued_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE core.ops_scheduled_snapshots (
 action_id uuid PRIMARY KEY REFERENCES core.ops_scheduled_runs(action_id),
 metric_count integer NOT NULL CHECK(metric_count>0), snapshot_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now()
);
DO $rls$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['ops_schedule_settings','ops_schedule_dispatches','ops_scheduled_runs','ops_scheduled_snapshots'] LOOP
  EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('REVOKE ALL ON core.%I FROM PUBLIC,anon,authenticated,service_role',item);
 END LOOP;
END $rls$;

CREATE FUNCTION core.ops_schedule_run_key(p_day date) RETURNS uuid LANGUAGE sql IMMUTABLE STRICT SET search_path='' AS $fn$
 SELECT md5('nazar-ops-collect:'||to_char(p_day,'YYYY-MM-DD'))::uuid;
$fn$;
-- Private return value contains credentials. Never expose this function or its
-- result through RPC/logging. SQL verifies role/project/expiry; the gateway still
-- verifies the JWT signature with verify_jwt=true on the Edge Function.
CREATE FUNCTION core.ops_schedule_credentials() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE secret text; gateway text; claims jsonb; encoded text;
BEGIN
 IF (SELECT count(*) FROM vault.decrypted_secrets WHERE name='nazar_ops_schedule_secret')<>1
 OR (SELECT count(*) FROM vault.decrypted_secrets WHERE name='nazar_ops_gateway_anon_jwt')<>1 THEN RETURN NULL; END IF;
 SELECT decrypted_secret INTO secret FROM vault.decrypted_secrets WHERE name='nazar_ops_schedule_secret';
 SELECT decrypted_secret INTO gateway FROM vault.decrypted_secrets WHERE name='nazar_ops_gateway_anon_jwt';
 IF secret IS NULL OR secret !~ '^[a-fA-F0-9]{64}$' OR gateway IS NULL
 OR gateway !~ '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN RETURN NULL; END IF;
 encoded:=translate(split_part(gateway,'.',2),'-_','+/');
 encoded:=encoded||repeat('=',(4-length(encoded)%4)%4);
 claims:=convert_from(decode(encoded,'base64'),'UTF8')::jsonb;
 IF claims->>'role' IS DISTINCT FROM 'anon' OR claims->>'ref' IS DISTINCT FROM 'khgczybubufouraqyrcj'
 OR jsonb_typeof(claims->'exp') IS DISTINCT FROM 'number'
 OR (claims->>'exp')::numeric<=extract(epoch FROM clock_timestamp()) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('gateway',gateway,'secret',secret,'fingerprint',md5(secret||':'||gateway));
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END $fn$;
CREATE FUNCTION core.ops_schedule_job_valid(p_active boolean) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $fn$
 SELECT coalesce(current_setting('cron.timezone',true),'') IN('UTC','GMT','Etc/UTC','Etc/GMT')
 AND EXISTS(SELECT 1 FROM core.ops_schedule_settings s JOIN cron.job j ON j.jobid=s.job_id
 WHERE s.business_id='a358eba4-b197-4309-805b-46f43a718454'
 AND j.jobname='nazar-ops-collect' AND j.schedule='0 10 * * *'
 AND j.command='SELECT core.ops_dispatch_scheduled_collect();'
 AND j.database=current_database() AND j.username=s.job_owner AND j.active=p_active);
$fn$;

-- Owner-only readiness/activation, never called by this migration or the UI.
-- p_edge_reference is a reviewed deployment/reference, not a password. Talip
-- must first deploy the matching collect-only Edge route and compare secrets.
CREATE FUNCTION core.ops_set_schedule_enabled(p_enabled boolean,p_edge_reference text DEFAULT NULL) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE config core.ops_schedule_settings; credentials jsonb;
BEGIN
 SELECT * INTO STRICT config FROM core.ops_schedule_settings WHERE business_id='a358eba4-b197-4309-805b-46f43a718454' FOR UPDATE;
 IF p_enabled IS NULL THEN RAISE EXCEPTION 'Explicit enabled choice required'; END IF;
 IF NOT p_enabled THEN
  PERFORM cron.alter_job(config.job_id,active:=false);
  UPDATE core.ops_schedule_settings SET enabled=false,updated_at=now() WHERE business_id=config.business_id;
  UPDATE core.ops_connections SET status='not_connected',last_error=NULL,capabilities='[]',
   note='Scheduler devre dışı; Şimdi topla bağımsız olarak kullanılabilir.'
   WHERE business_id=config.business_id AND source='scheduler';
  RETURN;
 END IF;
 credentials:=core.ops_schedule_credentials();
 IF credentials IS NULL OR (NOT core.ops_schedule_job_valid(false) AND NOT core.ops_schedule_job_valid(true))
 OR has_table_privilege('anon','net.http_request_queue','SELECT') OR has_table_privilege('authenticated','net.http_request_queue','SELECT')
 OR p_edge_reference IS NULL OR length(btrim(p_edge_reference)) NOT BETWEEN 8 AND 300 THEN
  RAISE EXCEPTION 'Schedule readiness not verified: review Edge deployment, Vault, cron and queue privacy'; END IF;
 UPDATE core.ops_schedule_settings SET enabled=true,edge_reference=btrim(p_edge_reference),
 credentials_fingerprint=credentials->>'fingerprint',reviewed_at=now(),updated_at=now() WHERE business_id=config.business_id;
 PERFORM cron.alter_job(config.job_id,active:=true);
 UPDATE core.ops_connections SET status='not_connected',last_error=NULL,capabilities='[]',
  note='Scheduler etkinleştirmesi hazır; bu etkinleştirmeden sonraki tamamlanmış snapshot kanıtı bekleniyor.'
  WHERE business_id=config.business_id AND source='scheduler';
END $fn$;

CREATE FUNCTION core.ops_dispatch_scheduled_collect() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE config core.ops_schedule_settings; credentials jsonb; day_ny date:=(now() AT TIME ZONE 'America/New_York')::date;
 v_run_key uuid; v_request_id bigint;
BEGIN
 SELECT * INTO config FROM core.ops_schedule_settings WHERE business_id='a358eba4-b197-4309-805b-46f43a718454' FOR UPDATE;
 IF NOT FOUND OR NOT config.enabled OR NOT core.ops_schedule_job_valid(true) THEN RETURN NULL; END IF;
 credentials:=core.ops_schedule_credentials();
 IF credentials IS NULL OR config.credentials_fingerprint IS DISTINCT FROM credentials->>'fingerprint'
 OR has_table_privilege('anon','net.http_request_queue','SELECT') OR has_table_privilege('authenticated','net.http_request_queue','SELECT') THEN RETURN NULL; END IF;
 v_run_key:=core.ops_schedule_run_key(day_ny);
 IF EXISTS(SELECT 1 FROM core.ops_schedule_dispatches d WHERE d.run_key=v_run_key)
 OR EXISTS(SELECT 1 FROM core.ops_actions a WHERE a.business_id=config.business_id AND
 (a.request_key=v_run_key OR (a.action IN('collect','retry_failed_job') AND a.status IN('queued','running')))) THEN RETURN NULL; END IF;
 -- pg_net starts HTTP only after COMMIT. A request_id is QUEUED transport,
 -- never proof of a successful collector or stored business snapshot.
 SELECT net.http_post(
  url:='https://khgczybubufouraqyrcj.supabase.co/functions/v1/ops-collect',
  body:=jsonb_build_object('scheduledCollect',true,'runKey',v_run_key),
  params:='{}'::jsonb,
  headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(credentials->>'gateway'),
   'apikey',credentials->>'gateway','x-nazar-ops-schedule-secret',credentials->>'secret'),
  timeout_milliseconds:=5000) INTO v_request_id;
 INSERT INTO core.ops_schedule_dispatches(run_key,day_ny,request_id) VALUES(v_run_key,day_ny,v_request_id);
 RETURN v_request_id;
END $fn$;

-- Service-only; called only after the Edge route checks its dedicated secret.
-- The user JWT path never uses this RPC. This actor is a scheduler, not a staff
-- account. The one-active-collect index is shared with manual collections.
CREATE FUNCTION public.ops_enqueue_scheduled_collect(p_run_key uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE config core.ops_schedule_settings; credentials jsonb; row core.ops_actions;
 expected uuid:=core.ops_schedule_run_key((now() AT TIME ZONE 'America/New_York')::date);
BEGIN
 SELECT * INTO config FROM core.ops_schedule_settings WHERE business_id='a358eba4-b197-4309-805b-46f43a718454' FOR UPDATE;
 IF NOT FOUND OR NOT config.enabled OR NOT core.ops_schedule_job_valid(true) THEN RETURN NULL; END IF;
 credentials:=core.ops_schedule_credentials();
 IF credentials IS NULL OR config.credentials_fingerprint IS DISTINCT FROM credentials->>'fingerprint' THEN RETURN NULL; END IF;
 IF p_run_key IS NULL OR p_run_key<>expected THEN RAISE EXCEPTION 'Invalid scheduled daily key' USING ERRCODE='22023'; END IF;
 -- pg_net starts after COMMIT, so its private dispatch receipt exists before
 -- the real Edge request arrives. Possession of the Edge secret alone cannot
 -- preempt a future cron slot or mint a scheduler actor without that receipt.
 IF NOT EXISTS(SELECT 1 FROM core.ops_schedule_dispatches d WHERE d.run_key=p_run_key
  AND d.day_ny=(now() AT TIME ZONE 'America/New_York')::date
  AND d.queued_at>=now()-interval '10 minutes' AND d.queued_at<=clock_timestamp()+interval '1 minute') THEN RETURN NULL; END IF;
 INSERT INTO core.ops_actions(business_id,request_key,request_fingerprint,action,requested_by,actor_kind,status,claim_token,payload)
 VALUES(config.business_id,p_run_key,md5('scheduled:collect:'||p_run_key::text),'collect',NULL,'scheduler','running',gen_random_uuid(),'{}')
 ON CONFLICT DO NOTHING RETURNING * INTO row;
 IF NOT FOUND THEN RETURN NULL; END IF;
 INSERT INTO core.ops_scheduled_runs(action_id,run_key,credentials_fingerprint) VALUES(row.id,p_run_key,config.credentials_fingerprint);
 RETURN jsonb_build_object('id',row.id,'request_key',row.request_key,'action',row.action,'payload',row.payload,
 'claim_token',row.claim_token,'requested_by',NULL,'actor_kind','scheduler','requested_at',row.requested_at);
END $fn$;

-- Preserve the installed manual finish implementation and public signature.
-- Only the owner wrapper can call the moved base; service_role cannot bypass
-- the atomic scheduled-snapshot receipt. No prior migration file is changed.
ALTER FUNCTION public.ops_finish_action(uuid,uuid,text,jsonb,jsonb,jsonb) RENAME TO ops_finish_action_base;
ALTER FUNCTION public.ops_finish_action_base(uuid,uuid,text,jsonb,jsonb,jsonb) SET SCHEMA core;
REVOKE ALL ON FUNCTION core.ops_finish_action_base(uuid,uuid,text,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.ops_finish_action(p_action_id uuid,p_claim_token uuid,p_status text,p_result jsonb,p_metrics jsonb DEFAULT '[]',p_connections jsonb DEFAULT '[]')
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE finished boolean; row core.ops_actions; metric_count integer; snapshot_at timestamptz;
BEGIN
 finished:=core.ops_finish_action_base(p_action_id,p_claim_token,p_status,p_result,p_metrics,p_connections);
 IF NOT finished THEN RETURN false; END IF;
 SELECT * INTO row FROM core.ops_actions WHERE id=p_action_id AND actor_kind='scheduler' AND action='collect' AND status='done';
 IF FOUND THEN
  SELECT count(*)::integer,max(m.collected_at) INTO metric_count,snapshot_at
  FROM core.ops_metrics m WHERE m.business_id=row.business_id AND NOT m.is_test AND m.collector='edge_fn'
  AND m.source IN('supabase','site','clover','klaviyo','reviews','ga4','google_ads','meta')
  AND m.collected_at>=row.requested_at-interval '1 minute' AND m.collected_at<=clock_timestamp()+interval '5 minutes'
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_metrics)item
   WHERE item->>'source'=m.source AND item->>'metric'=m.metric
   AND coalesce((item->>'collected_at')::timestamptz,row.finished_at)=m.collected_at
   AND (item->>'period_start')::date IS NOT DISTINCT FROM m.period_start
   AND (item->>'period_end')::date IS NOT DISTINCT FROM m.period_end
   AND (item->>'value_num')::numeric IS NOT DISTINCT FROM m.value_num
   AND left(item->>'value_text',300) IS NOT DISTINCT FROM m.value_text);
  IF metric_count>0 THEN
   INSERT INTO core.ops_scheduled_snapshots(action_id,metric_count,snapshot_at) VALUES(row.id,metric_count,snapshot_at);
  END IF;
 END IF;
 RETURN true;
END $fn$;

CREATE FUNCTION public.ops_schedule_status_v() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE config core.ops_schedule_settings; credentials jsonb; active boolean:=false; verified boolean:=false;
 runs integer; failures integer; failure_name text; failure_at timestamptz;
BEGIN
 SELECT * INTO config FROM core.ops_schedule_settings WHERE business_id='a358eba4-b197-4309-805b-46f43a718454';
 IF FOUND THEN
  active:=core.ops_schedule_job_valid(true); credentials:=core.ops_schedule_credentials();
  verified:=config.enabled AND active AND credentials IS NOT NULL
   AND config.credentials_fingerprint=credentials->>'fingerprint'
   AND NOT has_table_privilege('anon','net.http_request_queue','SELECT')
   AND NOT has_table_privilege('authenticated','net.http_request_queue','SELECT')
   AND EXISTS(SELECT 1 FROM core.ops_actions a JOIN core.ops_scheduled_runs r ON r.action_id=a.id
    JOIN core.ops_scheduled_snapshots s ON s.action_id=a.id
    WHERE a.business_id=config.business_id AND a.actor_kind='scheduler' AND a.action='collect' AND a.status='done'
    AND a.finished_at>=now()-interval '36 hours' AND s.snapshot_at>=now()-interval '36 hours'
    AND r.enqueued_at>=config.reviewed_at AND s.recorded_at>=config.reviewed_at
    AND s.snapshot_at<=clock_timestamp()+interval '5 minutes' AND r.credentials_fingerprint=config.credentials_fingerprint);
 END IF;
 SELECT count(*)::integer,count(*) FILTER(WHERE status IN('failed','not_connected'))::integer INTO runs,failures
 FROM core.ops_actions WHERE business_id='a358eba4-b197-4309-805b-46f43a718454' AND actor_kind='scheduler'
 AND requested_at>=now()-interval '24 hours';
 SELECT action,finished_at INTO failure_name,failure_at FROM core.ops_actions
 WHERE business_id='a358eba4-b197-4309-805b-46f43a718454' AND actor_kind='scheduler' AND status IN('failed','not_connected')
 ORDER BY finished_at DESC NULLS LAST LIMIT 1;
 RETURN jsonb_build_object('enabled',coalesce(config.enabled,false),'active',active,'verified',coalesce(verified,false),
 'runs_24h',runs,'failed_24h',failures,'last_failure_name',failure_name,'last_failure_at',failure_at,
 -- Service-only comparison: Edge must match its configured secret before it
 -- reports connected. Never forward this digest to metrics, UI or logs.
 'secret_sha256',CASE WHEN credentials IS NOT NULL THEN encode(sha256(convert_to(credentials->>'secret','UTF8')),'hex') END);
END $fn$;

REVOKE ALL ON FUNCTION core.ops_schedule_run_key(date),core.ops_schedule_credentials(),core.ops_schedule_job_valid(boolean),
 core.ops_set_schedule_enabled(boolean,text),core.ops_dispatch_scheduled_collect() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.ops_enqueue_scheduled_collect(uuid),public.ops_schedule_status_v(),
 public.ops_finish_action(uuid,uuid,text,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ops_enqueue_scheduled_collect(uuid),public.ops_schedule_status_v(),
 public.ops_finish_action(uuid,uuid,text,jsonb,jsonb,jsonb) TO service_role;

DO $prepare$ DECLARE job_id bigint; BEGIN
 -- Duplicate name was rejected above. Registration and deactivation commit
 -- together, and dispatch is never called during preparation.
 SELECT cron.schedule('nazar-ops-collect','0 10 * * *','SELECT core.ops_dispatch_scheduled_collect();') INTO job_id;
 PERFORM cron.alter_job(job_id,active:=false);
 INSERT INTO core.ops_schedule_settings(business_id,job_id,job_owner)
 VALUES('a358eba4-b197-4309-805b-46f43a718454',job_id,current_user);
END $prepare$;
COMMIT;
