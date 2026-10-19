-- PR ONLY. Do not apply automatically. Nazar-production, manual actions only.
-- No cron/Worker scheduled()/n8n and no customer/marketing writes are installed.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.installation WHERE declared_project_ref='khgczybubufouraqyrcj')
 OR to_regclass('core.crm_staff') IS NULL THEN RAISE EXCEPTION 'STOP: expected Nazar installation'; END IF;
END $guard$;

CREATE TABLE core.ops_metrics (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL CHECK(business_id='a358eba4-b197-4309-805b-46f43a718454'),
 source text NOT NULL CHECK(source IN ('clover','klaviyo','google_ads','meta','site','ga4','reviews','scheduler','supabase')),
 metric text NOT NULL CHECK(metric ~ '^[a-z][a-z0-9_]{0,79}$'),
 value_num numeric, value_text text CHECK(length(value_text)<=300),
 period_start date, period_end date, collected_at timestamptz NOT NULL DEFAULT now(),
 collector text NOT NULL CHECK(collector IN ('edge_fn','worker','manual_csv','manual_entry')),
 is_test boolean NOT NULL DEFAULT false CHECK(NOT is_test),
 CHECK(period_start IS NULL OR period_end IS NULL OR period_start<=period_end)
);
-- A nullable period_start cannot be a primary-key member. Surrogate id above;
-- COALESCE here also makes repeated finishes/upserts null-period idempotent.
CREATE UNIQUE INDEX ops_metric_snapshot_unique ON core.ops_metrics
 (business_id,source,metric,coalesce(period_start,'0001-01-01'::date),collected_at);
CREATE INDEX ops_metrics_latest ON core.ops_metrics(business_id,source,metric,collected_at DESC);

CREATE TABLE core.ops_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL CHECK(business_id='a358eba4-b197-4309-805b-46f43a718454'),
 request_key uuid NOT NULL, request_fingerprint text NOT NULL,
 action text NOT NULL CHECK(action IN ('collect','sync_clover_csv','retry_failed_job','offer_set_active','ads_set_status','product_set_channel','commission_report')),
 requested_by uuid NOT NULL REFERENCES auth.users(id), requested_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed','not_connected')),
 result jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(result)='object'),
 finished_at timestamptz, claim_token uuid, retry_of uuid REFERENCES core.ops_actions(id),
 -- Private input: never selected by staff reads. CSV is purged on every finish.
 payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=1100000)
);
CREATE UNIQUE INDEX ops_actions_one_running ON core.ops_actions(business_id,action) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX ops_actions_request_key ON core.ops_actions(business_id,request_key);
CREATE UNIQUE INDEX ops_action_one_retry ON core.ops_actions(retry_of) WHERE retry_of IS NOT NULL;
CREATE INDEX ops_actions_recent ON core.ops_actions(business_id,requested_at DESC);
CREATE TABLE core.ops_connections (
 business_id uuid NOT NULL CHECK(business_id='a358eba4-b197-4309-805b-46f43a718454'),
 source text NOT NULL CHECK(source IN ('clover','klaviyo','google_ads','meta','site','ga4','reviews','scheduler','supabase')),
 status text NOT NULL DEFAULT 'not_connected' CHECK(status IN ('connected','not_connected','error')),
 last_ok_at timestamptz,last_error text CHECK(length(last_error)<=120),note text CHECK(length(note)<=500),
 capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(capabilities)='array'),
 PRIMARY KEY(business_id,source)
);
CREATE TABLE core.ops_offer_approvals (
 business_id uuid NOT NULL CHECK(business_id='a358eba4-b197-4309-805b-46f43a718454'),
 offer_id uuid NOT NULL, approved_at timestamptz NOT NULL DEFAULT now(),
 condition_fingerprint text NOT NULL CHECK(condition_fingerprint ~ '^[a-f0-9]{32}$'),
 reference text NOT NULL CHECK(length(btrim(reference)) BETWEEN 1 AND 300),
 PRIMARY KEY(business_id,offer_id)
);
-- Empty, trusted allowlist. Only owner-reviewed SQL may provision real offers;
-- browser approvalReference is audit text and is NEVER an approval grant.
CREATE TABLE core.ops_csv_imports (
 action_id uuid PRIMARY KEY REFERENCES core.ops_actions(id),business_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),file_name text NOT NULL,
 period_start date NOT NULL,period_end date NOT NULL,qualified_sales numeric NOT NULL,is_complete boolean NOT NULL,
 imported_rows integer NOT NULL CHECK(imported_rows>=0),collected_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,fingerprint,period_start,period_end)
);
CREATE TABLE core.ops_api_budget (
 day_ny date PRIMARY KEY, requests integer NOT NULL DEFAULT 0 CHECK(requests BETWEEN 0 AND 30)
);
DO $rls$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['ops_metrics','ops_actions','ops_connections','ops_offer_approvals','ops_csv_imports','ops_api_budget'] LOOP
  EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY',item);
  EXECUTE format('REVOKE ALL ON core.%I FROM PUBLIC,anon,authenticated,service_role',item);
 END LOOP;
