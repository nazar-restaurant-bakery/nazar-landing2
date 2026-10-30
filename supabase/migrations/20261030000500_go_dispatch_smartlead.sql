-- Faz 1 / Gorev 6 + 7: GO gonderimi tek 168 saat kapisindan ve Smartlead uzerinden.
-- LF bytes, psql 18.6. Sira 32; sira 31 (20261030000400_go_platform_access) gerekir.
-- * Tek kapi: platformdaki core.message_log + core.message_send_settings (168 saat).
--   B2B kapi fonksiyonlari ayni tabloyu ve ayni araligi kullanir; adayin kendi
--   gecmisini ve ayni adrese giden her mesaji (musteri dahil) gorur. K6 musteri
--   fonksiyonlari ve sira 31 fonksiyonlari degismez.
-- * Smartlead: her dizi adimi (gun 1, 8, 15) tek adimli bir kampanya. Kayit
--   EMAIL_SENT ile 'sent' olur; sonraki adim 7 gun sonra ve yine kapidan gecer.
-- * Cevap diziyi durdurur ('replied'); geri donme ve cikis engel listesine ekler.
-- * Bekleyen (on_hold), engelli, cevap vermis adaylar secilmez; gunluk sinir korunur.
-- * Engel listesinden silen fonksiyon yoktur. EXECUTE yalniz service_role; her
--   fonksiyon business_id ile sinirli (webhook kampanya->isletme eslemesi haric).
-- Geri alma: supabase/rollbacks/20261030000500_go_dispatch_smartlead_down.sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('go_dispatch_smartlead_v1',0));

DO $guard$ BEGIN
  IF pg_catalog.to_regprocedure('core.go_scope_v1(uuid)') IS NULL
    OR pg_catalog.to_regprocedure('core.go_email_v1(text)') IS NULL
    OR pg_catalog.to_regprocedure('public.go_platform_verify_v1(uuid)') IS NULL
    OR pg_catalog.to_regclass('core.message_send_settings') IS NULL
    OR pg_catalog.to_regclass('core.b2b_leads') IS NULL
    OR pg_catalog.to_regclass('core.outreach_settings') IS NULL
    OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='core'
      AND table_name='message_log' AND column_name='b2b_lead_id')
  THEN RAISE EXCEPTION 'GO_DISPATCH_SEQUENCE_31_REQUIRED'; END IF;
  IF pg_catalog.has_schema_privilege('anon','core','USAGE')
    OR pg_catalog.has_schema_privilege('authenticated','core','USAGE')
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
  THEN RAISE EXCEPTION 'GO_DISPATCH_CORE_MUST_BE_PRIVATE'; END IF;
  IF (SELECT pg_catalog.pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint
      WHERE conrelid='core.b2b_leads'::regclass AND conname='b2b_leads_status_check') IS DISTINCT FROM
    $c$CHECK ((status = ANY (ARRAY['enrichment_pending'::text, 'enrichment_failed'::text, 'new'::text, 'contacted'::text, 'qualified'::text, 'converted'::text, 'unsubscribed'::text, 'bounced'::text, 'on_hold'::text])))$c$
    OR pg_catalog.to_regclass('core.b2b_dispatches') IS NOT NULL
    OR pg_catalog.to_regclass('core.b2b_outreach_events') IS NOT NULL
    OR EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='core'
      AND table_name='outreach_settings' AND column_name='smartlead_campaign_ids')
  THEN RAISE EXCEPTION 'GO_DISPATCH_ALREADY_INSTALLED_OR_UNEXPECTED'; END IF;
END $guard$;

-- A reply ends the sequence: new lead status 'replied'.
ALTER TABLE core.b2b_leads DROP CONSTRAINT b2b_leads_status_check,
  ADD CONSTRAINT b2b_leads_status_check CHECK (status IN ('enrichment_pending','enrichment_failed','new',
    'contacted','replied','qualified','converted','unsubscribed','bounced','on_hold'));
