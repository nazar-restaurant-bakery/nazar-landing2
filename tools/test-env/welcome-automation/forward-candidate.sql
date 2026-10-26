-- FORWARD CANDIDATE ONLY. No canonical migration sequence, seed, cron, key or enable.
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF to_regprocedure('public.coupon_welcome_claim_v1(uuid,uuid)') IS NULL
 OR to_regclass('core.coupon_bootstrap_permits') IS NULL
 OR to_regclass('core.coupon_delivery_receipts') IS NULL THEN
 RAISE EXCEPTION 'COUPON_AUTOMATION_BASE_REQUIRED'; END IF;
END $$;
CREATE TABLE core.coupon_automation_settings (
 business_id uuid PRIMARY KEY REFERENCES core.businesses(id),enabled boolean NOT NULL DEFAULT false,
 receipt_limit integer NOT NULL DEFAULT 3 CHECK(receipt_limit BETWEEN 0 AND 3),
 receipt_check_limit integer NOT NULL DEFAULT 24 CHECK(receipt_check_limit BETWEEN 1 AND 48),
 review_ref text NOT NULL DEFAULT 'unreviewed-disabled' CHECK(review_ref ~ '^[A-Za-z0-9_.:/-]{8,160}$'),
 CHECK(NOT enabled OR review_ref<>'unreviewed-disabled')
);
CREATE TABLE core.coupon_automation_runs (
 business_id uuid NOT NULL REFERENCES core.businesses(id),run_id uuid NOT NULL,run_token uuid NOT NULL DEFAULT gen_random_uuid(),
 state text NOT NULL DEFAULT 'active' CHECK(state IN('active','finished','expired')),
 dispatch_claims integer NOT NULL DEFAULT 0 CHECK(dispatch_claims BETWEEN 0 AND 1),
 receipt_claims integer NOT NULL DEFAULT 0 CHECK(receipt_claims BETWEEN 0 AND 3),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '180 seconds',
 finished_at timestamptz,PRIMARY KEY(business_id,run_id),UNIQUE(run_token),CHECK(expires_at>created_at)
);
CREATE UNIQUE INDEX coupon_automation_one_active_business ON core.coupon_automation_runs(business_id) WHERE state='active';
CREATE TABLE core.coupon_automation_dispatch_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL REFERENCES core.businesses(id),
 coupon_id uuid NOT NULL UNIQUE REFERENCES core.campaign_coupons(id),run_id uuid NOT NULL,
 outcome text NOT NULL DEFAULT 'attempted' CHECK(outcome IN('attempted','provider_accepted','unknown','blocked')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),finished_at timestamptz,
 FOREIGN KEY(business_id,run_id) REFERENCES core.coupon_automation_runs(business_id,run_id)
);
CREATE TABLE core.coupon_automation_receipt_polls (
 binding_id uuid PRIMARY KEY REFERENCES core.coupon_delivery_bindings(id),business_id uuid NOT NULL REFERENCES core.businesses(id),
 coupon_id uuid NOT NULL REFERENCES core.campaign_coupons(id),last_run_id uuid NOT NULL,
 checks integer NOT NULL CHECK(checks BETWEEN 1 AND 48),next_check_at timestamptz NOT NULL,
 outcome text NOT NULL DEFAULT 'pending' CHECK(outcome IN('pending','delivered','unknown')),
 FOREIGN KEY(business_id,last_run_id) REFERENCES core.coupon_automation_runs(business_id,run_id)
);
CREATE FUNCTION core.coupon_automation_attempt_guard_v1() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP IN('DELETE','TRUNCATE') THEN RAISE EXCEPTION 'Immutable dispatch attempt' USING ERRCODE='42501';END IF;
 IF ROW(NEW.id,NEW.business_id,NEW.coupon_id,NEW.run_id,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.business_id,OLD.coupon_id,OLD.run_id,OLD.created_at)
 OR OLD.outcome<>'attempted' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Immutable dispatch attempt' USING ERRCODE='42501';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER coupon_automation_attempt_update BEFORE UPDATE OR DELETE ON core.coupon_automation_dispatch_attempts FOR EACH ROW EXECUTE FUNCTION core.coupon_automation_attempt_guard_v1();