END $rls$;
INSERT INTO core.ops_connections(business_id,source,note,capabilities)
 SELECT 'a358eba4-b197-4309-805b-46f43a718454',source,
 CASE WHEN source='scheduler' THEN 'Günlük scheduler kurulu değil; yalnız elle toplama.' ELSE 'Henüz doğrulanmış snapshot yok.' END,
 CASE WHEN source='clover' THEN '["sync_clover_csv"]'::jsonb WHEN source='supabase' THEN '["collect"]'::jsonb ELSE '[]'::jsonb END
 FROM unnest(ARRAY['clover','klaviyo','google_ads','meta','site','ga4','reviews','scheduler','supabase']) source;

CREATE FUNCTION core.ops_assert_staff() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.crm_staff WHERE auth_user_id=auth.uid() AND active) THEN
  RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
END $fn$;
REVOKE ALL ON FUNCTION core.ops_assert_staff() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION core.ops_safe_action(p_row core.ops_actions) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $fn$
 SELECT jsonb_build_object('id',p_row.id,'request_key',p_row.request_key,'action',p_row.action,'requested_by',p_row.requested_by,
 'requested_at',p_row.requested_at,'status',p_row.status,'result',p_row.result,'finished_at',p_row.finished_at);
$fn$;
REVOKE ALL ON FUNCTION core.ops_safe_action(core.ops_actions) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.ops_actions_v() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE items jsonb;
BEGIN
 PERFORM core.ops_assert_staff();
 SELECT coalesce(jsonb_agg(core.ops_safe_action(a) ORDER BY a.requested_at DESC),'[]') INTO items
 FROM(SELECT * FROM core.ops_actions WHERE business_id='a358eba4-b197-4309-805b-46f43a718454' ORDER BY requested_at DESC LIMIT 50)a;
 RETURN jsonb_build_object('items',items);
END $fn$;
CREATE FUNCTION public.ops_connections_v() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE items jsonb;
BEGIN
 PERFORM core.ops_assert_staff();
 SELECT coalesce(jsonb_agg(jsonb_build_object('source',source,'status',status,'last_ok_at',last_ok_at,'last_error',last_error,'note',note,'capabilities',core.ops_capabilities(source)) ORDER BY source),'[]') INTO items
 FROM core.ops_connections WHERE business_id='a358eba4-b197-4309-805b-46f43a718454';
 RETURN jsonb_build_object('items',items);
END $fn$;
CREATE FUNCTION core.ops_offer_catalog() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE items jsonb;
BEGIN
 IF to_regclass('core.offers') IS NULL OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE oid=to_regprocedure('public.set_offer_active(uuid,boolean)') AND prorettype='jsonb'::regtype) THEN RETURN '[]'; END IF;
 EXECUTE $query$SELECT coalesce(jsonb_agg(jsonb_build_object('id',j->>'id','name',j->>'name',
 'is_test',coalesce((j->>'is_test')::boolean,false),'active',(j->>'active')::boolean,
 'approved',coalesce((j->>'is_test')::boolean,false) OR EXISTS(SELECT 1 FROM core.ops_offer_approvals a WHERE a.business_id='a358eba4-b197-4309-805b-46f43a718454' AND a.offer_id=(j->>'id')::uuid AND a.condition_fingerprint=md5((j-'active'-'created_at'-'updated_at')::text)))),'[]')
 FROM(SELECT to_jsonb(o)j FROM core.offers o)r
 WHERE j->>'business_id'='a358eba4-b197-4309-805b-46f43a718454' AND j ?& ARRAY['id','name','active'] AND jsonb_typeof(j->'active')='boolean'$query$ INTO items;
 RETURN items;
