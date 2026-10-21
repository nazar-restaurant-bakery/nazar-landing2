-- Draft K12 daily scheduler. No cron job, extension, key or tenant is enabled here.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF to_regprocedure('core.staff_authorized_v1(uuid,text)') IS NULL THEN RAISE EXCEPTION 'SHARED_STAFF_CONTRACT_REQUIRED'; END IF;
END; $$;
CREATE TABLE core.daily_scheduler_settings (
 business_id uuid PRIMARY KEY REFERENCES core.businesses(id),
 enabled boolean NOT NULL DEFAULT false,
 clover_url text NOT NULL CHECK(clover_url ~ '^https://[A-Za-z0-9.-]+/api/internal/daily-clover-pull$')
);
CREATE TABLE core.daily_scheduler_runs (
 business_id uuid NOT NULL REFERENCES core.businesses(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(), local_date date NOT NULL,
 job_type text NOT NULL DEFAULT 'daily_collect' CHECK(job_type='daily_collect'),
 target_date date NOT NULL,
 status text NOT NULL CHECK(status IN('queued','running','succeeded','partial','failed','missed')),
 clover_status text NOT NULL DEFAULT 'pending' CHECK(clover_status IN('pending','running','succeeded','partial','failed')),
 ops_status text NOT NULL DEFAULT 'pending' CHECK(ops_status IN('pending','running','succeeded','partial','failed')),
 safe_code text NOT NULL DEFAULT 'queued' CHECK(safe_code ~ '^[a-z][a-z0-9_]{0,79}$'),
 nonce uuid NOT NULL DEFAULT gen_random_uuid(),claim_token uuid,request_id bigint,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),started_at timestamptz,finished_at timestamptz,
 PRIMARY KEY(business_id,id),UNIQUE(business_id,local_date,job_type),CHECK(target_date=local_date-1)
);
CREATE TABLE core.daily_external_budget (
 business_id uuid NOT NULL REFERENCES core.businesses(id),day_ny date NOT NULL,
 requests integer NOT NULL DEFAULT 0 CHECK(requests BETWEEN 0 AND 30),PRIMARY KEY(business_id,day_ny)
);
-- Preserve already-consumed legacy quota; never reset today's counter on rollout.
INSERT INTO core.daily_external_budget(business_id,day_ny,requests)
 SELECT b.id,q.day_ny,q.requests FROM core.businesses b CROSS JOIN core.ops_api_budget q;
ALTER TABLE core.daily_scheduler_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.daily_scheduler_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.daily_external_budget ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.daily_scheduler_settings,core.daily_scheduler_runs,core.daily_external_budget FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION core.daily_safe_run(r core.daily_scheduler_runs) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT jsonb_build_object('id',r.id,'business_id',r.business_id,'local_date',r.local_date,'target_date',r.target_date,
 'status',r.status,'clover_status',r.clover_status,'ops_status',r.ops_status,'safe_code',r.safe_code,
 'started_at',r.started_at,'finished_at',r.finished_at,'reconciled',false);
$$;
CREATE FUNCTION public.daily_run_check(p_business_id uuid,p_run_id uuid,p_token uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM core.daily_scheduler_runs r JOIN core.daily_scheduler_settings s USING(business_id)
 WHERE r.business_id=p_business_id AND r.id=p_run_id AND r.claim_token=p_token AND r.status='running' AND s.enabled);