-- Smartlead campaign per sequence step (1, 2, 3); each campaign has one step.
ALTER TABLE core.outreach_settings ADD COLUMN smartlead_campaign_ids bigint[]
  CHECK (smartlead_campaign_ids IS NULL OR (pg_catalog.cardinality(smartlead_campaign_ids)=3
    AND pg_catalog.array_position(smartlead_campaign_ids,NULL) IS NULL));

-- One row per gate reservation handed to Smartlead (message_log row is the gate record).
CREATE TABLE core.b2b_dispatches (
  message_id uuid PRIMARY KEY REFERENCES core.message_log(id),
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  b2b_lead_id uuid NOT NULL REFERENCES core.b2b_leads(id),
  step smallint NOT NULL CHECK (step BETWEEN 1 AND 3),
  campaign_id bigint NOT NULL CHECK (campaign_id>0),
  smartlead_lead_id bigint,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
CREATE INDEX b2b_dispatches_lead ON core.b2b_dispatches(business_id,b2b_lead_id,campaign_id);
-- Webhook receipts: idempotent on event_key; unmatched events are kept, not dropped.
CREATE TABLE core.b2b_outreach_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES core.businesses(id),
  event_key text NOT NULL CHECK (event_key ~ '^[0-9a-f]{64}$'),
  event_type text NOT NULL CHECK (event_type IN ('EMAIL_SENT','EMAIL_REPLY','EMAIL_BOUNCE','LEAD_UNSUBSCRIBED')),
  campaign_id bigint NOT NULL,
  b2b_lead_id uuid REFERENCES core.b2b_leads(id),
  outcome text NOT NULL CHECK (outcome ~ '^[a-z0-9_]{3,40}$'),
  provider_message_id text CHECK (pg_catalog.length(provider_message_id)<=300),
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (business_id,event_key)
);
ALTER TABLE core.b2b_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.b2b_outreach_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.b2b_dispatches,core.b2b_outreach_events FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE core.b2b_outreach_events_id_seq FROM PUBLIC,anon,authenticated,service_role;

