-- Forward-only, default-disabled first-real-event recovery. No seed/send/Flow/key.
-- Original K6 functions/message_log remain unchanged. Existing normal claim gains
-- only the same-business serialization and durable bootstrap job exclusion.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF to_regprocedure('public.coupon_welcome_claim_v1(uuid,uuid)') IS NULL
 OR to_regclass('core.coupon_delivery_bindings') IS NULL THEN RAISE EXCEPTION 'K10_RECEIPTS_REQUIRED';END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.coupon_welcome_claim_v1(uuid,uuid)'::regprocedure) IS DISTINCT FROM '42a89bf4ee802cb9c1550f3d6a865656' THEN RAISE EXCEPTION 'K10_CLAIM_REVIEW_REQUIRED';END IF;
END $$;
CREATE TABLE core.coupon_bootstrap_permits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL UNIQUE REFERENCES core.businesses(id),
 coupon_id uuid NOT NULL UNIQUE REFERENCES core.campaign_coupons(id),
 job_id uuid NOT NULL UNIQUE REFERENCES core.coupon_welcome_outbox(id),
 customer_id uuid NOT NULL REFERENCES core.customers(id),
 actor_id uuid NOT NULL REFERENCES auth.users(id),
 account_id text NOT NULL UNIQUE CHECK(account_id ~ '^[A-Za-z0-9_-]{1,100}$'),
 profile_id text NOT NULL CHECK(profile_id ~ '^[A-Za-z0-9_-]{1,100}$'),
 event_unique_id text NOT NULL UNIQUE,
 qr_origin text NOT NULL CHECK(qr_origin ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$'),
 review_ref text NOT NULL CHECK(review_ref ~ '^[A-Za-z0-9_.:/-]{8,160}$'),
 absence_sha256 text NOT NULL CHECK(absence_sha256 ~ '^[a-f0-9]{64}$'),
 enabled boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),
 recover_until timestamptz NOT NULL CHECK(isfinite(recover_until) AND recover_until>expires_at),
 lease_id uuid NOT NULL DEFAULT gen_random_uuid(),
 state text NOT NULL DEFAULT 'reviewed' CHECK(state IN('reviewed','claimed','dispatch_bound','awaiting_event','event_verified','bound','delivered','blocked')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts IN(0,1)),
 reservation_id uuid UNIQUE REFERENCES core.message_log(id),payload_sha256 text,
 metric_id text,provider_event_id text,event_at timestamptz,event_proof_sha256 text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE core.coupon_bootstrap_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 permit_id uuid NOT NULL REFERENCES core.coupon_bootstrap_permits(id),
 event_type text NOT NULL CHECK(event_type IN('reviewed','claimed','dispatch_bound','awaiting_event','event_verified','late_bound','delivered','blocked')),
 evidence_sha256 text CHECK(evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(permit_id,event_type)
);
ALTER TABLE core.coupon_bootstrap_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.coupon_bootstrap_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.coupon_bootstrap_permits,core.coupon_bootstrap_audit FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER immutable_bootstrap_audit BEFORE UPDATE OR DELETE OR TRUNCATE ON core.coupon_bootstrap_audit
 FOR EACH STATEMENT EXECUTE FUNCTION core.coupon_history_guard_v1();