$$;
CREATE FUNCTION public.daily_reserve_external_request(p_business_id uuid,p_run_id uuid DEFAULT NULL,p_token uuid DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE day date:=(clock_timestamp() AT TIME ZONE 'America/New_York')::date;
BEGIN
 IF p_run_id IS NOT NULL AND NOT public.daily_run_check(p_business_id,p_run_id,p_token) THEN RETURN false; END IF;
 IF p_run_id IS NULL AND p_token IS NOT NULL THEN RETURN false; END IF;
 INSERT INTO core.daily_external_budget(business_id,day_ny) VALUES(p_business_id,day) ON CONFLICT DO NOTHING;
 UPDATE core.daily_external_budget SET requests=requests+1 WHERE business_id=p_business_id AND day_ny=day AND requests<30;
 RETURN FOUND;
END; $$;
CREATE OR REPLACE FUNCTION public.ops_reserve_external_request() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE b uuid;
BEGIN
 -- Legacy manual Ops has no tenant argument: fail closed if scope is ambiguous.
 IF (SELECT count(*) FROM core.businesses)<>1 THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 SELECT id INTO b FROM core.businesses;
 RETURN public.daily_reserve_external_request(b);
END; $$;
CREATE FUNCTION public.daily_scheduler_start(p_business_id uuid,p_run_id uuid,p_nonce uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.daily_scheduler_runs; endpoint text;
BEGIN
 SELECT clover_url INTO endpoint FROM core.daily_scheduler_settings WHERE business_id=p_business_id AND enabled FOR SHARE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE core.daily_scheduler_runs SET status='running',started_at=clock_timestamp(),claim_token=gen_random_uuid(),safe_code='running'
 WHERE business_id=p_business_id AND id=p_run_id AND nonce=p_nonce AND status='queued'
 AND created_at>clock_timestamp()-interval '5 minutes' RETURNING * INTO r;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN core.daily_safe_run(r)||jsonb_build_object('claim_token',r.claim_token,'clover_url',endpoint,
 'start_ms',(extract(epoch FROM (r.target_date::timestamp AT TIME ZONE 'America/New_York'))*1000)::bigint,
 'end_ms',(extract(epoch FROM ((r.target_date+1)::timestamp AT TIME ZONE 'America/New_York'))*1000)::bigint);
END; $$;
CREATE FUNCTION public.daily_clover_claim(p_business_id uuid,p_run_id uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT public.daily_run_check(p_business_id,p_run_id,p_token) THEN RETURN false; END IF;
 UPDATE core.daily_scheduler_runs SET clover_status='running' WHERE business_id=p_business_id AND id=p_run_id AND claim_token=p_token AND clover_status='pending';
 RETURN FOUND;
END; $$;
CREATE FUNCTION public.daily_clover_finish(p_business_id uuid,p_run_id uuid,p_token uuid,p_status text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_status NOT IN('succeeded','partial','failed') OR NOT public.daily_run_check(p_business_id,p_run_id,p_token) THEN RETURN false; END IF;
 UPDATE core.daily_scheduler_runs SET clover_status=p_status WHERE business_id=p_business_id AND id=p_run_id AND claim_token=p_token AND clover_status='running';
 RETURN FOUND;
END; $$;
CREATE FUNCTION public.daily_ops_snapshot(p_business_id uuid,p_run_id uuid,p_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT public.daily_run_check(p_business_id,p_run_id,p_token) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 -- Existing Ops snapshot/providers are legacy single-business readers. Never
 -- reuse their aggregate values for a second tenant in the same project.
 IF (SELECT count(*) FROM core.businesses)<>1 OR NOT EXISTS(SELECT 1 FROM core.businesses WHERE id=p_business_id) THEN
  RAISE EXCEPTION 'legacy_ops_scope_ambiguous' USING ERRCODE='55000';
 END IF;
 UPDATE core.daily_scheduler_runs SET ops_status='running' WHERE business_id=p_business_id AND id=p_run_id AND claim_token=p_token
 AND clover_status IN('succeeded','partial') AND ops_status='pending';
 IF NOT FOUND THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 RETURN public.ops_internal_snapshot_v();
END; $$;
CREATE FUNCTION public.daily_commit_ops(p_business_id uuid,p_run_id uuid,p_token uuid,p_metrics jsonb,p_connections jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item jsonb;
BEGIN
 IF NOT public.daily_run_check(p_business_id,p_run_id,p_token) OR NOT EXISTS(SELECT 1 FROM core.daily_scheduler_runs WHERE business_id=p_business_id AND id=p_run_id AND ops_status='running') THEN
  RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_metrics)<>'array' OR jsonb_typeof(p_connections)<>'array' OR jsonb_array_length(p_metrics)>100 OR jsonb_array_length(p_connections)>12 THEN RAISE EXCEPTION 'invalid_metrics'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_metrics) LOOP
  INSERT INTO core.ops_metrics(business_id,source,metric,value_num,value_text,period_start,period_end,collected_at,collector,is_test)
  VALUES(p_business_id,item->>'source',item->>'metric',(item->>'value_num')::numeric,left(item->>'value_text',300),(item->>'period_start')::date,(item->>'period_end')::date,(item->>'collected_at')::timestamptz,'edge_fn',false)
  ON CONFLICT DO NOTHING;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(p_connections) LOOP
  INSERT INTO core.ops_connections(business_id,source,status,last_ok_at,last_error,note,capabilities)
  VALUES(p_business_id,item->>'source',item->>'status',CASE WHEN item->>'status'='connected' THEN clock_timestamp() END,left(item->>'error',120),left(item->>'note',500),'[]')
  ON CONFLICT(business_id,source) DO UPDATE SET status=excluded.status,last_ok_at=coalesce(excluded.last_ok_at,core.ops_connections.last_ok_at),last_error=excluded.last_error,note=excluded.note;
 END LOOP;
 RETURN true;
END; $$;
CREATE FUNCTION public.daily_scheduler_finish(p_business_id uuid,p_run_id uuid,p_token uuid,p_ops_status text,p_code text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.daily_scheduler_runs;
BEGIN
 IF p_ops_status NOT IN('succeeded','partial','failed') OR p_code NOT IN('collected','partial_collection','clover_failed','budget_exhausted','execution_failed','paused','scope_unavailable') THEN RAISE EXCEPTION 'invalid_result'; END IF;
 UPDATE core.daily_scheduler_runs SET ops_status=p_ops_status,finished_at=clock_timestamp(),safe_code=p_code,
 status=CASE WHEN clover_status='failed' OR p_ops_status='failed' THEN 'failed' WHEN clover_status='partial' OR p_ops_status='partial' THEN 'partial' ELSE 'succeeded' END,claim_token=NULL
 WHERE business_id=p_business_id AND id=p_run_id AND claim_token=p_token AND status='running' RETURNING * INTO r;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN core.daily_safe_run(r);
END; $$;
CREATE FUNCTION public.daily_scheduler_status(p_business_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.daily_scheduler_runs;
BEGIN
 IF auth.uid() IS NULL OR NOT core.staff_authorized_v1(p_business_id,'ops.read') THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM core.daily_scheduler_runs WHERE business_id=p_business_id ORDER BY local_date DESC LIMIT 1;
 RETURN jsonb_build_object('enabled',coalesce((SELECT enabled FROM core.daily_scheduler_settings WHERE business_id=p_business_id),false),
 'last_run',CASE WHEN r.id IS NULL THEN NULL ELSE core.daily_safe_run(r) END,
 'requests_today',coalesce((SELECT requests FROM core.daily_external_budget WHERE business_id=p_business_id AND day_ny=(clock_timestamp() AT TIME ZONE 'America/New_York')::date),0));
END; $$;
CREATE FUNCTION core.daily_scheduler_tick(p_now timestamptz DEFAULT clock_timestamp()) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE local_now timestamp:=p_now AT TIME ZONE 'America/New_York'; s core.daily_scheduler_settings;r core.daily_scheduler_runs;
 secret text; endpoint text; issued bigint; signature text; payload jsonb; n integer:=0;
BEGIN
 UPDATE core.daily_scheduler_runs SET status='failed',safe_code='dispatch_timeout',finished_at=p_now,claim_token=NULL
 WHERE status='queued' AND created_at<p_now-interval '5 minutes';
 UPDATE core.daily_scheduler_runs SET status='failed',safe_code='execution_timeout',finished_at=p_now,claim_token=NULL
 WHERE status='running' AND started_at<p_now-interval '15 minutes';
 FOR s IN SELECT * FROM core.daily_scheduler_settings WHERE enabled FOR UPDATE SKIP LOCKED LOOP
  IF local_now::time<'07:00' THEN CONTINUE; END IF;
  INSERT INTO core.daily_scheduler_runs(business_id,local_date,target_date,status,safe_code,created_at,finished_at)
  VALUES(s.business_id,local_now::date,local_now::date-1,CASE WHEN local_now::time<'07:01' THEN 'queued' ELSE 'missed' END,
  CASE WHEN local_now::time<'07:01' THEN 'queued' ELSE 'missed_schedule' END,p_now,CASE WHEN local_now::time>='07:01' THEN p_now END)
  ON CONFLICT(business_id,local_date,job_type) DO NOTHING RETURNING * INTO r;
  IF NOT FOUND OR r.status<>'queued' THEN CONTINUE; END IF;
  BEGIN
   SELECT decrypted_secret INTO STRICT secret FROM vault.decrypted_secrets WHERE name='SCHEDULER_SIGNING_SECRET';
   SELECT decrypted_secret INTO STRICT endpoint FROM vault.decrypted_secrets WHERE name='SCHEDULER_EDGE_URL';
   IF endpoint !~ '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/daily-ops-run$' THEN RAISE EXCEPTION 'invalid_endpoint'; END IF;
   issued:=floor(extract(epoch FROM p_now));
   signature:=encode(extensions.hmac('daily.dispatch.v1'||E'\n'||r.business_id||E'\n'||r.id||E'\n'||r.nonce||E'\n'||issued,secret,'sha256'),'hex');
   payload:=jsonb_build_object('business_id',r.business_id,'run_id',r.id,'nonce',r.nonce,'issued_at',issued);
   UPDATE core.daily_scheduler_runs SET request_id=net.http_post(url:=endpoint,headers:=jsonb_build_object('Content-Type','application/json','X-Scheduler-Signature',signature),body:=payload,timeout_milliseconds:=10000)
   WHERE business_id=r.business_id AND id=r.id;
   n:=n+1;
  EXCEPTION WHEN OTHERS THEN
   UPDATE core.daily_scheduler_runs SET status='failed',safe_code='dispatch_failed',finished_at=p_now WHERE business_id=r.business_id AND id=r.id;
  END;
 END LOOP;
 RETURN n;
END; $$;
REVOKE ALL ON FUNCTION core.daily_safe_run(core.daily_scheduler_runs),core.daily_scheduler_tick(timestamptz) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.daily_run_check(uuid,uuid,uuid),public.daily_reserve_external_request(uuid,uuid,uuid),public.daily_scheduler_start(uuid,uuid,uuid),public.daily_clover_claim(uuid,uuid,uuid),public.daily_clover_finish(uuid,uuid,uuid,text),public.daily_ops_snapshot(uuid,uuid,uuid),public.daily_commit_ops(uuid,uuid,uuid,jsonb,jsonb),public.daily_scheduler_finish(uuid,uuid,uuid,text,text),public.daily_scheduler_status(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.daily_run_check(uuid,uuid,uuid),public.daily_reserve_external_request(uuid,uuid,uuid),public.daily_scheduler_start(uuid,uuid,uuid),public.daily_clover_claim(uuid,uuid,uuid),public.daily_clover_finish(uuid,uuid,uuid,text),public.daily_ops_snapshot(uuid,uuid,uuid),public.daily_commit_ops(uuid,uuid,uuid,jsonb,jsonb),public.daily_scheduler_finish(uuid,uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.daily_scheduler_status(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.ops_reserve_external_request() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ops_reserve_external_request() TO service_role;
COMMIT;