CREATE TRIGGER coupon_automation_attempt_truncate BEFORE TRUNCATE ON core.coupon_automation_dispatch_attempts FOR EACH STATEMENT EXECUTE FUNCTION core.coupon_automation_attempt_guard_v1();
ALTER TABLE core.coupon_automation_dispatch_attempts ENABLE ALWAYS TRIGGER coupon_automation_attempt_update;
ALTER TABLE core.coupon_automation_dispatch_attempts ENABLE ALWAYS TRIGGER coupon_automation_attempt_truncate;
CREATE FUNCTION core.coupon_automation_run_private_v1(p_business_id uuid,p_run_id uuid,p_run_token uuid) RETURNS core.coupon_automation_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.coupon_automation_runs;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM core.coupon_automation_runs WHERE business_id=p_business_id AND run_id=p_run_id FOR UPDATE;
 IF r.run_id IS NULL OR r.run_token IS DISTINCT FROM p_run_token OR r.state<>'active' OR r.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Run unavailable' USING ERRCODE='42501';END IF;
 RETURN r;
END $$;
CREATE FUNCTION public.coupon_automation_start_v1(p_business_id uuid,p_run_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.coupon_automation_runs;s core.coupon_automation_settings;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 IF p_business_id IS NULL OR p_run_id IS NULL THEN RAISE EXCEPTION 'Invalid input' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('coupon-automation:'||p_business_id::text,260026));
 SELECT * INTO s FROM core.coupon_automation_settings WHERE business_id=p_business_id;
 IF s.business_id IS NULL OR NOT s.enabled THEN RETURN jsonb_build_object('allowed',false,'code','disabled');END IF;
 IF EXISTS(SELECT FROM core.coupon_automation_runs WHERE business_id=p_business_id AND run_id=p_run_id) THEN RETURN jsonb_build_object('allowed',false,'code','replay');END IF;
 IF EXISTS(SELECT FROM core.coupon_automation_runs WHERE business_id=p_business_id AND state='active' AND expires_at>clock_timestamp()) THEN RETURN jsonb_build_object('allowed',false,'code','busy');END IF;
 UPDATE core.coupon_automation_runs SET state='expired',finished_at=clock_timestamp() WHERE business_id=p_business_id AND state='active';
 INSERT INTO core.coupon_automation_runs(business_id,run_id) VALUES(p_business_id,p_run_id) RETURNING * INTO r;
 RETURN jsonb_build_object('allowed',true,'code','claimed','runToken',r.run_token,'dispatchLimit',1,'receiptLimit',s.receipt_limit,'expiresAt',r.expires_at);