CREATE FUNCTION core.coupon_bootstrap_permit_guard_v1() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN
 IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'BOOTSTRAP_IMMUTABLE';END IF;
 IF (to_jsonb(NEW)-ARRAY['state','attempts','reservation_id','payload_sha256','metric_id','provider_event_id','event_at','event_proof_sha256'])
 IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','attempts','reservation_id','payload_sha256','metric_id','provider_event_id','event_at','event_proof_sha256'])
 OR NEW.attempts<OLD.attempts OR (OLD.attempts=1 AND NEW.attempts<>1)
 OR (OLD.reservation_id IS NOT NULL AND NEW.reservation_id IS DISTINCT FROM OLD.reservation_id)
 OR (OLD.payload_sha256 IS NOT NULL AND NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256)
 OR (OLD.metric_id IS NOT NULL AND (NEW.metric_id,NEW.provider_event_id,NEW.event_at,NEW.event_proof_sha256) IS DISTINCT FROM (OLD.metric_id,OLD.provider_event_id,OLD.event_at,OLD.event_proof_sha256))
 OR NOT ((OLD.state='reviewed' AND NEW.state='claimed' AND NEW.attempts=1)
 OR(OLD.state='claimed' AND NEW.state IN('dispatch_bound','blocked'))
 OR(OLD.state='dispatch_bound' AND NEW.state='awaiting_event')
 OR(OLD.state='awaiting_event' AND NEW.state='event_verified')
 OR(OLD.state='event_verified' AND NEW.state='bound')
 OR(OLD.state='bound' AND NEW.state='delivered')) THEN RAISE EXCEPTION 'BOOTSTRAP_TRANSITION_REJECTED';END IF;
 RETURN NEW;END $$;
CREATE TRIGGER bootstrap_permit_guard BEFORE UPDATE OR DELETE ON core.coupon_bootstrap_permits
 FOR EACH ROW EXECUTE FUNCTION core.coupon_bootstrap_permit_guard_v1();
CREATE TRIGGER bootstrap_no_truncate BEFORE TRUNCATE ON core.coupon_bootstrap_permits
 FOR EACH STATEMENT EXECUTE FUNCTION core.coupon_history_guard_v1();