-- Suppression for webhook events: add only; lead status follows, next step cleared.
CREATE FUNCTION core.go_suppress_v1(p_business_id uuid,p_email text,p_reason text,p_lead_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_email text:=core.go_email_v1(p_email); v_added boolean;
BEGIN
  IF v_email IS NULL OR p_reason NOT IN ('hard_bounce','smartlead_unsubscribe')
    OR p_lead_status NOT IN ('unsubscribed','bounced') THEN
    RAISE EXCEPTION 'GO_INVALID_SUPPRESSION' USING ERRCODE='22023'; END IF;
  INSERT INTO core.email_suppressions(business_id,email,reason,source)
    VALUES(p_business_id,v_email,p_reason,'smartlead_webhook') ON CONFLICT (business_id,email) DO NOTHING;
  v_added:=FOUND;
  UPDATE core.b2b_leads SET status=p_lead_status,next_step_at=NULL,updated_at=pg_catalog.now()
    WHERE business_id=p_business_id AND email=v_email AND status<>p_lead_status;
  RETURN v_added;
END $$;

-- Same window as K6: pending messages always block; a sent one blocks for
-- min_interval_hours (168). Covers the lead's own history and every message
-- (customer or lead) to the same recipient address. No settings row = blocked.
CREATE FUNCTION core.go_b2b_window_blocked_v1(p_business_id uuid,p_lead_id uuid,p_recipient_sha256 text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT COALESCE((SELECT NOT s.enabled OR EXISTS(
    SELECT 1 FROM core.message_log m
    WHERE m.business_id=p_business_id AND (m.b2b_lead_id=p_lead_id OR m.recipient_sha256=p_recipient_sha256)
      AND (m.status IN ('reserved','claimed','sending','unknown')
        OR (m.status='sent' AND m.sent_at>pg_catalog.clock_timestamp()-pg_catalog.make_interval(hours=>s.min_interval_hours))))
    FROM core.message_send_settings s WHERE s.business_id=p_business_id),true)
$$;

-- Messages counted against outreach_settings.daily_send_limit for the local day.
CREATE FUNCTION core.go_sent_today_v1(p_business_id uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT count(*)::integer FROM core.message_log m JOIN core.outreach_settings s ON s.business_id=m.business_id
  WHERE m.business_id=p_business_id AND m.b2b_lead_id IS NOT NULL AND m.status<>'blocked'
    AND m.reserved_at>=((pg_catalog.clock_timestamp() AT TIME ZONE s.timezone)::date::timestamp AT TIME ZONE s.timezone)
$$;

CREATE FUNCTION public.go_dispatch_quota_v1(p_business_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_limit integer; v_sent integer;
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  SELECT daily_send_limit INTO v_limit FROM core.outreach_settings WHERE business_id=p_business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'GO_SETTINGS_MISSING' USING ERRCODE='22023'; END IF;
  v_sent:=core.go_sent_today_v1(p_business_id);
  RETURN pg_catalog.jsonb_build_object('daily_limit',v_limit,'sent_today',v_sent,'remaining',GREATEST(0,v_limit-v_sent));
END $$;

-- Due leads with the step to send: address present, 'new' at step 0 or 'contacted'
-- with the next step due; never on_hold/replied/unsubscribed/bounced, suppressed or
-- pending. p_lead_id narrows to one lead (manual trigger). The gate rechecks all.
CREATE FUNCTION public.go_dispatch_due_v1(p_business_id uuid,p_limit integer,p_lead_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'GO_INVALID_LIMIT' USING ERRCODE='22023'; END IF;
  RETURN COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',x.id,'step',x.sequence_step+1,
      'email',x.email,'contact_name',x.contact_name,'company_name',x.company_name)) FROM (
    SELECT l.* FROM core.b2b_leads l
    WHERE l.business_id=p_business_id AND l.email IS NOT NULL AND (p_lead_id IS NULL OR l.id=p_lead_id)
      AND ((l.status='new' AND l.sequence_step=0)
        OR (l.status='contacted' AND l.sequence_step BETWEEN 1 AND 2 AND l.next_step_at<=pg_catalog.now()))
      AND NOT EXISTS(SELECT 1 FROM core.email_suppressions s WHERE s.business_id=p_business_id AND s.email=l.email)
      AND NOT EXISTS(SELECT 1 FROM core.message_log m WHERE m.business_id=p_business_id AND m.b2b_lead_id=l.id
        AND m.status IN ('reserved','claimed','sending','unknown'))
    ORDER BY l.next_step_at NULLS FIRST,l.created_at LIMIT p_limit) x),'[]'::jsonb);
END $$;

-- Gate: one atomic decision per lead and step. Allowed -> a message_log row in
-- 'sending' (lease issued) plus a b2b_dispatches row. Codes when refused:
-- lead_not_found, missing_email, suppressed, status_<s>, not_due,
-- campaign_not_configured, settings_disabled, daily_limit_reached, frequency_limited.
CREATE FUNCTION public.go_dispatch_reserve_v1(p_business_id uuid,p_lead_id uuid,p_step integer,p_payload_sha256 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE l core.b2b_leads%ROWTYPE; v_campaign bigint; v_limit integer; v_recipient text; v_key text;
  v_now timestamptz; v_lease uuid:=gen_random_uuid(); v_id uuid;
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF p_step IS NULL OR p_step NOT BETWEEN 1 AND 3 OR COALESCE(p_payload_sha256,'') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'GO_INVALID_DISPATCH' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_business_id::text||':go_dispatch',6010));
  SELECT * INTO l FROM core.b2b_leads WHERE id=p_lead_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('allowed',false,'code','lead_not_found'); END IF;
  IF l.email IS NULL THEN RETURN pg_catalog.jsonb_build_object('allowed',false,'code','missing_email'); END IF;
  IF EXISTS(SELECT 1 FROM core.email_suppressions WHERE business_id=p_business_id AND email=l.email) THEN
    UPDATE core.b2b_leads SET status='unsubscribed',next_step_at=NULL,updated_at=pg_catalog.now()
      WHERE id=l.id AND status NOT IN ('unsubscribed','bounced');
    RETURN pg_catalog.jsonb_build_object('allowed',false,'code','suppressed');
  END IF;
  IF NOT ((p_step=1 AND l.status='new' AND l.sequence_step=0)
      OR (p_step>1 AND l.status='contacted' AND l.sequence_step=p_step-1)) THEN
    RETURN pg_catalog.jsonb_build_object('allowed',false,'code','status_'||l.status); END IF;
  IF p_step>1 AND (l.next_step_at IS NULL OR l.next_step_at>pg_catalog.now()) THEN
    RETURN pg_catalog.jsonb_build_object('allowed',false,'code','not_due'); END IF;
  SELECT smartlead_campaign_ids[p_step],daily_send_limit INTO v_campaign,v_limit
    FROM core.outreach_settings WHERE business_id=p_business_id;
  IF v_campaign IS NULL THEN RETURN pg_catalog.jsonb_build_object('allowed',false,'code','campaign_not_configured'); END IF;
  IF NOT EXISTS(SELECT 1 FROM core.message_send_settings WHERE business_id=p_business_id AND enabled) THEN
    RETURN pg_catalog.jsonb_build_object('allowed',false,'code','settings_disabled'); END IF;
  IF core.go_sent_today_v1(p_business_id)>=v_limit THEN
    RETURN pg_catalog.jsonb_build_object('allowed',false,'code','daily_limit_reached'); END IF;
  v_recipient:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(l.email,'UTF8')),'hex');
  IF core.go_b2b_window_blocked_v1(p_business_id,l.id,v_recipient) THEN
    RETURN pg_catalog.jsonb_build_object('allowed',false,'code','frequency_limited'); END IF;
  v_key:='go.b2b:'||l.id::text||':s'||p_step||':a'||(1+(SELECT count(*) FROM core.b2b_dispatches
    WHERE business_id=p_business_id AND b2b_lead_id=l.id AND step=p_step));
  v_now:=pg_catalog.clock_timestamp();
  INSERT INTO core.message_log(business_id,b2b_lead_id,message_key,message_kind,payload_sha256,recipient_sha256,
    identity_sha256,status,lease_id,reserved_at,reservation_expires_at,claimed_at,dispatch_expires_at,dispatch_authorized_at)
  VALUES(p_business_id,l.id,v_key,'campaign',p_payload_sha256,v_recipient,
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('b2b:'||l.id::text,'UTF8')),'hex'),
    'sending',v_lease,v_now,v_now+interval '5 minutes',v_now,v_now+interval '10 minutes',v_now)
  RETURNING id INTO v_id;
  INSERT INTO core.b2b_dispatches(message_id,business_id,b2b_lead_id,step,campaign_id) VALUES(v_id,p_business_id,l.id,p_step,v_campaign);
  RETURN pg_catalog.jsonb_build_object('allowed',true,'code','reserved','message_id',v_id,'lease_id',v_lease,
    'campaign_id',v_campaign,'step',p_step,'email',l.email,'contact_name',l.contact_name,'company_name',l.company_name);