END $$;
CREATE FUNCTION public.coupon_automation_next_v1(p_business_id uuid,p_run_id uuid,p_run_token uuid,p_kind text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.coupon_automation_runs;s core.coupon_automation_settings;j core.coupon_welcome_outbox;a core.coupon_automation_dispatch_attempts;
 b core.coupon_delivery_bindings;cp uuid;poll core.coupon_automation_receipt_polls;
BEGIN
 r:=core.coupon_automation_run_private_v1(p_business_id,p_run_id,p_run_token);
 SELECT * INTO s FROM core.coupon_automation_settings WHERE business_id=p_business_id;
 IF NOT coalesce(s.enabled,false) THEN RETURN jsonb_build_object('allowed',false,'code','paused');END IF;
 IF r.expires_at<=clock_timestamp()+interval '45 seconds' THEN RETURN jsonb_build_object('allowed',false,'code','deadline');END IF;
 IF p_kind='dispatch' THEN
  IF r.dispatch_claims>=1 THEN RETURN jsonb_build_object('allowed',false,'code','limit');END IF;
  IF NOT EXISTS(SELECT FROM core.message_send_settings WHERE business_id=p_business_id AND enabled)
  OR NOT EXISTS(SELECT FROM core.coupon_delivery_settings WHERE business_id=p_business_id AND enabled)
  OR EXISTS(SELECT FROM core.coupon_bootstrap_permits bp WHERE bp.business_id=p_business_id AND NOT(bp.state='delivered' AND EXISTS(
    SELECT FROM core.coupon_delivery_settings ds JOIN core.coupon_delivery_bindings db ON db.job_id=bp.job_id
    WHERE ds.business_id=p_business_id AND ds.enabled AND ds.account_id=bp.account_id AND ds.flow_id<>db.flow_id)))
  THEN RETURN jsonb_build_object('allowed',false,'code','normal_setup_pending');END IF;
  SELECT q.* INTO j FROM core.coupon_welcome_outbox q
  JOIN core.campaign_coupons c ON c.id=q.coupon_id AND c.business_id=q.business_id
  JOIN core.customers u ON u.id=c.customer_id AND u.business_id=c.business_id
  JOIN core.campaigns ca ON ca.id=c.campaign_id AND ca.business_id=c.business_id
  WHERE q.business_id=p_business_id AND q.status='queued' AND NOT c.is_test AND NOT u.is_test AND NOT ca.is_test
  AND u.email_status='subscribed' AND u.email_suppressed_at IS NULL AND c.state='issued'
  AND(c.expires_at IS NULL OR c.expires_at>clock_timestamp()) AND ca.status='active'
  AND ca.starts_at<=clock_timestamp() AND(ca.ends_at IS NULL OR ca.ends_at>clock_timestamp())
  AND NOT core.message_send_window_blocked_v1(p_business_id,u.id,NULL)
  AND NOT EXISTS(SELECT FROM core.coupon_bootstrap_permits bp WHERE bp.job_id=q.id)
  AND NOT EXISTS(SELECT FROM core.coupon_automation_dispatch_attempts d WHERE d.coupon_id=q.coupon_id)
  ORDER BY q.created_at,q.id LIMIT 1 FOR UPDATE OF q SKIP LOCKED;
  IF j.id IS NULL THEN RETURN jsonb_build_object('allowed',false,'code','queue_empty');END IF;
  INSERT INTO core.coupon_automation_dispatch_attempts(business_id,coupon_id,run_id) VALUES(p_business_id,j.coupon_id,p_run_id) RETURNING * INTO a;
  UPDATE core.coupon_automation_runs SET dispatch_claims=dispatch_claims+1 WHERE business_id=p_business_id AND run_id=p_run_id;
  RETURN jsonb_build_object('allowed',true,'code','attempt_recorded','attemptId',a.id,'couponId',j.coupon_id);
 ELSIF p_kind='receipt' THEN
  IF r.receipt_claims>=s.receipt_limit THEN RETURN jsonb_build_object('allowed',false,'code','limit');END IF;
  SELECT d.* INTO b FROM core.coupon_delivery_bindings d
  JOIN core.coupon_welcome_outbox q ON q.id=d.job_id AND q.business_id=d.business_id
  JOIN core.campaign_coupons c ON c.id=q.coupon_id AND c.business_id=d.business_id
  JOIN core.customers u ON u.id=c.customer_id AND u.business_id=c.business_id
  JOIN core.campaigns ca ON ca.id=c.campaign_id AND ca.business_id=c.business_id
  LEFT JOIN core.coupon_automation_receipt_polls rp ON rp.binding_id=d.id
  WHERE d.business_id=p_business_id AND NOT c.is_test AND NOT u.is_test AND NOT ca.is_test
  AND NOT EXISTS(SELECT FROM core.coupon_bootstrap_permits bp WHERE bp.job_id=q.id)
  AND NOT EXISTS(SELECT FROM core.coupon_delivery_receipts dr WHERE dr.binding_id=d.id)
  AND(rp.binding_id IS NULL OR rp.next_check_at<=clock_timestamp() AND rp.checks<s.receipt_check_limit AND rp.last_run_id<>p_run_id)
  ORDER BY coalesce(rp.next_check_at,d.created_at),d.id LIMIT 1 FOR UPDATE OF d SKIP LOCKED;
  IF b.id IS NULL THEN RETURN jsonb_build_object('allowed',false,'code','queue_empty');END IF;
  SELECT coupon_id INTO cp FROM core.coupon_welcome_outbox WHERE id=b.job_id AND business_id=p_business_id;
  INSERT INTO core.coupon_automation_receipt_polls(binding_id,business_id,coupon_id,last_run_id,checks,next_check_at)
  VALUES(b.id,p_business_id,cp,p_run_id,1,clock_timestamp()+interval '5 minutes')
  ON CONFLICT(binding_id) DO UPDATE SET last_run_id=p_run_id,checks=core.coupon_automation_receipt_polls.checks+1,next_check_at=excluded.next_check_at,outcome='pending'
  RETURNING * INTO poll;
  UPDATE core.coupon_automation_runs SET receipt_claims=receipt_claims+1 WHERE business_id=p_business_id AND run_id=p_run_id;
  RETURN jsonb_build_object('allowed',true,'code','poll_recorded','attemptId',b.id,'couponId',cp);
 ELSE RAISE EXCEPTION 'Invalid kind' USING ERRCODE='22023';END IF;
END $$;
CREATE FUNCTION public.coupon_automation_record_v1(p_business_id uuid,p_run_id uuid,p_run_token uuid,p_kind text,p_attempt_id uuid,p_outcome text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.coupon_automation_runs;a core.coupon_automation_dispatch_attempts;poll core.coupon_automation_receipt_polls;
BEGIN
 r:=core.coupon_automation_run_private_v1(p_business_id,p_run_id,p_run_token);
 IF p_kind='dispatch' THEN
  IF p_outcome IS NULL OR p_outcome NOT IN('provider_accepted','unknown','blocked') THEN RAISE EXCEPTION 'Invalid outcome' USING ERRCODE='22023';END IF;
  SELECT * INTO a FROM core.coupon_automation_dispatch_attempts WHERE id=p_attempt_id AND business_id=p_business_id AND run_id=p_run_id FOR UPDATE;
  IF a.id IS NULL THEN RAISE EXCEPTION 'Attempt unavailable' USING ERRCODE='42501';END IF;
  IF a.outcome<>'attempted' THEN RETURN jsonb_build_object('acknowledged',a.outcome=p_outcome);END IF;
  IF p_outcome='provider_accepted' AND NOT EXISTS(SELECT FROM core.coupon_welcome_outbox WHERE business_id=p_business_id AND coupon_id=a.coupon_id AND status='provider_accepted') THEN RAISE EXCEPTION 'Unconfirmed acceptance' USING ERRCODE='42501';END IF;
  UPDATE core.coupon_automation_dispatch_attempts SET outcome=p_outcome,finished_at=clock_timestamp() WHERE id=a.id;
 ELSIF p_kind='receipt' THEN
  IF p_outcome IS NULL OR p_outcome NOT IN('delivered','pending','unknown') THEN RAISE EXCEPTION 'Invalid outcome' USING ERRCODE='22023';END IF;
  SELECT * INTO poll FROM core.coupon_automation_receipt_polls WHERE binding_id=p_attempt_id AND business_id=p_business_id AND last_run_id=p_run_id FOR UPDATE;
  IF poll.binding_id IS NULL THEN RAISE EXCEPTION 'Poll unavailable' USING ERRCODE='42501';END IF;
  IF poll.outcome='delivered' THEN RETURN jsonb_build_object('acknowledged',p_outcome='delivered');END IF;
  IF p_outcome='delivered' AND NOT EXISTS(SELECT FROM core.coupon_delivery_receipts WHERE binding_id=poll.binding_id) THEN RAISE EXCEPTION 'Unconfirmed receipt' USING ERRCODE='42501';END IF;
  UPDATE core.coupon_automation_receipt_polls SET outcome=p_outcome WHERE binding_id=poll.binding_id;
 ELSE RAISE EXCEPTION 'Invalid kind' USING ERRCODE='22023';END IF;
 RETURN jsonb_build_object('acknowledged',true);
END $$;
CREATE FUNCTION public.coupon_automation_finish_v1(p_business_id uuid,p_run_id uuid,p_run_token uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r core.coupon_automation_runs;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM core.coupon_automation_runs WHERE business_id=p_business_id AND run_id=p_run_id FOR UPDATE;
 IF r.run_id IS NULL OR r.run_token IS DISTINCT FROM p_run_token THEN RAISE EXCEPTION 'Run unavailable' USING ERRCODE='42501';END IF;
 IF r.state='finished' THEN RETURN jsonb_build_object('acknowledged',true);END IF;
 IF r.state<>'active' THEN RETURN jsonb_build_object('acknowledged',false);END IF;
 UPDATE core.coupon_automation_runs SET state='finished',finished_at=clock_timestamp() WHERE business_id=p_business_id AND run_id=p_run_id;
 RETURN jsonb_build_object('acknowledged',true);
END $$;
CREATE FUNCTION public.coupon_automation_status_v1(p_business_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.role() IS DISTINCT FROM 'authenticated' OR NOT core.staff_authorized_v1(p_business_id,'campaign.staff_mark') THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('enabled',coalesce((SELECT enabled FROM core.coupon_automation_settings WHERE business_id=p_business_id),false),
 'unconfirmedAttempts',(SELECT count(*) FROM core.coupon_automation_dispatch_attempts WHERE business_id=p_business_id AND outcome IN('attempted','unknown')),
 'blockedAttempts',(SELECT count(*) FROM core.coupon_automation_dispatch_attempts WHERE business_id=p_business_id AND outcome='blocked'),
 'receiptPending',(SELECT count(*) FROM core.coupon_automation_receipt_polls WHERE business_id=p_business_id AND outcome<>'delivered'));
END $$;
DO $$ DECLARE t text;f record;BEGIN
 FOREACH t IN ARRAY ARRAY['coupon_automation_settings','coupon_automation_runs','coupon_automation_dispatch_attempts','coupon_automation_receipt_polls'] LOOP
  EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON core.%I FROM PUBLIC,anon,authenticated,service_role',t);
 END LOOP;
 FOR f IN SELECT p.oid::regprocedure AS identity,n.nspname,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('core','public') AND p.proname LIKE 'coupon_automation_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.identity);
  IF f.nspname='public' AND f.proname<>'coupon_automation_status_v1' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.identity);END IF;
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.coupon_automation_status_v1(uuid) TO authenticated;
COMMIT;
