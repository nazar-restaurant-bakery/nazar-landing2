-- Faz 1 / Gorev 5 (kalan): GO Growth Engine'in platform veritabanina erisimi.
-- LF bytes, psql 18.6. GO (Cloudflare Worker go-growth-engine) G4 tablolarina
-- dogrudan degil, yalniz bu sunucu fonksiyonlariyla erisir:
--   * SECURITY DEFINER, search_path='' ; EXECUTE yalniz service_role.
--   * Her cagri auth.role()='service_role' ister; anon/authenticated kapali.
--   * Veri okuyan/yazan her fonksiyon p_business_id ile sinirlidir.
--   * Engel listesinden (core.email_suppressions) silen/degistiren fonksiyon yoktur.
-- core semasi kapali kalir. Tablolar, mevcut veriler ve mevcut fonksiyonlar degismez.
-- Gonderim kapisi (168 saat, Gorev 6) ve message_log yazimi (Gorev 6/7) burada YOKTUR.
-- Geri alma: supabase/rollbacks/20261030000400_go_platform_access_down.sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('go_platform_access_v1',0));

DO $guard$ BEGIN
  IF pg_catalog.to_regclass('core.b2b_leads') IS NULL
    OR pg_catalog.to_regclass('core.outreach_settings') IS NULL
    OR pg_catalog.to_regclass('core.email_suppressions') IS NULL
    OR pg_catalog.to_regclass('core.enrichment_log') IS NULL
    OR pg_catalog.to_regclass('core.api_keys') IS NULL
    OR pg_catalog.to_regclass('core.api_key_businesses') IS NULL
    OR pg_catalog.to_regprocedure('core.email_suppressions_immutable_v1()') IS NULL
  THEN RAISE EXCEPTION 'GO_ACCESS_G4_REQUIRED'; END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
  THEN RAISE EXCEPTION 'GO_ACCESS_CORE_MUST_BE_PRIVATE'; END IF;
  IF pg_catalog.to_regprocedure('core.go_scope_v1(uuid)') IS NOT NULL
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'go\_%\_v1')
  THEN RAISE EXCEPTION 'GO_ACCESS_ALREADY_INSTALLED'; END IF;
END $guard$;

-- Caller and tenant check shared by every GO function.
CREATE FUNCTION core.go_scope_v1(p_business_id uuid) RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
  END IF;
  IF p_business_id IS NULL OR NOT EXISTS(SELECT 1 FROM core.businesses WHERE id=p_business_id) THEN
    RAISE EXCEPTION 'GO_BUSINESS_NOT_FOUND' USING ERRCODE='22023';
  END IF;
END $$;