CREATE FUNCTION core.coupon_bootstrap_writer_v1(p_business_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT COALESCE(auth.role()='authenticated' AND auth.uid() IS NOT NULL AND core.staff_authorized_v1(p_business_id,'campaign.staff_mark')
 AND EXISTS(SELECT FROM core.platform_operators WHERE staff_id=auth.uid() AND active),false)
$$;
CREATE FUNCTION public.coupon_bootstrap_permit_v1(p_business_id uuid,p_coupon_id uuid,p_account_id text,p_qr_origin text,
 p_review_ref text,p_absence_sha256 text,p_expires_at timestamptz,p_recover_until timestamptz,p_approved boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cp core.campaign_coupons;j core.coupon_welcome_outbox;e core.vip_confirmation_evidence;p core.coupon_bootstrap_permits;
BEGIN
 IF NOT core.coupon_bootstrap_writer_v1(p_business_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('coupon-welcome:'||p_business_id::text,240024));
 SELECT * INTO cp FROM core.campaign_coupons WHERE id=p_coupon_id AND business_id=p_business_id;
 SELECT * INTO j FROM core.coupon_welcome_outbox WHERE coupon_id=p_coupon_id AND business_id=p_business_id FOR UPDATE;
 SELECT * INTO e FROM core.vip_confirmation_evidence WHERE id=cp.confirmation_evidence_id AND business_id=p_business_id;
 IF p_approved IS DISTINCT FROM true OR cp.id IS NULL OR j.status IS DISTINCT FROM 'queued' OR cp.is_test OR cp.state<>'issued'
 OR NOT core.klaviyo_profile_sync_eligible_v1(p_business_id,cp.customer_id)
 OR e.id IS NULL OR e.customer_id<>cp.customer_id
 OR NOT EXISTS(SELECT FROM core.campaigns c WHERE c.id=cp.campaign_id AND c.business_id=p_business_id AND NOT c.is_test AND c.status='active' AND c.starts_at<=clock_timestamp() AND (c.ends_at IS NULL OR c.ends_at>clock_timestamp()))
 OR cp.expires_at<=clock_timestamp() OR p_expires_at IS NULL OR p_expires_at<=clock_timestamp() OR p_expires_at>clock_timestamp()+interval '30 minutes'
 OR p_recover_until IS NULL OR p_recover_until<=p_expires_at OR p_recover_until>clock_timestamp()+interval '7 days'
 OR EXISTS(SELECT FROM core.coupon_delivery_bindings WHERE business_id=p_business_id)
 OR EXISTS(SELECT FROM core.coupon_delivery_settings WHERE business_id=p_business_id AND enabled)
 THEN RAISE EXCEPTION 'Bootstrap permit not eligible' USING ERRCODE='22023';END IF;
 INSERT INTO core.coupon_bootstrap_permits(business_id,coupon_id,job_id,customer_id,actor_id,account_id,profile_id,event_unique_id,qr_origin,review_ref,absence_sha256,enabled,expires_at,recover_until)
 VALUES(p_business_id,cp.id,j.id,cp.customer_id,auth.uid(),p_account_id,e.provider_profile_id,j.event_unique_id,p_qr_origin,p_review_ref,p_absence_sha256,true,p_expires_at,p_recover_until) RETURNING * INTO p;
 INSERT INTO core.coupon_bootstrap_audit(permit_id,event_type,evidence_sha256) VALUES(p.id,'reviewed',p_absence_sha256);
 RETURN jsonb_build_object('permitId',p.id,'dispatchEnabled',false,'runtimeFlagRequired',true);
END $$;
CREATE FUNCTION core.coupon_bootstrap_context_private_v1(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE p core.coupon_bootstrap_permits;j core.coupon_welcome_outbox;cp core.campaign_coupons;e core.vip_confirmation_evidence;u core.customers;c core.campaigns;
BEGIN
 SELECT * INTO p FROM core.coupon_bootstrap_permits WHERE id=p_id;
 SELECT * INTO j FROM core.coupon_welcome_outbox WHERE id=p.job_id AND business_id=p.business_id;
 SELECT * INTO cp FROM core.campaign_coupons WHERE id=p.coupon_id AND business_id=p.business_id;
 SELECT * INTO u FROM core.customers WHERE id=p.customer_id AND business_id=p.business_id;
 SELECT * INTO e FROM core.vip_confirmation_evidence WHERE id=cp.confirmation_evidence_id;
 SELECT * INTO c FROM core.campaigns WHERE id=cp.campaign_id AND business_id=p.business_id;
 IF p.id IS NULL OR NOT p.enabled OR NOT EXISTS(SELECT FROM core.platform_operators WHERE staff_id=p.actor_id AND active)
 OR NOT EXISTS(SELECT FROM core.business_staff WHERE business_id=p.business_id AND staff_id=p.actor_id AND active AND role IN('owner','manager'))
 OR NOT core.klaviyo_profile_sync_eligible_v1(p.business_id,p.customer_id) OR cp.is_test OR c.is_test OR cp.state<>'issued'
 OR c.status<>'active' OR c.starts_at>clock_timestamp() OR c.ends_at<=clock_timestamp() OR cp.expires_at<=clock_timestamp()
 OR e.provider_profile_id IS DISTINCT FROM p.profile_id OR e.customer_id IS DISTINCT FROM p.customer_id
 OR e.email_sha256 IS DISTINCT FROM encode(sha256(convert_to(lower(btrim(u.email)),'UTF8')),'hex')
 OR p.event_unique_id IS DISTINCT FROM j.event_unique_id OR p.recover_until<=clock_timestamp()
 THEN RETURN jsonb_build_object('allowed',false,'code','bootstrap_ineligible');END IF;
 RETURN jsonb_build_object('allowed',true,'permitId',p.id,'state',p.state,'attempts',p.attempts,'expiresAt',p.expires_at,'recoverUntil',p.recover_until,
 'accountId',p.account_id,'profileId',p.profile_id,'confirmedAt',e.confirmed_at,'vipListId',c.vip_list_id,'qrOrigin',p.qr_origin,'reservationId',p.reservation_id,'payloadSha256',p.payload_sha256,
 'dispatchedAt',(SELECT dispatch_authorized_at FROM core.message_log WHERE id=p.reservation_id),'metricId',p.metric_id,'providerEventId',p.provider_event_id,'eventAt',p.event_at,'eventProofSha256',p.event_proof_sha256,
 'businessId',p.business_id,'jobId',j.id,'jobLeaseId',p.lease_id,'couponId',cp.id,'customerId',u.id,'messageKey',j.message_key,'eventUniqueId',j.event_unique_id,'recipient',lower(btrim(u.email)),
 'properties',jsonb_build_object('coupon_code',cp.code,'coupon_qr_payload','VIPCOUPON1:'||cp.code,'coupon_qr_token',cp.qr_token,'coupon_qr_image_url',NULL,'campaign_id',c.id,'coupon_id',cp.id,'minimum_amount_cents',c.min_amount_cents,'channels',c.coupon_channels,'expires_at',cp.expires_at,'message_key',j.message_key));
END $$;
CREATE FUNCTION public.coupon_bootstrap_preview_v1(p_permit_id uuid,p_receipt_only boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE p core.coupon_bootstrap_permits;BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 IF p_receipt_only THEN
 SELECT * INTO p FROM core.coupon_bootstrap_permits WHERE id=p_permit_id AND state IN('bound','delivered');
 RETURN jsonb_build_object('allowed',FOUND,'permitId',p.id,'businessId',p.business_id,'accountId',p.account_id,'couponId',p.coupon_id,'state',p.state);
 END IF;
 RETURN core.coupon_bootstrap_context_private_v1(p_permit_id);END $$;
CREATE FUNCTION public.coupon_bootstrap_claim_v1(p_permit_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p core.coupon_bootstrap_permits;x jsonb;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM core.coupon_bootstrap_permits WHERE id=p_permit_id;
 PERFORM pg_advisory_xact_lock(hashtextextended('coupon-welcome:'||p.business_id::text,240024));
 SELECT * INTO p FROM core.coupon_bootstrap_permits WHERE id=p_permit_id FOR UPDATE;
 IF p.id IS NULL OR p.state<>'reviewed' OR p.attempts<>0 OR p.expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('allowed',false,'code','bootstrap_not_claimable');END IF;
 x:=core.coupon_bootstrap_context_private_v1(p.id);
 IF x->>'allowed' IS DISTINCT FROM 'true' THEN RETURN x;END IF;
 UPDATE core.coupon_welcome_outbox SET status='claimed',job_lease_id=p.lease_id,lease_expires_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
 WHERE id=p.job_id AND business_id=p.business_id AND status='queued';
 IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'code','bootstrap_job_unavailable');END IF;
 UPDATE core.coupon_bootstrap_permits SET state='claimed',attempts=1 WHERE id=p.id;
 INSERT INTO core.coupon_bootstrap_audit(permit_id,event_type) VALUES(p.id,'claimed');
 RETURN core.coupon_welcome_context_private_v1(p.job_id,p.lease_id);
END $$;
CREATE FUNCTION public.coupon_bootstrap_preflight_v1(p_permit_id uuid,p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE p core.coupon_bootstrap_permits;x jsonb;BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM core.coupon_bootstrap_permits WHERE id=p_permit_id AND job_id=p_job_id AND state='claimed' AND attempts=1;
 x:=core.coupon_bootstrap_context_private_v1(p_permit_id);
 RETURN jsonb_build_object('allowed',p.id IS NOT NULL AND x->>'allowed'='true','accountId',p.account_id);END $$;
CREATE FUNCTION public.coupon_bootstrap_dispatch_bind_v1(p_permit_id uuid,p_job_id uuid,p_job_lease_id uuid,p_reservation_id uuid,p_profile_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p core.coupon_bootstrap_permits;m core.message_log;BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM core.coupon_bootstrap_permits WHERE id=p_permit_id FOR UPDATE;
 SELECT * INTO m FROM core.message_log WHERE id=p_reservation_id;
 IF p.state IS DISTINCT FROM 'claimed' OR p.expires_at<=clock_timestamp()
 OR core.coupon_bootstrap_context_private_v1(p.id)->>'allowed' IS DISTINCT FROM 'true' OR p.job_id IS DISTINCT FROM p_job_id OR p.lease_id IS DISTINCT FROM p_job_lease_id OR p.profile_id IS DISTINCT FROM p_profile_id
 OR m.business_id IS DISTINCT FROM p.business_id OR m.customer_id IS DISTINCT FROM p.customer_id OR m.status IS DISTINCT FROM 'sending'
 OR m.message_key IS DISTINCT FROM ('coupon-welcome:'||p.coupon_id::text) OR m.message_kind IS DISTINCT FROM 'flow'
 OR m.dispatch_authorized_at IS NULL OR m.dispatch_expires_at<=clock_timestamp()
 OR NOT EXISTS(SELECT FROM core.coupon_welcome_outbox j WHERE j.id=p.job_id AND j.status='claimed' AND j.job_lease_id=p.lease_id)
 THEN RAISE EXCEPTION 'Unbound bootstrap dispatch' USING ERRCODE='42501';END IF;
 UPDATE core.coupon_bootstrap_permits SET state='dispatch_bound',reservation_id=m.id,payload_sha256=m.payload_sha256 WHERE id=p.id;
 INSERT INTO core.coupon_bootstrap_audit(permit_id,event_type) VALUES(p.id,'dispatch_bound');
 RETURN jsonb_build_object('allowed',true,'code','bootstrap_dispatch_bound');END $$;
CREATE FUNCTION public.coupon_bootstrap_finish_v1(p_permit_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p core.coupon_bootstrap_permits;j core.coupon_welcome_outbox;v_state text;BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM core.coupon_bootstrap_permits WHERE id=p_permit_id FOR UPDATE;
 SELECT * INTO j FROM core.coupon_welcome_outbox WHERE id=p.job_id;
 IF p.state NOT IN('claimed','dispatch_bound') THEN RETURN jsonb_build_object('acknowledged',false);END IF;
 IF p.state='dispatch_bound' AND j.status IN('provider_accepted','unknown')
 AND EXISTS(SELECT FROM core.message_log WHERE id=p.reservation_id AND status='unknown') THEN v_state:='awaiting_event';
 ELSIF p.state='claimed' AND j.status IN('blocked','unknown') THEN v_state:='blocked';
 ELSE RETURN jsonb_build_object('acknowledged',false);END IF;
 UPDATE core.coupon_bootstrap_permits SET state=v_state WHERE id=p.id;
 INSERT INTO core.coupon_bootstrap_audit(permit_id,event_type) VALUES(p.id,v_state);
 RETURN jsonb_build_object('acknowledged',true,'state',v_state);END $$;
-- Recovery makes no provider request and never grants another attempt. Reuses
-- the original K6/outbox finalizers only after that dispatch lease has expired.
CREATE FUNCTION public.coupon_bootstrap_recover_v1(p_permit_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p core.coupon_bootstrap_permits;m core.message_log;j core.coupon_welcome_outbox;ack jsonb;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM core.coupon_bootstrap_permits WHERE id=p_permit_id;
 IF p.state='awaiting_event' THEN RETURN jsonb_build_object('acknowledged',true,'state','awaiting_event','retryAllowed',false);END IF;
 IF p.state IS DISTINCT FROM 'dispatch_bound' OR p.reservation_id IS NULL THEN RETURN jsonb_build_object('acknowledged',false,'retryAllowed',false);END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.business_id::text||':'||p.customer_id::text,6008));
 SELECT * INTO p FROM core.coupon_bootstrap_permits WHERE id=p_permit_id FOR UPDATE;
 SELECT * INTO m FROM core.message_log WHERE id=p.reservation_id;
 SELECT * INTO j FROM core.coupon_welcome_outbox WHERE id=p.job_id;
 IF p.state IS DISTINCT FROM 'dispatch_bound' OR m.business_id IS DISTINCT FROM p.business_id OR m.customer_id IS DISTINCT FROM p.customer_id
 OR m.message_key IS DISTINCT FROM ('coupon-welcome:'||p.coupon_id::text) OR m.payload_sha256 IS DISTINCT FROM p.payload_sha256
 OR j.job_lease_id IS DISTINCT FROM p.lease_id OR j.status NOT IN('claimed','unknown','provider_accepted')
 OR m.status NOT IN('sending','unknown') OR m.dispatch_authorized_at IS NULL
 OR(m.status='sending' AND m.dispatch_expires_at>clock_timestamp()) THEN
 RETURN jsonb_build_object('acknowledged',false,'retryAllowed',false);END IF;
 IF m.status='sending' THEN
 ack:=public.message_send_finalize_v1(m.id,m.lease_id,'unknown');
 IF ack->>'status' IS DISTINCT FROM 'unknown' THEN RAISE EXCEPTION 'Bootstrap recovery not confirmed';END IF;
 END IF;
 IF j.status='claimed' THEN
 ack:=public.coupon_welcome_finish_v1(j.id,p.lease_id,'unknown',m.id,NULL,'bootstrap_recovery_unknown');
 IF ack->>'acknowledged' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Bootstrap outbox recovery not confirmed';END IF;
 END IF;
 RETURN public.coupon_bootstrap_finish_v1(p.id)||jsonb_build_object('retryAllowed',false);
END $$;
CREATE FUNCTION public.coupon_bootstrap_record_event_v1(p_permit_id uuid,p_metric_id text,p_provider_event_id text,p_event_at timestamptz,p_evidence_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p core.coupon_bootstrap_permits;m core.message_log;BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM core.coupon_bootstrap_permits WHERE id=p_permit_id FOR UPDATE;
 IF p.state='event_verified' AND (p.metric_id,p.provider_event_id,p.event_at,p.event_proof_sha256) IS NOT DISTINCT FROM(p_metric_id,p_provider_event_id,p_event_at,p_evidence_sha256) THEN RETURN jsonb_build_object('acknowledged',true);END IF;
 SELECT * INTO m FROM core.message_log WHERE id=p.reservation_id;
 IF p.state IS DISTINCT FROM 'awaiting_event' OR m.status IS DISTINCT FROM 'unknown' OR p.recover_until<=clock_timestamp()
 OR p_metric_id IS NULL OR p_metric_id !~ '^[A-Za-z0-9_-]{1,100}$' OR p_provider_event_id IS NULL OR p_provider_event_id !~ '^[A-Za-z0-9_-]{1,200}$'
 OR p_event_at IS NULL OR NOT isfinite(p_event_at) OR p_event_at<m.dispatch_authorized_at-interval '1 second' OR p_event_at>clock_timestamp()+interval '1 minute'
 OR p_evidence_sha256 IS NULL OR p_evidence_sha256 !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'Bootstrap event proof invalid' USING ERRCODE='22023';END IF;
 UPDATE core.coupon_bootstrap_permits SET state='event_verified',metric_id=p_metric_id,provider_event_id=p_provider_event_id,event_at=p_event_at,event_proof_sha256=p_evidence_sha256 WHERE id=p.id;
 INSERT INTO core.coupon_bootstrap_audit(permit_id,event_type,evidence_sha256) VALUES(p.id,'event_verified',p_evidence_sha256);
 RETURN jsonb_build_object('acknowledged',true);END $$;
CREATE FUNCTION public.coupon_bootstrap_late_bind_v1(p_permit_id uuid,p_flow_id text,p_message_id text,p_received_metric_id text,p_review jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p core.coupon_bootstrap_permits;m core.message_log;b core.coupon_delivery_bindings;x jsonb;v_now timestamptz:=clock_timestamp();BEGIN
 SELECT * INTO p FROM core.coupon_bootstrap_permits WHERE id=p_permit_id;
 IF NOT core.coupon_bootstrap_writer_v1(p.business_id) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p.business_id::text||':'||p.customer_id::text,6008));
 SELECT * INTO p FROM core.coupon_bootstrap_permits WHERE id=p_permit_id FOR UPDATE;
 SELECT * INTO m FROM core.message_log WHERE id=p.reservation_id;
 x:=core.coupon_bootstrap_context_private_v1(p.id);
 IF p.state IS DISTINCT FROM 'event_verified' OR x->>'allowed' IS DISTINCT FROM 'true' OR m.status IS DISTINCT FROM 'unknown'
 OR m.payload_sha256 IS DISTINCT FROM p.payload_sha256 OR m.customer_id IS DISTINCT FROM p.customer_id
 OR p.recover_until<=v_now OR core.message_send_window_blocked_v1(p.business_id,p.customer_id,p.reservation_id)
 OR p_flow_id IS NULL OR p_flow_id !~ '^[A-Za-z0-9_-]{1,100}$' OR p_message_id IS NULL OR p_message_id !~ '^[A-Za-z0-9_-]{1,100}$'
 OR p_received_metric_id IS NULL OR p_received_metric_id !~ '^[A-Za-z0-9_-]{1,100}$'
 OR jsonb_typeof(p_review) IS DISTINCT FROM 'object'
 OR p_review->>'accountId' IS DISTINCT FROM p.account_id OR p_review->>'metricId' IS DISTINCT FROM p.metric_id
 OR p_review->>'profileId' IS DISTINCT FROM p.profile_id OR p_review->>'couponId' IS DISTINCT FROM p.coupon_id::text
 OR p_review->>'eventUniqueId' IS DISTINCT FROM p.event_unique_id OR p_review->>'payloadSha256' IS DISTINCT FROM p.payload_sha256
 OR p_review->>'flowId' IS DISTINCT FROM p_flow_id OR p_review->>'messageId' IS DISTINCT FROM p_message_id
 OR p_review->>'receivedMetricId' IS DISTINCT FROM p_received_metric_id OR p_review->>'receivedMetricName' IS DISTINCT FROM 'Received Email'
 OR p_review->>'receivedIntegration' IS DISTINCT FROM 'Klaviyo/Internal'
 OR p_review->>'messageStatus' IS DISTINCT FROM 'manual' OR p_review->>'messageCount' IS DISTINCT FROM '1'
 OR p_review->>'otherActions' IS DISTINCT FROM '0' OR p_review->>'queueCount' IS DISTINCT FROM '1'
 OR p_review->>'queueStatus' IS DISTINCT FROM 'needs_review' OR p_review->>'queueProfileId' IS DISTINCT FROM p.profile_id
 OR p_review->>'renderedPayloadSha256' IS DISTINCT FROM p.payload_sha256
 OR p_review->>'delayMinutes' IS NULL OR (p_review->>'delayMinutes')::integer<60
 OR (p_review->>'delayMinutes')::integer>10080
 OR p.recover_until<=p.event_at+make_interval(mins=>(p_review->>'delayMinutes')::integer)+interval '30 minutes'
 OR p_review->>'reviewedAt' IS NULL OR (p_review->>'reviewedAt')::timestamptz<v_now-interval '5 minutes' OR (p_review->>'reviewedAt')::timestamptz>v_now
 OR p_review->>'evidenceSha256' IS NULL OR p_review->>'evidenceSha256' !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'Bootstrap manual delivery review invalid' USING ERRCODE='22023';END IF;
 INSERT INTO core.coupon_delivery_bindings(business_id,job_id,reservation_id,account_id,profile_id,flow_id,message_id,received_metric_id,review_ref)
 VALUES(p.business_id,p.job_id,p.reservation_id,p.account_id,p.profile_id,p_flow_id,p_message_id,p_received_metric_id,p.review_ref) RETURNING * INTO b;
 UPDATE core.coupon_bootstrap_permits SET state='bound' WHERE id=p.id;
 INSERT INTO core.coupon_bootstrap_audit(permit_id,event_type,evidence_sha256) VALUES(p.id,'late_bound',p_review->>'evidenceSha256');
 RETURN jsonb_build_object('bindingId',b.id,'manualOnly',true,'activationReady',false);
END $$;
CREATE FUNCTION public.coupon_bootstrap_record_delivery_v1(p_permit_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE p core.coupon_bootstrap_permits;BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM core.coupon_bootstrap_permits WHERE id=p_permit_id FOR UPDATE;
 IF p.state='delivered' THEN RETURN jsonb_build_object('acknowledged',true);END IF;
 IF p.state IS DISTINCT FROM 'bound' OR NOT EXISTS(SELECT FROM core.coupon_delivery_bindings b
 JOIN core.coupon_delivery_receipts r ON r.binding_id=b.id
 WHERE b.job_id=p.job_id AND b.reservation_id=p.reservation_id AND b.profile_id=p.profile_id AND b.account_id=p.account_id)
 THEN RETURN jsonb_build_object('acknowledged',false);END IF;
 UPDATE core.coupon_bootstrap_permits SET state='delivered' WHERE id=p.id;
 INSERT INTO core.coupon_bootstrap_audit(permit_id,event_type) VALUES(p.id,'delivered');
 RETURN jsonb_build_object('acknowledged',true);END $$;
CREATE OR REPLACE FUNCTION public.coupon_welcome_claim_v1(p_business_id uuid,p_coupon_id uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j core.coupon_welcome_outbox%ROWTYPE;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('coupon-welcome:'||p_business_id::text,240024));
 -- Hold every normal job in this business until the real bootstrap receipt and
 -- a separately configured permanent Flow exist. Never expire/claim them here.
 IF EXISTS(SELECT FROM core.coupon_bootstrap_permits bp WHERE bp.business_id=p_business_id
  AND NOT(bp.state='delivered' AND EXISTS(SELECT FROM core.coupon_delivery_settings ds
   JOIN core.coupon_delivery_bindings db ON db.job_id=bp.job_id
   WHERE ds.business_id=p_business_id AND ds.enabled AND ds.account_id=bp.account_id
   AND ds.flow_id<>db.flow_id))) THEN
 RETURN jsonb_build_object('allowed',false,'code','bootstrap_setup_pending');END IF;
 -- An abandoned or ambiguous event cannot be retried automatically.
 UPDATE core.coupon_welcome_outbox SET status='unknown',safe_code='lease_expired',updated_at=clock_timestamp()
 WHERE business_id=p_business_id AND status='claimed' AND lease_expires_at<=clock_timestamp();
 SELECT * INTO j FROM core.coupon_welcome_outbox WHERE business_id=p_business_id AND status='queued'
 AND(p_coupon_id IS NULL OR coupon_id=p_coupon_id)
 AND NOT EXISTS(SELECT FROM core.coupon_bootstrap_permits bp WHERE bp.job_id=core.coupon_welcome_outbox.id) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'code','queue_empty');END IF;
 UPDATE core.coupon_welcome_outbox SET status='claimed',job_lease_id=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
 WHERE id=j.id RETURNING * INTO j;
 RETURN core.coupon_welcome_context_private_v1(j.id,j.job_lease_id);
END $$;
DO $$ DECLARE f record;BEGIN
 FOR f IN SELECT p.oid::regprocedure AS identity FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN('core','public') AND p.proname LIKE 'coupon_bootstrap_%' LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.identity);
 IF f.identity::text LIKE 'coupon_bootstrap_permit_v1(%' OR f.identity::text LIKE 'coupon_bootstrap_late_bind_v1(%' THEN
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',f.identity);
 ELSIF f.identity::text NOT LIKE 'core.%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.identity);END IF;
 END LOOP;
END $$;
COMMIT;