EXCEPTION WHEN undefined_column OR invalid_text_representation THEN RETURN '[]';
END $fn$;
REVOKE ALL ON FUNCTION core.ops_offer_catalog() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION core.ops_capabilities(p_source text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE capabilities jsonb:='[]';
BEGIN
 IF p_source='clover' THEN RETURN '["sync_clover_csv"]'; END IF;
 IF p_source<>'supabase' THEN RETURN '[]'; END IF;
 capabilities:='["collect"]';
 IF to_regprocedure('core.compute_commission(uuid,date,numeric,numeric,boolean)') IS NOT NULL AND to_regclass('core.commissions') IS NOT NULL
 AND EXISTS(SELECT 1 FROM core.ops_csv_imports WHERE is_complete) THEN capabilities:=capabilities||jsonb_build_array('commission_report'); END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(core.ops_offer_catalog())o WHERE (o->>'approved')::boolean) THEN capabilities:=capabilities||jsonb_build_array('offer_set_active'); END IF;
 IF EXISTS(SELECT 1 FROM core.ops_actions a WHERE a.action='collect' AND a.status='failed' AND a.requested_at>=now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM core.ops_actions r WHERE r.retry_of=a.id)) THEN capabilities:=capabilities||jsonb_build_array('retry_failed_job'); END IF;
 RETURN capabilities;
END $fn$;
REVOKE ALL ON FUNCTION core.ops_capabilities(text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.ops_dashboard_v() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE metrics jsonb; jobs jsonb;
BEGIN
 PERFORM core.ops_assert_staff();
 SELECT coalesce(jsonb_agg(to_jsonb(m)-'id'-'business_id'),'[]') INTO metrics FROM(
 SELECT DISTINCT ON(source,metric) * FROM core.ops_metrics
 WHERE business_id='a358eba4-b197-4309-805b-46f43a718454' AND NOT is_test
 ORDER BY source,metric,CASE WHEN period_start IS NULL OR
 (period_start>=date_trunc('month',now() AT TIME ZONE 'America/New_York')::date AND period_end<=(now() AT TIME ZONE 'America/New_York')::date)
 OR (period_start=(now() AT TIME ZONE 'America/New_York')::date-1 AND period_end=period_start)
 OR (period_start=(now() AT TIME ZONE 'America/New_York')::date-7 AND period_end>=(now() AT TIME ZONE 'America/New_York')::date-1)
 THEN 0 ELSE 1 END,collected_at DESC,period_end DESC LIMIT 1000)m;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',action,'failed_at',finished_at)),'[]') INTO jobs
 FROM core.ops_actions a WHERE business_id='a358eba4-b197-4309-805b-46f43a718454' AND action='collect' AND status='failed'
 AND requested_at>=now()-interval '24 hours' AND NOT EXISTS(SELECT 1 FROM core.ops_actions r WHERE r.retry_of=a.id);
 RETURN jsonb_build_object('business_id','a358eba4-b197-4309-805b-46f43a718454','generated_at',now(),'metrics',metrics,'offers',core.ops_offer_catalog(),'failed_jobs',jobs,'campaigns','[]'::jsonb,'products','[]'::jsonb);
END $fn$;

CREATE FUNCTION public.ops_request_action(p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
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
  IF row.requested_by<>auth.uid() OR row.request_fingerprint<>fingerprint THEN RAISE EXCEPTION 'Conflicting request key' USING ERRCODE='22023'; END IF;
  RETURN core.ops_safe_action(row);
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload)k WHERE NOT k=ANY(allowed)) THEN RAISE EXCEPTION 'Unsupported action fields' USING ERRCODE='22023'; END IF;
 -- A grey action is a logged intent, not an attempt to mutate an unknown target.
 -- Do this before connected-target validation so {} is a truthful not_connected receipt.
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

CREATE FUNCTION public.ops_claim_action(p_action_id uuid,p_user_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE row core.ops_actions;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.crm_staff WHERE auth_user_id=p_user_id AND active) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
 UPDATE core.ops_actions SET status='running',claim_token=gen_random_uuid()
 WHERE id=p_action_id AND business_id='a358eba4-b197-4309-805b-46f43a718454' AND requested_by=p_user_id AND status='queued' RETURNING * INTO row;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('id',row.id,'request_key',row.request_key,'action',row.action,'payload',row.payload,'claim_token',row.claim_token,'requested_by',row.requested_by,'requested_at',row.requested_at);
