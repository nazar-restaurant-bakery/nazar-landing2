-- Forward-only K10 delivery reconciliation. No seed, send, flow activation or key.
-- Original K6/K10 SQL and immutable message_log rows remain unchanged.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF to_regclass('core.coupon_welcome_outbox') IS NULL
 OR to_regprocedure('core.message_send_window_blocked_v1(uuid,uuid,uuid)') IS NULL
 OR to_regprocedure('core.staff_authorized_v1(uuid,text)') IS NULL THEN
 RAISE EXCEPTION 'K10_REVIEWED_COUPONS_K6_SCOPE_REQUIRED'; END IF;
 IF NOT (SELECT md5(prosrc)='9797285322b3082dfb0715e307862686' AND prosecdef AND provolatile='s' AND proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid='core.message_send_window_blocked_v1(uuid,uuid,uuid)'::regprocedure) THEN RAISE EXCEPTION 'K6_WINDOW_DEFINITION_REVIEW_REQUIRED';END IF;
END; $$;

CREATE TABLE core.coupon_delivery_settings (
 business_id uuid PRIMARY KEY REFERENCES core.businesses(id),enabled boolean NOT NULL DEFAULT false,
 account_id text NOT NULL CHECK(account_id ~ '^[A-Za-z0-9_-]{1,100}$'),
 flow_id text NOT NULL CHECK(flow_id ~ '^[A-Za-z0-9_-]{1,100}$'),
 message_id text NOT NULL CHECK(message_id ~ '^[A-Za-z0-9_-]{1,100}$'),
 received_metric_id text NOT NULL CHECK(received_metric_id ~ '^[A-Za-z0-9_-]{1,100}$'),
 review_ref text NOT NULL CHECK(review_ref ~ '^[A-Za-z0-9_.:/-]{8,160}$')
);
CREATE TABLE core.coupon_delivery_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL REFERENCES core.businesses(id),
 job_id uuid NOT NULL UNIQUE REFERENCES core.coupon_welcome_outbox(id),
 reservation_id uuid NOT NULL UNIQUE REFERENCES core.message_log(id),
 account_id text NOT NULL,profile_id text NOT NULL,flow_id text NOT NULL,message_id text NOT NULL,
 received_metric_id text NOT NULL,review_ref text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 -- Dedicated, never-reentering welcome message: one possible dispatch per profile.
 UNIQUE(account_id,profile_id,flow_id,message_id)
);
CREATE TABLE core.coupon_delivery_receipts (
 binding_id uuid PRIMARY KEY REFERENCES core.coupon_delivery_bindings(id),
 provider_event_id text NOT NULL CHECK(provider_event_id ~ '^[A-Za-z0-9_-]{1,200}$'),
 account_id text NOT NULL,delivered_at timestamptz NOT NULL CHECK(isfinite(delivered_at)),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(account_id,provider_event_id)
);
CREATE TABLE core.coupon_delivery_reviews (
 reservation_id uuid PRIMARY KEY REFERENCES core.message_log(id),business_id uuid NOT NULL REFERENCES core.businesses(id),
 actor_id uuid NOT NULL REFERENCES auth.users(id),evidence_ref text NOT NULL CHECK(evidence_ref ~ '^[A-Za-z0-9_.:/-]{8,160}$'),
 evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[0-9a-f]{64}$'),
 provider_cancelled_at timestamptz NOT NULL CHECK(isfinite(provider_cancelled_at)),
 quarantine_until timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['coupon_delivery_settings','coupon_delivery_bindings','coupon_delivery_receipts','coupon_delivery_reviews'] LOOP
 EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON core.%I FROM PUBLIC,anon,authenticated,service_role',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['coupon_delivery_bindings','coupon_delivery_receipts','coupon_delivery_reviews'] LOOP
 EXECUTE format('CREATE TRIGGER immutable_delivery BEFORE UPDATE OR DELETE OR TRUNCATE ON core.%I FOR EACH STATEMENT EXECUTE FUNCTION core.coupon_history_guard_v1()',t);
 EXECUTE format('ALTER TABLE core.%I ENABLE ALWAYS TRIGGER immutable_delivery',t);
 END LOOP;
END; $$;

CREATE FUNCTION public.coupon_delivery_preflight_v1(p_business_id uuid,p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s core.coupon_delivery_settings;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO s FROM core.coupon_delivery_settings WHERE business_id=p_business_id AND enabled;
 IF NOT FOUND OR NOT EXISTS(SELECT FROM core.coupon_welcome_outbox WHERE id=p_job_id AND business_id=p_business_id) THEN RETURN jsonb_build_object('allowed',false,'code','delivery_setup_required'); END IF;
 RETURN jsonb_build_object('allowed',true,'accountId',s.account_id);
END; $$;
CREATE FUNCTION public.coupon_delivery_bind_v1(p_business_id uuid,p_job_id uuid,p_job_lease_id uuid,p_reservation_id uuid,p_profile_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s core.coupon_delivery_settings;b core.coupon_delivery_bindings;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO s FROM core.coupon_delivery_settings WHERE business_id=p_business_id AND enabled FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'code','delivery_setup_required');END IF;
 IF NOT EXISTS(SELECT FROM core.coupon_welcome_outbox j JOIN core.campaign_coupons cp ON cp.id=j.coupon_id
 JOIN core.vip_confirmation_evidence v ON v.id=cp.confirmation_evidence_id
 JOIN core.message_log m ON m.id=p_reservation_id
 WHERE j.id=p_job_id AND j.business_id=p_business_id AND j.job_lease_id=p_job_lease_id AND j.status='claimed'
 AND m.business_id=j.business_id AND m.customer_id=cp.customer_id AND m.message_key=j.message_key AND m.message_kind='flow'
 AND m.status='sending' AND m.dispatch_authorized_at IS NOT NULL AND m.dispatch_expires_at>clock_timestamp()
 AND v.provider_profile_id=p_profile_id) THEN RAISE EXCEPTION 'Unbound dispatch' USING ERRCODE='42501';END IF;
 INSERT INTO core.coupon_delivery_bindings(business_id,job_id,reservation_id,account_id,profile_id,flow_id,message_id,received_metric_id,review_ref)
 VALUES(p_business_id,p_job_id,p_reservation_id,s.account_id,p_profile_id,s.flow_id,s.message_id,s.received_metric_id,s.review_ref)
 ON CONFLICT DO NOTHING;
 SELECT * INTO b FROM core.coupon_delivery_bindings WHERE job_id=p_job_id AND reservation_id=p_reservation_id AND profile_id=p_profile_id;
 RETURN jsonb_build_object('allowed',FOUND,'code',CASE WHEN FOUND THEN 'delivery_bound' ELSE 'welcome_already_bound' END);
END; $$;
CREATE FUNCTION public.coupon_delivery_context_v1(p_business_id uuid,p_coupon_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c jsonb;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object('bindingId',b.id,'businessId',b.business_id,'accountId',b.account_id,
 'profileId',b.profile_id,'flowId',b.flow_id,'messageId',b.message_id,'metricId',b.received_metric_id,
 'dispatchedAt',m.dispatch_authorized_at,'deliveredAt',r.delivered_at,'providerEventId',r.provider_event_id,
 'activationAllowed',core.klaviyo_profile_sync_eligible_v1(m.business_id,m.customer_id)
 AND EXISTS(SELECT FROM core.message_send_settings s WHERE s.business_id=m.business_id AND s.enabled)
 AND EXISTS(SELECT FROM core.coupon_delivery_settings s WHERE s.business_id=m.business_id AND s.enabled
 AND s.account_id=b.account_id AND s.flow_id=b.flow_id AND s.message_id=b.message_id AND s.received_metric_id=b.received_metric_id))
 INTO c FROM core.coupon_delivery_bindings b JOIN core.coupon_welcome_outbox j ON j.id=b.job_id
 JOIN core.message_log m ON m.id=b.reservation_id LEFT JOIN core.coupon_delivery_receipts r ON r.binding_id=b.id
 WHERE b.business_id=p_business_id AND j.coupon_id=p_coupon_id AND m.status IN('sending','unknown');
 RETURN c;
END; $$;
CREATE FUNCTION public.coupon_delivery_record_v1(p_business_id uuid,p_binding_id uuid,p_provider_event_id text,p_delivered_at timestamptz,p_evidence_sha256 text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE b core.coupon_delivery_bindings;m core.message_log;r core.coupon_delivery_receipts;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO b FROM core.coupon_delivery_bindings WHERE id=p_binding_id AND business_id=p_business_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO m FROM core.message_log WHERE id=b.reservation_id;
 PERFORM pg_advisory_xact_lock(hashtextextended(m.business_id::text||':'||m.customer_id::text,6008));
 IF p_delivered_at IS NULL OR NOT isfinite(p_delivered_at) OR p_delivered_at<m.dispatch_authorized_at OR p_delivered_at>clock_timestamp()+interval '1 minute'
 OR p_evidence_sha256 IS NULL OR p_evidence_sha256 !~ '^[0-9a-f]{64}$' OR p_provider_event_id IS NULL OR p_provider_event_id !~ '^[A-Za-z0-9_-]{1,200}$' THEN RAISE EXCEPTION 'Invalid receipt' USING ERRCODE='22023';END IF;
 INSERT INTO core.coupon_delivery_receipts(binding_id,provider_event_id,account_id,delivered_at,evidence_sha256)
 VALUES(b.id,p_provider_event_id,b.account_id,p_delivered_at,p_evidence_sha256) ON CONFLICT DO NOTHING;
 SELECT * INTO r FROM core.coupon_delivery_receipts WHERE binding_id=b.id;
 IF NOT FOUND OR r.provider_event_id<>p_provider_event_id OR r.delivered_at<>p_delivered_at OR r.evidence_sha256<>p_evidence_sha256 THEN RAISE EXCEPTION 'Receipt conflict' USING ERRCODE='22023';END IF;
 RETURN jsonb_build_object('acknowledged',true,'code','delivery_confirmed','deliveredAt',r.delivered_at);
END; $$;

-- Human exception only after provider queue cancellation is proven. No inference
-- from an empty Events result and no automatic time-based clearing of uncertainty.
CREATE FUNCTION public.coupon_review_not_sent_v1(p_business_id uuid,p_reservation_id uuid,p_evidence_ref text,p_evidence_sha256 text,p_provider_cancelled_at timestamptz) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE m core.message_log;r core.coupon_delivery_reviews;hours integer;
BEGIN
 IF auth.uid() IS NULL OR NOT core.staff_authorized_v1(p_business_id,'campaign.staff_mark') OR NOT EXISTS(
 SELECT FROM core.platform_operators WHERE staff_id=auth.uid() AND active) THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO m FROM core.message_log WHERE id=p_reservation_id AND business_id=p_business_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(m.business_id::text||':'||m.customer_id::text,6008));
 IF m.status<>'unknown' OR NOT EXISTS(SELECT FROM core.coupon_welcome_outbox WHERE message_reservation_id=m.id AND business_id=p_business_id)
 OR p_evidence_ref IS NULL OR p_evidence_ref !~ '^[A-Za-z0-9_.:/-]{8,160}$'
 OR p_evidence_sha256 IS NULL OR p_evidence_sha256 !~ '^[0-9a-f]{64}$'
 OR p_provider_cancelled_at IS NULL OR NOT isfinite(p_provider_cancelled_at)
 OR p_provider_cancelled_at<coalesce(m.dispatch_authorized_at,m.claimed_at) OR p_provider_cancelled_at>clock_timestamp() THEN RAISE EXCEPTION 'Invalid review' USING ERRCODE='22023';END IF;
 SELECT min_interval_hours INTO STRICT hours FROM core.message_send_settings WHERE business_id=p_business_id;
 INSERT INTO core.coupon_delivery_reviews(reservation_id,business_id,actor_id,evidence_ref,evidence_sha256,provider_cancelled_at,quarantine_until)
 VALUES(m.id,m.business_id,auth.uid(),p_evidence_ref,p_evidence_sha256,p_provider_cancelled_at,clock_timestamp()+make_interval(hours=>hours)) ON CONFLICT DO NOTHING;
 SELECT * INTO r FROM core.coupon_delivery_reviews WHERE reservation_id=m.id;
 IF r.evidence_ref<>p_evidence_ref OR r.evidence_sha256<>p_evidence_sha256 THEN RAISE EXCEPTION 'Review conflict' USING ERRCODE='22023';END IF;
 RETURN jsonb_build_object('acknowledged',true,'code','review_quarantine','quarantineUntil',r.quarantine_until);
END; $$;

CREATE OR REPLACE FUNCTION core.message_send_window_blocked_v1(p_business_id uuid,p_customer_id uuid,p_exclude uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT COALESCE((SELECT NOT s.enabled OR EXISTS(
  SELECT FROM core.message_log m WHERE m.business_id=p_business_id AND m.customer_id=p_customer_id
  AND(p_exclude IS NULL OR m.id<>p_exclude)
  AND(m.status IN('reserved','claimed','sending','blocked')
   OR(m.status='sent' AND m.sent_at>clock_timestamp()-make_interval(hours=>s.min_interval_hours))
   OR(m.status='unknown' AND(
    (NOT EXISTS(SELECT FROM core.coupon_delivery_bindings b JOIN core.coupon_delivery_receipts r ON r.binding_id=b.id WHERE b.reservation_id=m.id)
     AND NOT EXISTS(SELECT FROM core.coupon_delivery_reviews r WHERE r.reservation_id=m.id))
    OR EXISTS(SELECT FROM core.coupon_delivery_bindings b JOIN core.coupon_delivery_receipts r ON r.binding_id=b.id WHERE b.reservation_id=m.id AND r.delivered_at>clock_timestamp()-make_interval(hours=>s.min_interval_hours))
    OR EXISTS(SELECT FROM core.coupon_delivery_reviews r WHERE r.reservation_id=m.id AND greatest(r.quarantine_until,r.recorded_at+make_interval(hours=>s.min_interval_hours))>clock_timestamp())
   )))) FROM core.message_send_settings s WHERE s.business_id=p_business_id),true)
$$;
REVOKE ALL ON FUNCTION public.coupon_delivery_preflight_v1(uuid,uuid),public.coupon_delivery_bind_v1(uuid,uuid,uuid,uuid,text),public.coupon_delivery_context_v1(uuid,uuid),public.coupon_delivery_record_v1(uuid,uuid,text,timestamptz,text),public.coupon_review_not_sent_v1(uuid,uuid,text,text,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coupon_delivery_preflight_v1(uuid,uuid),public.coupon_delivery_bind_v1(uuid,uuid,uuid,uuid,text),public.coupon_delivery_context_v1(uuid,uuid),public.coupon_delivery_record_v1(uuid,uuid,text,timestamptz,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.coupon_review_not_sent_v1(uuid,uuid,text,text,timestamptz) TO authenticated;
REVOKE ALL ON FUNCTION core.message_send_window_blocked_v1(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