END $$;

-- Provider answer for a reservation. accepted: stays 'sending' until EMAIL_SENT;
-- rejected: 'blocked' (no email left); unknown: 'unknown' (blocks the lead, review).
CREATE FUNCTION public.go_dispatch_result_v1(p_business_id uuid,p_message_id uuid,p_lease_id uuid,
  p_outcome text,p_smartlead_lead_id bigint DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE m core.message_log%ROWTYPE;
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF p_outcome IS NULL OR p_outcome NOT IN ('accepted','rejected','unknown') THEN
    RAISE EXCEPTION 'GO_INVALID_OUTCOME' USING ERRCODE='22023'; END IF;
  SELECT * INTO m FROM core.message_log WHERE id=p_message_id AND business_id=p_business_id FOR UPDATE;
  IF NOT FOUND OR m.b2b_lead_id IS NULL OR m.lease_id IS DISTINCT FROM p_lease_id
    OR NOT EXISTS(SELECT 1 FROM core.b2b_dispatches WHERE message_id=m.id) THEN
    RAISE EXCEPTION 'GO_INVALID_LEASE' USING ERRCODE='42501'; END IF;
  IF m.status<>'sending' THEN RETURN pg_catalog.jsonb_build_object('status',m.status,'idempotent',true); END IF;
  IF p_outcome='accepted' THEN
    UPDATE core.b2b_dispatches SET accepted_at=COALESCE(accepted_at,pg_catalog.now()),
      smartlead_lead_id=COALESCE(smartlead_lead_id,p_smartlead_lead_id) WHERE message_id=m.id;
    RETURN pg_catalog.jsonb_build_object('status','sending','idempotent',false);
  END IF;
  UPDATE core.message_log SET status=CASE p_outcome WHEN 'rejected' THEN 'blocked' ELSE 'unknown' END,
    last_code=CASE p_outcome WHEN 'rejected' THEN 'blocked' ELSE 'unknown' END,
    finished_at=pg_catalog.clock_timestamp(),updated_at=pg_catalog.clock_timestamp() WHERE id=m.id;
  RETURN pg_catalog.jsonb_build_object('status',CASE p_outcome WHEN 'rejected' THEN 'blocked' ELSE 'unknown' END,'idempotent',false);
END $$;

-- Webhook campaign -> business. Returns only the identifier.
CREATE FUNCTION public.go_smartlead_business_v1(p_campaign_id bigint) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  RETURN (SELECT business_id FROM core.outreach_settings WHERE p_campaign_id=ANY(smartlead_campaign_ids) LIMIT 1);
END $$;

CREATE FUNCTION public.go_smartlead_campaigns_set_v1(p_business_id uuid,p_campaign_ids bigint[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF COALESCE(pg_catalog.cardinality(p_campaign_ids),0)<>3 OR pg_catalog.array_position(p_campaign_ids,NULL) IS NOT NULL
    OR (SELECT count(DISTINCT c) FROM pg_catalog.unnest(p_campaign_ids) c WHERE c>0)<>3
    OR EXISTS(SELECT 1 FROM core.outreach_settings WHERE business_id<>p_business_id AND smartlead_campaign_ids && p_campaign_ids) THEN
    RAISE EXCEPTION 'GO_INVALID_CAMPAIGNS' USING ERRCODE='22023'; END IF;
  UPDATE core.outreach_settings SET smartlead_campaign_ids=p_campaign_ids,updated_at=pg_catalog.now() WHERE business_id=p_business_id;
  RETURN FOUND;
END $$;

-- Smartlead webhook event (authenticated by the Worker). The lead is the candidate
-- address that has a dispatch in this campaign. Idempotent on event_key.
-- EMAIL_SENT finalizes the gate record ('sent') and schedules the next step after
-- 7 days (day 1/8/15); EMAIL_REPLY stops the sequence; EMAIL_BOUNCE and
-- LEAD_UNSUBSCRIBED add the address to the suppression list.
CREATE FUNCTION public.go_smartlead_event_v1(p_business_id uuid,p_campaign_id bigint,p_event_type text,
  p_emails text[],p_event_key text,p_provider_message_id text DEFAULT NULL,p_occurred_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_event bigint; l core.b2b_leads%ROWTYPE; d core.b2b_dispatches%ROWTYPE; v_outcome text; v_now timestamptz;
BEGIN
  PERFORM core.go_scope_v1(p_business_id);
  IF p_event_type IS NULL OR p_event_type NOT IN ('EMAIL_SENT','EMAIL_REPLY','EMAIL_BOUNCE','LEAD_UNSUBSCRIBED')
    OR COALESCE(p_event_key,'') !~ '^[0-9a-f]{64}$' OR p_campaign_id IS NULL THEN
    RAISE EXCEPTION 'GO_INVALID_EVENT' USING ERRCODE='22023'; END IF;
  INSERT INTO core.b2b_outreach_events(business_id,event_key,event_type,campaign_id,outcome,provider_message_id,occurred_at)
  VALUES(p_business_id,p_event_key,p_event_type,p_campaign_id,'received',pg_catalog.left(p_provider_message_id,300),p_occurred_at)
  ON CONFLICT (business_id,event_key) DO NOTHING RETURNING id INTO v_event;
  IF v_event IS NULL THEN RETURN pg_catalog.jsonb_build_object('outcome','duplicate'); END IF;
  IF NOT EXISTS(SELECT 1 FROM core.outreach_settings WHERE business_id=p_business_id AND p_campaign_id=ANY(smartlead_campaign_ids)) THEN
    v_outcome:='unknown_campaign';
  ELSE
    SELECT ld.* INTO l FROM core.b2b_leads ld
      WHERE ld.business_id=p_business_id
        AND ld.email=ANY(ARRAY(SELECT core.go_email_v1(e) FROM pg_catalog.unnest(p_emails) e))
        AND EXISTS(SELECT 1 FROM core.b2b_dispatches x WHERE x.b2b_lead_id=ld.id AND x.campaign_id=p_campaign_id)
      LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN v_outcome:='unmatched';
    ELSIF p_event_type='EMAIL_SENT' THEN
      SELECT x.* INTO d FROM core.b2b_dispatches x JOIN core.message_log m ON m.id=x.message_id
        WHERE x.b2b_lead_id=l.id AND x.campaign_id=p_campaign_id AND m.status='sending'
        ORDER BY x.created_at DESC LIMIT 1;
      IF NOT FOUND THEN v_outcome:='no_pending_dispatch';
      ELSE
        v_now:=pg_catalog.clock_timestamp();
        UPDATE core.message_log SET status='sent',sent_at=v_now,finished_at=v_now,last_code=NULL,updated_at=v_now
          WHERE id=d.message_id;
        UPDATE core.b2b_leads SET status='contacted',sequence_step=d.step,
          next_step_at=CASE WHEN d.step<3 THEN v_now+interval '7 days' END,updated_at=pg_catalog.now()
          WHERE id=l.id AND status IN ('new','contacted');
        v_outcome:='sent_step_'||d.step;
      END IF;
    ELSIF p_event_type='EMAIL_REPLY' THEN
      UPDATE core.b2b_leads SET status='replied',next_step_at=NULL,updated_at=pg_catalog.now()
        WHERE id=l.id AND status IN ('new','contacted');
      v_outcome:='sequence_stopped';
    ELSIF p_event_type='EMAIL_BOUNCE' THEN
      PERFORM core.go_suppress_v1(p_business_id,l.email,'hard_bounce','bounced');
      v_outcome:='suppressed_bounce';
    ELSE
      PERFORM core.go_suppress_v1(p_business_id,l.email,'smartlead_unsubscribe','unsubscribed');
      v_outcome:='suppressed_unsubscribe';
    END IF;
  END IF;
  UPDATE core.b2b_outreach_events SET outcome=v_outcome,b2b_lead_id=l.id WHERE id=v_event;
  RETURN pg_catalog.jsonb_build_object('outcome',v_outcome,'b2b_lead_id',l.id);
END $$;

REVOKE ALL ON FUNCTION core.go_suppress_v1(uuid,text,text,text),core.go_b2b_window_blocked_v1(uuid,uuid,text),
  core.go_sent_today_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.go_dispatch_quota_v1(uuid),public.go_dispatch_due_v1(uuid,integer,uuid),
  public.go_dispatch_reserve_v1(uuid,uuid,integer,text),public.go_dispatch_result_v1(uuid,uuid,uuid,text,bigint),
  public.go_smartlead_business_v1(bigint),public.go_smartlead_campaigns_set_v1(uuid,bigint[]),
  public.go_smartlead_event_v1(uuid,bigint,text,text[],text,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.go_dispatch_quota_v1(uuid),public.go_dispatch_due_v1(uuid,integer,uuid),
  public.go_dispatch_reserve_v1(uuid,uuid,integer,text),public.go_dispatch_result_v1(uuid,uuid,uuid,text,bigint),
  public.go_smartlead_business_v1(bigint),public.go_smartlead_campaigns_set_v1(uuid,bigint[]),
  public.go_smartlead_event_v1(uuid,bigint,text,text[],text,text,timestamptz) TO service_role;

DO $post$ BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'go\_%\_v1' AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=""']
        AND pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
        AND NOT pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE'))<>25
    OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
  THEN RAISE EXCEPTION 'GO_DISPATCH_POSTCHECK_FAILED'; END IF;
END $post$;
NOTIFY pgrst,'reload schema';
COMMIT;