END $fn$;
CREATE FUNCTION public.ops_reserve_external_request() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE day date:=(now() AT TIME ZONE 'America/New_York')::date;
BEGIN
 INSERT INTO core.ops_api_budget(day_ny) VALUES(day) ON CONFLICT DO NOTHING;
 UPDATE core.ops_api_budget SET requests=requests+1 WHERE day_ny=day AND requests<30;
 RETURN FOUND;
END $fn$;
CREATE FUNCTION public.ops_action_claim_valid(p_action_id uuid,p_claim_token uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 PERFORM 1 FROM core.ops_actions WHERE id=p_action_id AND claim_token=p_claim_token AND status='running' AND business_id='a358eba4-b197-4309-805b-46f43a718454' FOR UPDATE;
 RETURN FOUND;
END $fn$;
CREATE FUNCTION public.ops_reconcile_action(p_action_id uuid,p_request_key uuid,p_status text,p_reason_code text) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE row core.ops_actions;
BEGIN
 IF p_status NOT IN('done','failed') OR p_status IS NULL OR p_reason_code NOT IN('verified_import_committed','verified_offer_state','verified_report_object','verified_source_snapshot','verified_no_side_effect','operator_abandoned_unknown') OR p_reason_code IS NULL THEN RAISE EXCEPTION 'Invalid explicit reconciliation'; END IF;
 SELECT * INTO row FROM core.ops_actions WHERE id=p_action_id AND request_key=p_request_key AND business_id='a358eba4-b197-4309-805b-46f43a718454'
 AND status IN('queued','running') AND requested_at<=now()-interval '5 minutes' FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF p_status='done' AND NOT((row.action='sync_clover_csv' AND p_reason_code='verified_import_committed')
 OR(row.action='offer_set_active' AND p_reason_code='verified_offer_state') OR(row.action='commission_report' AND p_reason_code='verified_report_object')
 OR(row.action IN('collect','retry_failed_job') AND p_reason_code='verified_source_snapshot')) THEN RAISE EXCEPTION 'Done requires a matching operator verification'; END IF;
 UPDATE core.ops_actions SET status=p_status,payload='{}',claim_token=NULL,finished_at=now(),
 result=jsonb_build_object('code','manual_reconciled','message','Yetkili operatör sonucu elle uzlaştırdı; otomatik tekrar yapılmadı.','reasonCode',p_reason_code)
 WHERE id=row.id;
 RETURN true;
END $fn$;
CREATE FUNCTION public.ops_finish_action(p_action_id uuid,p_claim_token uuid,p_status text,p_result jsonb,p_metrics jsonb DEFAULT '[]',p_connections jsonb DEFAULT '[]') RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE item jsonb; row core.ops_actions; v_finished_at timestamptz:=now();
BEGIN
 IF p_status NOT IN('done','failed','not_connected') OR p_status IS NULL OR jsonb_typeof(p_result)<>'object' OR octet_length(p_result::text)>8192
 OR jsonb_typeof(p_metrics)<>'array' OR jsonb_array_length(p_metrics)>1000 OR jsonb_typeof(p_connections)<>'array' OR jsonb_array_length(p_connections)>9 THEN RAISE EXCEPTION 'Invalid ops finish'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_result)k WHERE k NOT IN('code','message','downloadPath','requestsUsed','sources','collected','importedRows','excludedRows','periodStart','periodEnd','qualifiedSales','retriedActionId','month','fingerprint')) THEN RAISE EXCEPTION 'Unsafe ops result fields'; END IF;
 SELECT * INTO row FROM core.ops_actions WHERE id=p_action_id AND claim_token=p_claim_token AND status='running' AND business_id='a358eba4-b197-4309-805b-46f43a718454' FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_metrics) LOOP
  IF coalesce((item->>'is_test')::boolean,false) OR item->>'source' NOT IN('clover','klaviyo','google_ads','meta','site','ga4','reviews','scheduler','supabase') THEN RAISE EXCEPTION 'Invalid metric source'; END IF;
  INSERT INTO core.ops_metrics(business_id,source,metric,value_num,value_text,period_start,period_end,collected_at,collector,is_test)
  VALUES(row.business_id,item->>'source',item->>'metric',(item->>'value_num')::numeric,left(item->>'value_text',300),(item->>'period_start')::date,(item->>'period_end')::date,
  coalesce((item->>'collected_at')::timestamptz,v_finished_at),coalesce(item->>'collector','edge_fn'),false) ON CONFLICT DO NOTHING;
 END LOOP;
 FOR item IN SELECT value FROM jsonb_array_elements(p_connections) LOOP
  IF jsonb_typeof(coalesce(item->'capabilities','[]'))<>'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(item->'capabilities','[]'))c WHERE c NOT IN('collect','sync_clover_csv','retry_failed_job','offer_set_active','ads_set_status','product_set_channel','commission_report')) THEN RAISE EXCEPTION 'Invalid capability'; END IF;
  INSERT INTO core.ops_connections(business_id,source,status,last_ok_at,last_error,note,capabilities) VALUES(row.business_id,item->>'source',item->>'status',CASE WHEN item->>'status'='connected' THEN v_finished_at END,left(item->>'last_error',120),left(item->>'note',500),coalesce(item->'capabilities','[]'))
  ON CONFLICT(business_id,source) DO UPDATE SET status=excluded.status,last_ok_at=coalesce(excluded.last_ok_at,core.ops_connections.last_ok_at),last_error=excluded.last_error,note=excluded.note,capabilities=excluded.capabilities;
 END LOOP;
 UPDATE core.ops_actions SET status=p_status,result=p_result,finished_at=v_finished_at,payload='{}',claim_token=NULL WHERE id=row.id;
 RETURN true;