CREATE FUNCTION core.go_email_v1(p_email text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
  SELECT CASE WHEN pg_catalog.length(pg_catalog.btrim(p_email)) BETWEEN 3 AND 254
    AND pg_catalog.lower(pg_catalog.btrim(p_email)) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    THEN pg_catalog.lower(pg_catalog.btrim(p_email)) END
$$;

-- 1. API key: 'ok' | 'invalid_key' | 'business_missing' | 'business_not_found' | 'forbidden'.
-- The key is checked first, as before (401 precedes body validation).
CREATE FUNCTION public.go_api_key_authorize_v1(p_key_hash text,p_business_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_key uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$' THEN RETURN 'invalid_key'; END IF;
  SELECT id INTO v_key FROM core.api_keys WHERE key_hash=p_key_hash AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN 'invalid_key'; END IF;
  IF p_business_id IS NULL THEN RETURN 'business_missing'; END IF;
  IF NOT EXISTS(SELECT 1 FROM core.businesses WHERE id=p_business_id) THEN RETURN 'business_not_found'; END IF;
  IF NOT EXISTS(SELECT 1 FROM core.api_key_businesses WHERE api_key_id=v_key AND business_id=p_business_id) THEN
    RETURN 'forbidden'; END IF;
  RETURN 'ok';
END $$;

-- 2. Operator scripts: create (atomic, no cleanup delete needed) and revoke by prefix.
CREATE FUNCTION public.go_api_key_create_v1(p_name text,p_key_prefix text,p_key_hash text,p_business_ids uuid[])
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_id uuid; v_business uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF pg_catalog.length(pg_catalog.btrim(COALESCE(p_name,''))) NOT BETWEEN 1 AND 200
    OR COALESCE(p_key_prefix,'') !~ '^[A-Za-z0-9_-]{8}$' OR COALESCE(p_key_hash,'') !~ '^[0-9a-f]{64}$'
    OR COALESCE(pg_catalog.cardinality(p_business_ids),0)=0 THEN
    RAISE EXCEPTION 'GO_API_KEY_INVALID' USING ERRCODE='22023';
  END IF;
  FOREACH v_business IN ARRAY p_business_ids LOOP PERFORM core.go_scope_v1(v_business); END LOOP;
  INSERT INTO core.api_keys(name,key_prefix,key_hash) VALUES(pg_catalog.btrim(p_name),p_key_prefix,p_key_hash)
    RETURNING id INTO v_id;
  INSERT INTO core.api_key_businesses(api_key_id,business_id)
    SELECT v_id,b FROM pg_catalog.unnest(p_business_ids) AS b GROUP BY b;
  RETURN v_id;
END $$;

CREATE FUNCTION public.go_api_key_revoke_v1(p_key_prefix text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_count integer; v_name text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  SELECT count(*),min(name) INTO v_count,v_name FROM core.api_keys WHERE key_prefix=p_key_prefix AND revoked_at IS NULL;
  IF v_count<>1 THEN RETURN pg_catalog.jsonb_build_object('status',CASE WHEN v_count=0 THEN 'not_found' ELSE 'ambiguous' END,'count',v_count); END IF;
  UPDATE core.api_keys SET revoked_at=pg_catalog.now() WHERE key_prefix=p_key_prefix AND revoked_at IS NULL;
  RETURN pg_catalog.jsonb_build_object('status','revoked','name',v_name);
END $$;

CREATE FUNCTION public.go_business_check_v1(p_business_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  RETURN p_business_id IS NOT NULL AND EXISTS(SELECT 1 FROM core.businesses WHERE id=p_business_id);
END $$;

-- 3. Settings, returned with GO's existing field names.
CREATE FUNCTION public.go_outreach_settings_get_v1(p_business_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  RETURN (SELECT pg_catalog.jsonb_build_object('business_id',s.business_id,
    'outreach_sender_name',s.sender_name,'outreach_sender_email',s.sender_email,
    'outreach_reply_to',s.reply_to,'outreach_physical_address',s.physical_address,
    'outreach_link_base_url',s.link_base_url,'outreach_timezone',s.timezone,
    'outreach_send_days',pg_catalog.to_jsonb(s.send_days),
    'outreach_send_start',pg_catalog.to_char(s.send_start,'HH24:MI:SS'),
    'outreach_send_end',pg_catalog.to_char(s.send_end,'HH24:MI:SS'),
    'outreach_daily_send_limit',s.daily_send_limit,
    'enrichment_daily_credit_limit',s.enrichment_daily_credit_limit,
    'enrichment_monthly_credit_limit',s.enrichment_monthly_credit_limit)
    FROM core.outreach_settings s WHERE s.business_id=p_business_id);
END $$;

-- Scheduler only: which tenants have GO settings. Returns identifiers, no data.
CREATE FUNCTION public.go_outreach_business_ids_v1() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  RETURN COALESCE((SELECT pg_catalog.jsonb_agg(business_id ORDER BY business_id) FROM core.outreach_settings),'[]'::jsonb);
END $$;

-- 4. Enrichment.
CREATE FUNCTION public.go_enrichment_credits_used_v1(p_business_id uuid,p_day_start timestamptz,p_month_start timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF p_day_start IS NULL OR p_month_start IS NULL OR p_month_start>p_day_start THEN
    RAISE EXCEPTION 'GO_INVALID_PERIOD' USING ERRCODE='22023'; END IF;
  RETURN (SELECT pg_catalog.jsonb_build_object(
      'used_today',COALESCE(sum(credits_used) FILTER (WHERE created_at>=p_day_start),0),
      'used_month',COALESCE(sum(credits_used),0))
    FROM core.enrichment_log WHERE business_id=p_business_id AND created_at>=p_month_start AND credits_used>0);
END $$;

CREATE FUNCTION public.go_leads_enrichment_pending_v1(p_business_id uuid,p_limit integer,p_lead_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'GO_INVALID_LIMIT' USING ERRCODE='22023'; END IF;
  RETURN COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',l.id,'email',l.email,
      'apollo_person_id',l.apollo_person_id,'metadata',l.metadata) ORDER BY l.created_at)
    FROM (SELECT * FROM core.b2b_leads WHERE business_id=p_business_id AND status='enrichment_pending'
      AND (p_lead_ids IS NULL OR id=ANY(p_lead_ids)) ORDER BY created_at LIMIT p_limit) l),'[]'::jsonb);
END $$;

CREATE FUNCTION public.go_enrichment_log_v1(p_business_id uuid,p_lead_id uuid,p_apollo_person_id text,
  p_credits_used integer,p_result text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF p_result NOT IN ('found','not_found','error') OR p_credits_used NOT IN (0,1)
    OR (p_lead_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM core.b2b_leads WHERE id=p_lead_id AND business_id=p_business_id)) THEN
    RAISE EXCEPTION 'GO_INVALID_ENRICHMENT_LOG' USING ERRCODE='22023'; END IF;
  INSERT INTO core.enrichment_log(business_id,b2b_lead_id,apollo_person_id,credits_used,result)
  VALUES(p_business_id,p_lead_id,p_apollo_person_id,p_credits_used,p_result);
END $$;

-- Each enrichment update applies only while the lead is still enrichment_pending.
CREATE FUNCTION public.go_lead_enrichment_note_v1(p_business_id uuid,p_lead_id uuid,p_metadata jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF pg_catalog.jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'GO_INVALID_METADATA' USING ERRCODE='22023'; END IF;
  UPDATE core.b2b_leads SET metadata=p_metadata,updated_at=pg_catalog.now()
    WHERE business_id=p_business_id AND id=p_lead_id AND status='enrichment_pending';
  RETURN FOUND;
END $$;

CREATE FUNCTION public.go_lead_enrichment_fail_v1(p_business_id uuid,p_lead_id uuid,p_metadata jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF pg_catalog.jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'GO_INVALID_METADATA' USING ERRCODE='22023'; END IF;
  UPDATE core.b2b_leads SET status='enrichment_failed',metadata=p_metadata,updated_at=pg_catalog.now()
    WHERE business_id=p_business_id AND id=p_lead_id AND status='enrichment_pending';
  RETURN FOUND;
END $$;

-- Verified email found: 'new', or 'enrichment_failed' with duplicate_of when another
-- lead of the same business already has that email.
CREATE FUNCTION public.go_lead_enrichment_found_v1(p_business_id uuid,p_lead_id uuid,p_email text,p_metadata jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_email text:=core.go_email_v1(p_email); v_duplicate uuid;
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF v_email IS NULL OR pg_catalog.jsonb_typeof(p_metadata) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'GO_INVALID_ENRICHMENT' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM core.b2b_leads WHERE business_id=p_business_id AND id=p_lead_id AND status='enrichment_pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('status','unchanged'); END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_business_id::text||':'||v_email,41));
  SELECT id INTO v_duplicate FROM core.b2b_leads WHERE business_id=p_business_id AND email=v_email AND id<>p_lead_id LIMIT 1;
  IF v_duplicate IS NOT NULL THEN
    UPDATE core.b2b_leads SET status='enrichment_failed',metadata=p_metadata||pg_catalog.jsonb_build_object('duplicate_of',v_duplicate),
      updated_at=pg_catalog.now() WHERE business_id=p_business_id AND id=p_lead_id;
    RETURN pg_catalog.jsonb_build_object('status','enrichment_failed','duplicate_of',v_duplicate);
  END IF;
  UPDATE core.b2b_leads SET email=v_email,status='new',updated_at=pg_catalog.now()
    WHERE business_id=p_business_id AND id=p_lead_id;
  RETURN pg_catalog.jsonb_build_object('status','new');
END $$;

-- 5. Leads: lookup, insert (new rows only), fill blank fields only.
CREATE FUNCTION public.go_leads_by_email_v1(p_business_id uuid,p_emails text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF COALESCE(pg_catalog.cardinality(p_emails),0)>1000 THEN RAISE EXCEPTION 'GO_TOO_MANY_EMAILS' USING ERRCODE='22023'; END IF;
  RETURN COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',l.id,'email',l.email,'status',l.status,
      'metadata',l.metadata,'contact_name',l.contact_name,'title',l.title,'company_name',l.company_name,
      'industry',l.industry,'employee_count',l.employee_count,'city',l.city,'state',l.state) ORDER BY l.email)
    FROM core.b2b_leads l WHERE l.business_id=p_business_id
      AND l.email=ANY(ARRAY(SELECT core.go_email_v1(e) FROM pg_catalog.unnest(p_emails) e))),'[]'::jsonb);
END $$;

CREATE FUNCTION public.go_suppressed_emails_v1(p_business_id uuid,p_emails text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF COALESCE(pg_catalog.cardinality(p_emails),0)>1000 THEN RAISE EXCEPTION 'GO_TOO_MANY_EMAILS' USING ERRCODE='22023'; END IF;
  RETURN COALESCE((SELECT pg_catalog.jsonb_agg(s.email ORDER BY s.email) FROM core.email_suppressions s
    WHERE s.business_id=p_business_id
      AND s.email=ANY(ARRAY(SELECT core.go_email_v1(e) FROM pg_catalog.unnest(p_emails) e))),'[]'::jsonb);
END $$;

-- Inserts new leads for this business only; an existing (business,email) or
-- (business,apollo_person_id) is left untouched. Omitted city/state/source/metadata
-- keep the table defaults, as the former direct insert did. Returns inserted ids.
CREATE FUNCTION public.go_leads_insert_v1(p_business_id uuid,p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r jsonb; v_id uuid; v_ids jsonb:='[]'::jsonb; v_email text;
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF pg_catalog.jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_rows) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'GO_INVALID_LEADS' USING ERRCODE='22023'; END IF;
  FOR r IN SELECT value FROM pg_catalog.jsonb_array_elements(p_rows) LOOP
    IF pg_catalog.jsonb_typeof(r)<>'object' OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(r) k
        WHERE k NOT IN ('email','company_name','contact_name','title','phone','industry','employee_count',
          'city','state','source','status','apollo_person_id','metadata'))
      OR COALESCE(r->>'status','') NOT IN ('new','on_hold','enrichment_pending')
      OR pg_catalog.length(pg_catalog.btrim(COALESCE(r->>'company_name','')))=0
      OR (r ? 'metadata' AND pg_catalog.jsonb_typeof(r->'metadata')<>'object')
      OR (r->>'email' IS NOT NULL AND core.go_email_v1(r->>'email') IS NULL)
      OR (r->>'email' IS NULL AND r->>'apollo_person_id' IS NULL) THEN
      RAISE EXCEPTION 'GO_INVALID_LEAD' USING ERRCODE='22023';
    END IF;
    v_email:=core.go_email_v1(r->>'email');
    INSERT INTO core.b2b_leads(business_id,email,company_name,contact_name,title,phone,industry,employee_count,
      city,state,source,status,apollo_person_id,metadata)
    VALUES(p_business_id,v_email,pg_catalog.btrim(r->>'company_name'),r->>'contact_name',r->>'title',r->>'phone',
      r->>'industry',(r->>'employee_count')::integer,
      CASE WHEN r ? 'city' THEN r->>'city' ELSE 'West Haven' END,
      CASE WHEN r ? 'state' THEN r->>'state' ELSE 'CT' END,
      CASE WHEN r ? 'source' THEN r->>'source' ELSE 'apollo' END,
      r->>'status',r->>'apollo_person_id',
      CASE WHEN r ? 'metadata' THEN r->'metadata' ELSE '{}'::jsonb END)
    ON CONFLICT DO NOTHING RETURNING id INTO v_id;
    IF v_id IS NOT NULL THEN v_ids:=v_ids||pg_catalog.to_jsonb(v_id); END IF;
    v_id:=NULL;
  END LOOP;
  RETURN v_ids;
END $$;

-- Fills only blank fields; metadata gains only missing keys. Status is never changed.
CREATE FUNCTION public.go_lead_fill_v1(p_business_id uuid,p_lead_id uuid,p_patch jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF pg_catalog.jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM pg_catalog.jsonb_object_keys(p_patch) k
      WHERE k NOT IN ('contact_name','title','company_name','industry','employee_count','city','state','metadata'))
    OR (p_patch ? 'metadata' AND pg_catalog.jsonb_typeof(p_patch->'metadata')<>'object') THEN
    RAISE EXCEPTION 'GO_INVALID_PATCH' USING ERRCODE='22023'; END IF;
  UPDATE core.b2b_leads l SET
    contact_name=COALESCE(NULLIF(pg_catalog.btrim(l.contact_name),''),p_patch->>'contact_name',l.contact_name),
    title=COALESCE(NULLIF(pg_catalog.btrim(l.title),''),p_patch->>'title',l.title),
    company_name=COALESCE(NULLIF(pg_catalog.btrim(l.company_name),''),NULLIF(pg_catalog.btrim(p_patch->>'company_name'),''),l.company_name),
    industry=COALESCE(NULLIF(pg_catalog.btrim(l.industry),''),p_patch->>'industry',l.industry),
    employee_count=COALESCE(l.employee_count,(p_patch->>'employee_count')::integer),
    city=COALESCE(NULLIF(pg_catalog.btrim(l.city),''),p_patch->>'city',l.city),
    state=COALESCE(NULLIF(pg_catalog.btrim(l.state),''),p_patch->>'state',l.state),
    metadata=COALESCE(p_patch->'metadata','{}'::jsonb)||COALESCE(l.metadata,'{}'::jsonb),
    updated_at=pg_catalog.now()
  WHERE l.business_id=p_business_id AND l.id=p_lead_id;
  RETURN FOUND;
END $$;

-- 6. Suppression: add only. An existing entry keeps its first reason; the lead
-- status follows (unsubscribed/bounced). Returns true when a new entry was added.
CREATE FUNCTION public.go_suppress_email_v1(p_business_id uuid,p_email text,p_reason text,p_source text,p_lead_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_email text:=core.go_email_v1(p_email); v_added boolean;
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF v_email IS NULL OR p_reason NOT IN ('unsubscribe_link','hard_bounce','complaint')
    OR p_source NOT IN ('email','resend_webhook') OR p_lead_status NOT IN ('unsubscribed','bounced') THEN
    RAISE EXCEPTION 'GO_INVALID_SUPPRESSION' USING ERRCODE='22023'; END IF;
  INSERT INTO core.email_suppressions(business_id,email,reason,source) VALUES(p_business_id,v_email,p_reason,p_source)
    ON CONFLICT (business_id,email) DO NOTHING;
  v_added:=FOUND;
  UPDATE core.b2b_leads SET status=p_lead_status,updated_at=pg_catalog.now()
    WHERE business_id=p_business_id AND email=v_email AND status<>p_lead_status;
  RETURN v_added;
END $$;

-- 7. Read-only verification: lead counts by status, suppressions, settings row.
CREATE FUNCTION public.go_platform_verify_v1(p_business_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  RETURN pg_catalog.jsonb_build_object('business_id',p_business_id,
    'leads_total',(SELECT count(*) FROM core.b2b_leads WHERE business_id=p_business_id),
    'leads_by_status',COALESCE((SELECT pg_catalog.jsonb_object_agg(status,n) FROM
      (SELECT status,count(*) n FROM core.b2b_leads WHERE business_id=p_business_id GROUP BY status) x),'{}'::jsonb),
    'suppressions',(SELECT count(*) FROM core.email_suppressions WHERE business_id=p_business_id),
    'outreach_settings_rows',(SELECT count(*) FROM core.outreach_settings WHERE business_id=p_business_id),
    'outreach_settings',public.go_outreach_settings_get_v1(p_business_id));
END $$;

REVOKE ALL ON FUNCTION core.go_scope_v1(uuid),core.go_email_v1(text) FROM PUBLIC,anon,authenticated,service_role;
DO $grants$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'go\_%\_v1' LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
  END LOOP;
END $grants$;

DO $post$ BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'go\_%\_v1' AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=""']
        AND pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE'))<>18
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
  THEN RAISE EXCEPTION 'GO_ACCESS_POSTCHECK_FAILED'; END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;

-- ===== GERI ALMA BOLUMU =====
-- Calistirilacak dosya: supabase/rollbacks/20261030000400_go_platform_access_down.sql
-- Yalniz bu migration'in 20 fonksiyonunu kaldirir; tablolara ve verilere dokunmaz.
-- Geri almadan once GO Worker durdurulmali ya da eski projeye dondurulmelidir;
-- aksi halde GO'nun her veritabani cagrisi hata verir (core kapali kalir).
-- Icerik (ayni sirayla):
--   BEGIN;
--   DROP FUNCTION public.go_platform_verify_v1(uuid), public.go_suppress_email_v1(uuid,text,text,text,text),
--     public.go_lead_fill_v1(uuid,uuid,jsonb), public.go_leads_insert_v1(uuid,jsonb),
--     public.go_suppressed_emails_v1(uuid,text[]), public.go_leads_by_email_v1(uuid,text[]),
--     public.go_lead_enrichment_found_v1(uuid,uuid,text,jsonb), public.go_lead_enrichment_fail_v1(uuid,uuid,jsonb),
--     public.go_lead_enrichment_note_v1(uuid,uuid,jsonb), public.go_enrichment_log_v1(uuid,uuid,text,integer,text),
--     public.go_leads_enrichment_pending_v1(uuid,integer,uuid[]),
--     public.go_enrichment_credits_used_v1(uuid,timestamptz,timestamptz),
--     public.go_outreach_business_ids_v1(), public.go_outreach_settings_get_v1(uuid),
--     public.go_business_check_v1(uuid), public.go_api_key_revoke_v1(text),
--     public.go_api_key_create_v1(text,text,text,uuid[]), public.go_api_key_authorize_v1(text,uuid);
--   DROP FUNCTION core.go_email_v1(text), core.go_scope_v1(uuid);
--   COMMIT;