END $fn$;

CREATE FUNCTION public.ops_apply_offer_action(p_action_id uuid,p_claim_token uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE row core.ops_actions; offer jsonb; result jsonb;
BEGIN
 SELECT * INTO row FROM core.ops_actions WHERE id=p_action_id AND claim_token=p_claim_token AND status='running' AND action='offer_set_active' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid action receipt'; END IF;
 SELECT value INTO offer FROM jsonb_array_elements(core.ops_offer_catalog()) WHERE value->>'id'=row.payload->>'offerId';
 IF offer IS NULL OR coalesce((offer->>'approved')::boolean,false)=false THEN RAISE EXCEPTION 'offer_approval_or_schema_unavailable' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM core.ops_actions a WHERE a.id=row.id AND a.result->>'code'='offer_applied') THEN RETURN true; END IF;
 EXECUTE 'SELECT public.set_offer_active($1,$2)' INTO result USING (row.payload->>'offerId')::uuid,(row.payload->>'active')::boolean;
 UPDATE core.ops_actions SET result=jsonb_build_object('code','offer_applied') WHERE id=row.id;
 RETURN result IS NOT NULL AND result->>'id'=row.payload->>'offerId' AND coalesce((result->>'active')::boolean,false)=(row.payload->>'active')::boolean;
END $fn$;

CREATE FUNCTION public.ops_commit_clover_csv(p_action_id uuid,p_claim_token uuid,p_data jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE row core.ops_actions; v_result jsonb; start_date date; end_date date; value numeric; metric jsonb; complete boolean; today date:=(now() AT TIME ZONE 'America/New_York')::date;
BEGIN
 SELECT * INTO row FROM core.ops_actions WHERE id=p_action_id AND claim_token=p_claim_token AND status='running' AND action='sync_clover_csv' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid action receipt'; END IF;
 IF to_regprocedure('core.compute_commission(uuid,date,numeric,numeric,boolean)') IS NULL OR to_regclass('core.commissions') IS NULL THEN RAISE EXCEPTION 'commission_engine_unavailable' USING ERRCODE='55000'; END IF;
 start_date:=(p_data->>'periodStart')::date;end_date:=(p_data->>'periodEnd')::date;value:=(p_data->>'qualifiedSales')::numeric;
 IF start_date IS NULL OR end_date IS NULL OR value IS NULL OR date_trunc('month',start_date)::date<>start_date OR date_trunc('month',end_date)::date<>start_date
 OR start_date>(now() AT TIME ZONE 'America/New_York')::date OR end_date<start_date OR end_date>(now() AT TIME ZONE 'America/New_York')::date
 OR p_data->>'fingerprint' !~ '^[a-f0-9]{64}$' OR coalesce((p_data->>'qualified')::boolean,false)=false THEN RAISE EXCEPTION 'CSV qualification or period invalid'; END IF;
 complete:=end_date=(date_trunc('month',start_date)+interval '1 month - 1 day')::date AND end_date<today;
 IF NOT complete AND NOT(start_date=date_trunc('month',today)::date AND end_date IN(today,today-1)) THEN RAISE EXCEPTION 'Partial CSV is not a verified current MTD estimate'; END IF;
 IF complete AND to_regprocedure('public.record_commission(uuid,date,numeric,numeric)') IS NULL THEN RAISE EXCEPTION 'commission_engine_unavailable' USING ERRCODE='55000'; END IF;
 IF EXISTS(SELECT 1 FROM core.ops_csv_imports WHERE action_id=row.id) THEN SELECT a.result INTO v_result FROM core.ops_actions a WHERE a.id=row.id; RETURN v_result; END IF;
 INSERT INTO core.ops_csv_imports(action_id,business_id,fingerprint,file_name,period_start,period_end,qualified_sales,imported_rows,is_complete)
 VALUES(row.id,row.business_id,p_data->>'fingerprint',left(row.payload->>'fileName',120),start_date,end_date,value,(p_data->>'importedRows')::integer,complete);
 -- Net-sales CSV already includes refunds. A separate deduction here would double count.
 IF complete THEN EXECUTE 'SELECT public.record_commission($1,$2,$3,0::numeric)' INTO v_result USING row.business_id,start_date,value;
 ELSE EXECUTE 'SELECT core.compute_commission($1,$2,$3,0::numeric,false)' INTO v_result USING row.business_id,start_date,value; END IF;
 FOR metric IN SELECT element FROM jsonb_array_elements(p_data->'metrics')element LOOP
  IF metric->>'source'<>'clover' THEN RAISE EXCEPTION 'Invalid CSV metric source'; END IF;
  INSERT INTO core.ops_metrics(business_id,source,metric,value_num,value_text,period_start,period_end,collected_at,collector)
  VALUES(row.business_id,'clover',metric->>'metric',(metric->>'value_num')::numeric,left(metric->>'value_text',300),(metric->>'period_start')::date,(metric->>'period_end')::date,now(),'manual_csv');
 END LOOP;
 FOREACH metric IN ARRAY ARRAY[jsonb_build_object('metric','qualified_sales_mtd','value',value),jsonb_build_object('metric','qicr_mtd','value',v_result->'qicr'),jsonb_build_object('metric','baseline','value',v_result->'baseline'),jsonb_build_object('metric','commission_mtd','value',v_result->'commission_amount'),jsonb_build_object('metric','rate','value',v_result->'rate')] LOOP
  INSERT INTO core.ops_metrics(business_id,source,metric,value_num,value_text,period_start,period_end,collected_at,collector) VALUES(row.business_id,'supabase',metric->>'metric',(metric->>'value')::numeric,CASE WHEN NOT complete THEN 'estimate' ELSE 'complete_month' END,start_date,end_date,now(),'manual_csv');
 END LOOP;
 UPDATE core.ops_actions SET result=v_result WHERE id=row.id;
 RETURN v_result||jsonb_build_object('source_file',left(row.payload->>'fileName',120),'collected_at',now(),'period_start',start_date,'period_end',end_date);
END $fn$;

CREATE FUNCTION public.ops_commission_report_data(p_action_id uuid,p_claim_token uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE row core.ops_actions; imported core.ops_csv_imports; result jsonb; month date;
BEGIN
 SELECT * INTO row FROM core.ops_actions WHERE id=p_action_id AND claim_token=p_claim_token AND status='running' AND action='commission_report' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Invalid action receipt'; END IF;
 month:=((row.payload->>'month')||'-01')::date;
 SELECT * INTO imported FROM core.ops_csv_imports WHERE business_id=row.business_id AND period_start=month AND is_complete AND period_end=(month+interval '1 month - 1 day')::date ORDER BY collected_at DESC LIMIT 1;
 IF NOT FOUND OR to_regprocedure('core.compute_commission(uuid,date,numeric,numeric,boolean)') IS NULL THEN RAISE EXCEPTION 'qualified_month_source_unavailable' USING ERRCODE='55000'; END IF;
 EXECUTE 'SELECT core.compute_commission($1,$2,$3,0::numeric,true)' INTO result USING row.business_id,month,imported.qualified_sales;
 RETURN result||jsonb_build_object('source_file',imported.file_name,'collected_at',imported.collected_at,'period_start',imported.period_start,'period_end',imported.period_end);
END $fn$;

CREATE FUNCTION public.ops_internal_snapshot_v() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE metrics jsonb:='[]'; previous jsonb; n bigint; today date:=(now() AT TIME ZONE 'America/New_York')::date; stamp timestamptz:=now(); capabilities jsonb:=jsonb_build_array('collect'); imported core.ops_csv_imports; commission jsonb; last_import_at text; last_import_source text;
BEGIN
 -- Query only verified columns; missing schema remains an unknown metric.
 IF to_regclass('core.signups') IS NOT NULL THEN
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='core' AND table_name='signups' AND column_name IN('business_id','created_at','is_test'))=3 THEN
   EXECUTE 'SELECT count(*) FROM core.signups WHERE business_id=$1 AND NOT is_test AND created_at >= ($2::date::timestamp AT TIME ZONE ''America/New_York'') AND created_at < (($3::date+1)::timestamp AT TIME ZONE ''America/New_York'')' INTO n USING 'a358eba4-b197-4309-805b-46f43a718454'::uuid,today-7,today-1;
   metrics:=metrics||jsonb_build_array(jsonb_build_object('source','supabase','metric','form_submissions_7d','value_num',n,'value_text',NULL,'period_start',today-7,'period_end',today-1,'collected_at',stamp,'collector','edge_fn','is_test',false));
   IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='core' AND table_name='signups' AND column_name='processed') THEN
    EXECUTE 'SELECT count(*) FROM core.signups WHERE business_id=$1 AND NOT is_test AND processed=false' INTO n USING 'a358eba4-b197-4309-805b-46f43a718454'::uuid;
    metrics:=metrics||jsonb_build_array(jsonb_build_object('source','supabase','metric','pending_signups','value_num',n,'value_text',NULL,'period_start',NULL,'period_end',NULL,'collected_at',stamp,'collector','edge_fn','is_test',false));
   END IF;
  END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(metrics)m WHERE m->>'metric'='pending_signups') THEN
  metrics:=metrics||jsonb_build_array(jsonb_build_object('source','supabase','metric','pending_signups','value_num',NULL,'value_text','processed / is_test sütunu doğrulanamadı.','period_start',NULL,'period_end',NULL,'collected_at',stamp,'collector','edge_fn','is_test',false));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(metrics)m WHERE m->>'metric'='form_submissions_7d') THEN
  metrics:=metrics||jsonb_build_array(jsonb_build_object('source','supabase','metric','form_submissions_7d','value_num',NULL,'value_text','Test dışı başvuru kaynağı doğrulanamadı.','period_start',today-7,'period_end',today-1,'collected_at',stamp,'collector','edge_fn','is_test',false));
 END IF;
 metrics:=metrics||jsonb_build_array(jsonb_build_object('source','supabase','metric','failed_records_7d','value_num',NULL,'value_text','Hata kaydında müşteri ve test ayrımı bulunmuyor.','period_start',today-7,'period_end',today-1,'collected_at',stamp,'collector','edge_fn','is_test',false));
 SELECT * INTO imported FROM core.ops_csv_imports WHERE business_id='a358eba4-b197-4309-805b-46f43a718454' ORDER BY collected_at DESC LIMIT 1;
 SELECT value_text INTO last_import_at FROM core.ops_metrics WHERE source='supabase' AND metric='last_clover_import_at' AND value_text IS NOT NULL ORDER BY collected_at DESC LIMIT 1;
 IF last_import_at IS NULL AND imported.action_id IS NOT NULL THEN last_import_at:=imported.collected_at::text; END IF;
 IF last_import_at IS NOT NULL THEN last_import_source:='CSV'; END IF;
 metrics:=metrics||jsonb_build_array(jsonb_build_object('source','supabase','metric','last_clover_import_at','value_num',NULL,'value_text',last_import_at,'period_start',NULL,'period_end',NULL,'collected_at',stamp,'collector','edge_fn','is_test',false),jsonb_build_object('source','supabase','metric','last_clover_import_source','value_num',NULL,'value_text',last_import_source,'period_start',NULL,'period_end',NULL,'collected_at',stamp,'collector','edge_fn','is_test',false));
 IF to_regclass('core.commissions') IS NOT NULL THEN
 BEGIN
  EXECUTE 'SELECT to_jsonb(c) FROM core.commissions c WHERE c.business_id=$1 AND c.period_month=$2 ORDER BY computed_at DESC LIMIT 1' INTO commission USING 'a358eba4-b197-4309-805b-46f43a718454'::uuid,date_trunc('month',today)::date;
  IF commission IS NOT NULL THEN
   metrics:=metrics||(SELECT jsonb_agg(jsonb_build_object('source','supabase','metric',key,'value_num',value::numeric,'value_text','Kayıtlı hesap; ek satış kanıtı değildir.','period_start',date_trunc('month',today)::date,'period_end',today,'collected_at',stamp,'collector','edge_fn','is_test',false)) FROM(VALUES('qualified_sales_mtd',commission->>'qualified_sales'),('qicr_mtd',commission->>'qicr'),('baseline',commission->>'baseline'),('commission_mtd',commission->>'commission_amount'),('rate',commission->>'rate'))t(key,value));
  END IF;
 EXCEPTION WHEN undefined_column OR invalid_text_representation THEN NULL;
 END;
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(m)-'id'-'business_id'),'[]') INTO previous FROM(SELECT * FROM core.ops_metrics WHERE source IN('reviews','klaviyo') AND metric IN('total_reviews','subscribers') AND collected_at>=now()-interval '9 days' ORDER BY collected_at DESC LIMIT 1000)m;
 capabilities:=core.ops_capabilities('supabase');
 RETURN jsonb_build_object('metrics',metrics,'previous',previous,'capabilities',capabilities,
 'scheduler',jsonb_build_object('mode','manual','scheduled_installed',false,'runs_24h',(SELECT count(*) FROM core.ops_actions WHERE action IN('collect','retry_failed_job') AND requested_at>=now()-interval '24 hours'),'failed_24h',(SELECT count(*) FROM core.ops_actions WHERE action IN('collect','retry_failed_job') AND status='failed' AND requested_at>=now()-interval '24 hours'),
 'last_error',(SELECT jsonb_build_object('name',action,'at',finished_at) FROM core.ops_actions WHERE status='failed' AND action IN('collect','retry_failed_job') ORDER BY finished_at DESC LIMIT 1)));
END $fn$;

-- No table reads are granted. Staff receives narrow aggregate RPCs only.
REVOKE ALL ON FUNCTION public.ops_dashboard_v(),public.ops_actions_v(),public.ops_connections_v(),public.ops_request_action(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ops_dashboard_v(),public.ops_actions_v(),public.ops_connections_v(),public.ops_request_action(text,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.ops_claim_action(uuid,uuid),public.ops_reserve_external_request(),public.ops_finish_action(uuid,uuid,text,jsonb,jsonb,jsonb),public.ops_apply_offer_action(uuid,uuid),public.ops_commit_clover_csv(uuid,uuid,jsonb),public.ops_commission_report_data(uuid,uuid),public.ops_internal_snapshot_v() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ops_claim_action(uuid,uuid),public.ops_reserve_external_request(),public.ops_finish_action(uuid,uuid,text,jsonb,jsonb,jsonb),public.ops_apply_offer_action(uuid,uuid),public.ops_commit_clover_csv(uuid,uuid,jsonb),public.ops_commission_report_data(uuid,uuid),public.ops_internal_snapshot_v() TO service_role;
REVOKE ALL ON FUNCTION public.ops_action_claim_valid(uuid,uuid),public.ops_reconcile_action(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ops_action_claim_valid(uuid,uuid),public.ops_reconcile_action(uuid,uuid,text,text) TO service_role;

-- Private, versioned reports. No public URL or write access for staff browsers.
DO $private_bucket$ BEGIN
 IF EXISTS(SELECT 1 FROM storage.buckets WHERE id='nazar-ops' AND public) THEN RAISE EXCEPTION 'STOP: nazar-ops report bucket must be private'; END IF;
END $private_bucket$;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('nazar-ops','nazar-ops',false,1048576,ARRAY['application/pdf']) ON CONFLICT(id) DO NOTHING;
CREATE POLICY nazar_ops_report_read ON storage.objects FOR SELECT TO authenticated USING(
 bucket_id='nazar-ops' AND name ~ '^a358eba4-b197-4309-805b-46f43a718454/ops/commission/[0-9]{4}-[0-9]{2}-[a-f0-9-]{36}\.pdf$'
 AND EXISTS(SELECT 1 FROM public.crm_staff_authorized_v1()allowed WHERE allowed));
-- Existing broad Storage policies must not accidentally open the new bucket.
CREATE POLICY nazar_ops_report_anon_guard ON storage.objects AS RESTRICTIVE FOR SELECT TO anon USING(bucket_id<>'nazar-ops');
CREATE POLICY nazar_ops_report_staff_guard ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated USING(
 bucket_id<>'nazar-ops' OR (name ~ '^a358eba4-b197-4309-805b-46f43a718454/ops/commission/[0-9]{4}-[0-9]{2}-[a-f0-9-]{36}\.pdf$' AND public.crm_staff_authorized_v1()));
NOTIFY pgrst,'reload schema';
COMMIT;
