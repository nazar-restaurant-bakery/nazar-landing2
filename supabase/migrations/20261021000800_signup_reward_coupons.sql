-- K10 signup-earned coupons. Forward-only, no activation seed, provider call or send.
-- Apply identical reviewed LF bytes test-first with psql after K9 and K10 eligibility.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('signup_reward_coupons_v1',0));
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
DO $preflight$ BEGIN
 IF pg_catalog.to_regprocedure('core.staff_authorized_v1(uuid,text)') IS NULL
 OR pg_catalog.to_regprocedure('core.campaign_eligibility_rules_v1(uuid,uuid,uuid,integer,text)') IS NULL
 OR pg_catalog.to_regclass('core.message_log') IS NULL
 OR pg_catalog.to_regprocedure('public.message_send_reserve_v1(uuid,uuid,text,text,text)') IS NULL
 OR pg_catalog.to_regprocedure('public.message_send_claim_v1(uuid)') IS NULL
 OR pg_catalog.to_regprocedure('public.message_send_context_v1(uuid,uuid)') IS NULL
 OR pg_catalog.to_regprocedure('public.message_send_finalize_v1(uuid,uuid,text)') IS NULL
 OR pg_catalog.to_regclass('core.signups') IS NULL
 OR pg_catalog.to_regclass('core.klaviyo_email_observations') IS NULL
 OR pg_catalog.to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL THEN
  RAISE EXCEPTION 'K10_COUPON_REVIEWED_BASELINE_K9_K10_PGCRYPTO_REQUIRED'; END IF;
 IF pg_catalog.has_schema_privilege('authenticated','core','USAGE')
 OR pg_catalog.has_schema_privilege('anon','core','USAGE')
 OR pg_catalog.has_schema_privilege('service_role','core','USAGE')
 OR current_setting('session_replication_role')<>'origin' THEN
  RAISE EXCEPTION 'K10_COUPON_PRIVATE_CORE_AND_ORIGIN_REQUIRED'; END IF;
END $preflight$;

ALTER TABLE core.campaigns
 ADD COLUMN campaign_kind text NOT NULL DEFAULT 'order_reward' CHECK(campaign_kind IN('order_reward','signup_reward')),
 ADD COLUMN coupon_channels text[],
 ADD COLUMN coupon_order_type_map jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(coupon_order_type_map)='object'),
 ADD COLUMN vip_list_id text,
 ALTER COLUMN ends_at DROP NOT NULL,
 ADD CONSTRAINT campaign_kind_terms CHECK(
 (campaign_kind='order_reward' AND ends_at IS NOT NULL AND coupon_channels IS NULL AND vip_list_id IS NULL AND coupon_order_type_map='{}')
 OR (campaign_kind='signup_reward' AND benefit_type='item' AND eligibility='subscribed_only'
 AND min_amount_cents>=3000 AND NOT include_tax AND NOT include_tip AND max_units_per_order=1
 AND period='campaign' AND local_start IS NULL AND local_end IS NULL AND weekdays @> ARRAY[1,2,3,4,5,6,7]::smallint[]
 AND isfinite(starts_at) AND(ends_at IS NULL OR isfinite(ends_at)) AND NOT restore_on_full_refund AND NOT restore_on_partial_below_minimum
 AND vip_list_id IS NOT NULL AND coupon_channels IS NOT NULL
AND vip_list_id ~ '^[A-Za-z0-9_-]{1,100}$' AND cardinality(coupon_channels) BETWEEN 1 AND 3
 AND array_position(coupon_channels,NULL) IS NULL AND coupon_channels <@ ARRAY['dine_in','site_pickup','site_delivery']::text[]));

CREATE TABLE core.vip_confirmation_evidence (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL REFERENCES core.businesses(id),
 customer_id uuid NOT NULL,signup_id uuid NOT NULL REFERENCES core.signups(id),
 provider_profile_id text NOT NULL CHECK(length(provider_profile_id) BETWEEN 1 AND 100),
 confirmed_at timestamptz NOT NULL,checked_at timestamptz NOT NULL,
 email_sha256 text NOT NULL CHECK(email_sha256 ~ '^[0-9a-f]{64}$'),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,business_id,customer_id),UNIQUE(business_id,customer_id,provider_profile_id,confirmed_at),
 FOREIGN KEY(customer_id,business_id) REFERENCES core.customers(id,business_id),
 CHECK(isfinite(confirmed_at) AND isfinite(checked_at) AND confirmed_at<=checked_at)
);
CREATE TABLE core.campaign_coupons (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL REFERENCES core.businesses(id),
 campaign_id uuid NOT NULL,customer_id uuid NOT NULL,confirmation_evidence_id uuid NOT NULL,
 code text NOT NULL UNIQUE CHECK(code ~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}(-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){3}$'),
 qr_token text NOT NULL UNIQUE CHECK(qr_token ~ '^[0-9a-f]{32}$'),
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz,
 state text NOT NULL DEFAULT 'issued' CHECK(state IN('issued','redeemed')),
 redeemed_at timestamptz,redeemed_by uuid REFERENCES auth.users(id),redemption_id uuid UNIQUE,is_test boolean NOT NULL,
 UNIQUE(campaign_id,customer_id),UNIQUE(id,business_id,campaign_id,customer_id),
 FOREIGN KEY(campaign_id,business_id) REFERENCES core.campaigns(id,business_id),
 FOREIGN KEY(customer_id,business_id) REFERENCES core.customers(id,business_id),
 FOREIGN KEY(confirmation_evidence_id,business_id,customer_id) REFERENCES core.vip_confirmation_evidence(id,business_id,customer_id),
 CHECK((state='issued' AND redeemed_at IS NULL AND redeemed_by IS NULL AND redemption_id IS NULL)
 OR(state='redeemed' AND redeemed_at IS NOT NULL AND redeemed_by IS NOT NULL AND redemption_id IS NOT NULL))
);
ALTER TABLE core.offer_redemptions ADD COLUMN coupon_id uuid,ADD COLUMN receipt_ref text,
 ALTER COLUMN order_id DROP NOT NULL,
 ADD CONSTRAINT coupon_redemption_fk FOREIGN KEY(coupon_id,business_id,campaign_id,customer_id)
 REFERENCES core.campaign_coupons(id,business_id,campaign_id,customer_id),
 ADD CONSTRAINT redemption_requires_real_order_or_coupon CHECK(order_id IS NOT NULL OR(coupon_id IS NOT NULL AND source='staff_mark')),
 ADD CONSTRAINT coupon_redemption_shape CHECK(coupon_id IS NULL OR(source='staff_mark' AND units=1 AND receipt_ref IS NOT NULL AND length(btrim(receipt_ref)) BETWEEN 1 AND 128));
CREATE UNIQUE INDEX coupon_receipt_one_reward ON core.offer_redemptions(business_id,campaign_id,receipt_ref) WHERE coupon_id IS NOT NULL;
CREATE UNIQUE INDEX coupon_one_redemption ON core.offer_redemptions(coupon_id) WHERE coupon_id IS NOT NULL;
ALTER TABLE core.campaign_coupons ADD CONSTRAINT coupon_redemption_link FOREIGN KEY(redemption_id,business_id,campaign_id)
 REFERENCES core.offer_redemptions(id,business_id,campaign_id);
CREATE TABLE core.coupon_welcome_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),business_id uuid NOT NULL REFERENCES core.businesses(id),
 coupon_id uuid NOT NULL UNIQUE REFERENCES core.campaign_coupons(id),message_key text NOT NULL UNIQUE,event_unique_id text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','claimed','provider_accepted','unknown','blocked')),
 job_lease_id uuid,lease_expires_at timestamptz,message_reservation_id uuid REFERENCES core.message_log(id),provider_event_id text,
 safe_code text CHECK(safe_code IS NULL OR safe_code ~ '^[a-z0-9_]{1,80}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((status='queued')=(job_lease_id IS NULL)),CHECK((job_lease_id IS NULL)=(lease_expires_at IS NULL))
);
DO $private$ DECLARE n text; BEGIN FOREACH n IN ARRAY ARRAY['vip_confirmation_evidence','campaign_coupons','coupon_welcome_outbox'] LOOP
 EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY',n);
 EXECUTE format('REVOKE ALL ON TABLE core.%I FROM PUBLIC,anon,authenticated,service_role',n);
 END LOOP; END $private$;

CREATE FUNCTION core.coupon_history_guard_v1() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'K10_COUPON_HISTORY_IMMUTABLE' USING ERRCODE='42501'; END $$;
CREATE TRIGGER vip_confirmation_evidence_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON core.vip_confirmation_evidence
 FOR EACH STATEMENT EXECUTE FUNCTION core.coupon_history_guard_v1();
CREATE TRIGGER campaign_coupons_no_remove BEFORE DELETE OR TRUNCATE ON core.campaign_coupons
 FOR EACH STATEMENT EXECUTE FUNCTION core.coupon_history_guard_v1();
CREATE TRIGGER coupon_welcome_no_remove BEFORE DELETE OR TRUNCATE ON core.coupon_welcome_outbox
 FOR EACH STATEMENT EXECUTE FUNCTION core.coupon_history_guard_v1();

CREATE FUNCTION core.coupon_campaign_guard_v1() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF NEW.campaign_kind='signup_reward' AND cardinality(NEW.coupon_channels) IS DISTINCT FROM (SELECT count(DISTINCT x) FROM unnest(NEW.coupon_channels) x) THEN
 RAISE EXCEPTION 'K10_DUPLICATE_CHANNEL' USING ERRCODE='22023';END IF;
 IF NEW.campaign_kind='signup_reward' AND EXISTS(SELECT 1 FROM jsonb_each_text(NEW.coupon_order_type_map) m
 WHERE m.key !~ '^[A-Za-z0-9]{8,32}$' OR NOT m.value=ANY(NEW.coupon_channels)) THEN
  RAISE EXCEPTION 'K10_INVALID_CHANNEL_MAP' USING ERRCODE='22023'; END IF;
 IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM core.campaign_coupons WHERE campaign_id=OLD.id)
 AND (to_jsonb(NEW)-ARRAY['status','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','version','updated_at']) THEN
  RAISE EXCEPTION 'K10_ISSUED_COUPON_TERMS_IMMUTABLE' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER coupon_campaign_guard BEFORE INSERT OR UPDATE ON core.campaigns
 FOR EACH ROW EXECUTE FUNCTION core.coupon_campaign_guard_v1();

CREATE FUNCTION core.coupon_normalize_code_v1(p_code text) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE c text; BEGIN
 c:=upper(regexp_replace(COALESCE(p_code,''),'[[:space:]-]','','g'));
 IF c !~ '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$' THEN
  RAISE EXCEPTION 'Invalid coupon code' USING ERRCODE='22023'; END IF;
 RETURN substr(c,1,4)||'-'||substr(c,5,4)||'-'||substr(c,9,4)||'-'||substr(c,13,4);
END $$;
CREATE FUNCTION core.coupon_random_code_v1() RETURNS text LANGUAGE plpgsql VOLATILE SET search_path='' AS $$
DECLARE bytes bytea:=extensions.gen_random_bytes(10);alphabet text:='23456789ABCDEFGHJKLMNPQRSTUVWXYZ';out text:='';v integer:=0;n integer:=0;b integer;i integer;
BEGIN
 FOR i IN 0..9 LOOP v:=(v<<8)|get_byte(bytes,i);n:=n+8;
  WHILE n>=5 LOOP n:=n-5;out:=out||substr(alphabet,((v>>n)&31)+1,1);END LOOP;
  v:=v&((1<<n)-1);
 END LOOP;
 RETURN core.coupon_normalize_code_v1(out);
END $$;

CREATE FUNCTION core.coupon_issue_private_v1(p_business_id uuid,p_customer_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE c core.campaigns%ROWTYPE;u core.customers%ROWTYPE;e core.vip_confirmation_evidence%ROWTYPE;
 cp core.campaign_coupons%ROWTYPE;v_code text;v_count integer:=0;v_attempt integer;
BEGIN
 -- Serialize consent before issuing. NO KEY UPDATE is compatible with the
 -- redemption FK's KEY SHARE; skip already-issued campaigns before locking.
 SELECT * INTO u FROM core.customers WHERE id=p_customer_id AND business_id=p_business_id FOR NO KEY UPDATE;
 IF NOT FOUND OR u.email_status<>'subscribed' OR u.email_suppressed_at IS NOT NULL
 OR EXISTS(SELECT 1 FROM core.klaviyo_email_observations o WHERE o.customer_id=u.id AND(o.blocked_at IS NOT NULL OR o.status IN('suppressed','unsubscribed'))) THEN
  RETURN jsonb_build_object('issued',0,'code','customer_ineligible'); END IF;
 FOR c IN SELECT * FROM core.campaigns WHERE business_id=p_business_id AND campaign_kind='signup_reward'
 AND status='active' AND starts_at<=statement_timestamp() AND(ends_at IS NULL OR ends_at>statement_timestamp())
 AND is_test=u.is_test AND NOT EXISTS(SELECT 1 FROM core.campaign_coupons cp_ WHERE cp_.campaign_id=core.campaigns.id AND cp_.customer_id=u.id) ORDER BY id FOR UPDATE LOOP
  SELECT * INTO e FROM core.vip_confirmation_evidence ev WHERE ev.customer_id=u.id AND ev.business_id=p_business_id
  AND ev.evidence->>'listId'=c.vip_list_id AND ev.email_sha256=encode(sha256(convert_to(lower(btrim(u.email)),'UTF8')),'hex')
  ORDER BY ev.confirmed_at DESC,ev.id LIMIT 1;
  IF NOT FOUND OR EXISTS(SELECT 1 FROM core.campaign_coupons WHERE campaign_id=c.id AND customer_id=u.id) THEN CONTINUE;END IF;
  FOR v_attempt IN 1..5 LOOP
   v_code:=core.coupon_random_code_v1();
   BEGIN
    INSERT INTO core.campaign_coupons(business_id,campaign_id,customer_id,confirmation_evidence_id,code,qr_token,expires_at,is_test)
    VALUES(p_business_id,c.id,u.id,e.id,v_code,encode(extensions.gen_random_bytes(16),'hex'),c.ends_at,u.is_test) RETURNING * INTO cp;
    EXIT;
   EXCEPTION WHEN unique_violation THEN
    IF EXISTS(SELECT 1 FROM core.campaign_coupons WHERE campaign_id=c.id AND customer_id=u.id) THEN EXIT;END IF;
    IF v_attempt=5 THEN RAISE EXCEPTION 'K10_COUPON_RANDOM_COLLISION_LIMIT';END IF;
   END;
  END LOOP;
  IF cp.id IS NOT NULL THEN
   INSERT INTO core.coupon_welcome_outbox(business_id,coupon_id,message_key,event_unique_id)
   VALUES(p_business_id,cp.id,'coupon-welcome:'||cp.id::text,cp.id::text);
   v_count:=v_count+1;cp:=NULL;
  END IF;
 END LOOP;
 RETURN jsonb_build_object('issued',v_count,'code','ok');
END $$;
CREATE FUNCTION core.coupon_subscriber_trigger_v1() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN IF NEW.email_status='subscribed' AND NEW.email_suppressed_at IS NULL THEN
 PERFORM core.coupon_issue_private_v1(NEW.business_id,NEW.id); END IF;RETURN NEW;END $$;
CREATE TRIGGER coupon_subscriber_issue AFTER INSERT OR UPDATE OF email_status,email_suppressed_at ON core.customers
 FOR EACH ROW EXECUTE FUNCTION core.coupon_subscriber_trigger_v1();
CREATE FUNCTION public.coupon_issue_confirmed_v1(p_business_id uuid,p_customer_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 RETURN core.coupon_issue_private_v1(p_business_id,p_customer_id); END $$;

CREATE FUNCTION public.coupon_confirmation_context_v1(p_business_id uuid,p_customer_id uuid,p_signup_id uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE u core.customers%ROWTYPE;s core.signups%ROWTYPE;v_list text;v_count integer;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 SELECT * INTO u FROM core.customers WHERE id=p_customer_id AND business_id=p_business_id;
 SELECT * INTO s FROM core.signups WHERE id=p_signup_id AND customer_id=p_customer_id AND business_id=p_business_id;
 IF u.id IS NULL OR s.id IS NULL OR NOT s.consent_email OR s.source NOT IN('website_vip_form','website_vip_page')
 OR s.is_test IS DISTINCT FROM u.is_test OR lower(btrim(s.email)) IS DISTINCT FROM lower(btrim(u.email)) OR u.email_status='unsubscribed' OR u.email_suppressed_at IS NOT NULL
 OR EXISTS(SELECT 1 FROM core.klaviyo_email_observations o WHERE o.customer_id=u.id AND(o.blocked_at IS NOT NULL OR o.status IN('suppressed','unsubscribed'))) THEN
 RETURN jsonb_build_object('allowed',false,'code','customer_ineligible');END IF;
 SELECT count(DISTINCT vip_list_id),min(vip_list_id) INTO v_count,v_list FROM core.campaigns WHERE business_id=p_business_id
 AND campaign_kind='signup_reward' AND is_test=u.is_test;
 IF v_count<>1 THEN RETURN jsonb_build_object('allowed',false,'code','campaign_configuration_unavailable');END IF;
 RETURN jsonb_build_object('allowed',true,'code','ok','businessId',u.business_id,'customerId',u.id,'signupId',s.id,
 'email',lower(btrim(u.email)),'vipListId',v_list,'requestedAt',s.created_at,'isTest',u.is_test);
END $$;
CREATE FUNCTION public.coupon_record_confirmed_vip_v1(p_business_id uuid,p_customer_id uuid,p_signup_id uuid,
 p_provider_profile_id text,p_confirmed_at timestamptz,p_checked_at timestamptz,p_evidence jsonb) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u core.customers%ROWTYPE;s core.signups%ROWTYPE;ev core.vip_confirmation_evidence%ROWTYPE;v_result jsonb;v_before integer;v_after integer;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 IF p_provider_profile_id IS NULL OR length(btrim(p_provider_profile_id)) NOT BETWEEN 1 AND 100
 OR p_confirmed_at IS NULL OR NOT isfinite(p_confirmed_at) OR p_checked_at IS NULL OR NOT isfinite(p_checked_at)
 OR p_confirmed_at>p_checked_at OR p_checked_at>clock_timestamp()+interval '1 minute' OR p_checked_at<clock_timestamp()-interval '5 minutes'
 OR p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'object' OR octet_length(p_evidence::text)>8192
 OR p_evidence->>'source' IS DISTINCT FROM 'klaviyo' OR p_evidence->'doubleOptIn' IS DISTINCT FROM 'true'::jsonb
 OR p_evidence->'canReceiveEmailMarketing' IS DISTINCT FROM 'true'::jsonb OR p_evidence->>'consent' IS DISTINCT FROM 'SUBSCRIBED'
 OR p_evidence->>'emailSha256' !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid dated double opt-in evidence' USING ERRCODE='22023';END IF;
 SELECT * INTO u FROM core.customers WHERE id=p_customer_id AND business_id=p_business_id FOR NO KEY UPDATE;
 SELECT * INTO s FROM core.signups WHERE id=p_signup_id AND customer_id=p_customer_id AND business_id=p_business_id;
 IF u.id IS NULL OR s.id IS NULL OR NOT s.consent_email OR s.source NOT IN('website_vip_form','website_vip_page')
 OR s.is_test IS DISTINCT FROM u.is_test OR s.created_at>p_confirmed_at OR s.is_test IS DISTINCT FROM u.is_test OR lower(btrim(s.email)) IS DISTINCT FROM lower(btrim(u.email))
 OR p_evidence->>'emailSha256' IS DISTINCT FROM encode(sha256(convert_to(lower(btrim(u.email)),'UTF8')),'hex')
 OR NOT EXISTS(SELECT 1 FROM core.consent_events ce WHERE ce.customer_id=u.id AND ce.signup_id=s.id AND ce.event_type='request' AND ce.email_requested)
 OR NOT EXISTS(SELECT 1 FROM core.campaigns c WHERE c.business_id=p_business_id AND c.campaign_kind='signup_reward'
 AND c.vip_list_id=p_evidence->>'listId' AND c.is_test=u.is_test) THEN
 RAISE EXCEPTION 'VIP evidence does not match local request/configuration' USING ERRCODE='22023';END IF;
 IF u.email_status='unsubscribed' OR u.email_suppressed_at IS NOT NULL OR EXISTS(SELECT 1 FROM core.klaviyo_email_observations o
 WHERE o.customer_id=u.id AND(o.blocked_at IS NOT NULL OR o.status IN('unsubscribed','suppressed'))) THEN
 RETURN jsonb_build_object('confirmed',false,'code','customer_blocked','issued',0);END IF;
 SELECT count(*) INTO v_before FROM core.campaign_coupons WHERE business_id=p_business_id AND customer_id=u.id;
 INSERT INTO core.vip_confirmation_evidence(business_id,customer_id,signup_id,provider_profile_id,confirmed_at,checked_at,email_sha256,evidence)
 VALUES(p_business_id,u.id,s.id,btrim(p_provider_profile_id),p_confirmed_at,p_checked_at,p_evidence->>'emailSha256',p_evidence)
 ON CONFLICT(business_id,customer_id,provider_profile_id,confirmed_at) DO NOTHING RETURNING * INTO ev;
 IF u.email_status<>'subscribed' THEN UPDATE core.customers SET email_status='subscribed',updated_at=clock_timestamp() WHERE id=u.id;END IF;
 v_result:=core.coupon_issue_private_v1(p_business_id,u.id);
 SELECT count(*) INTO v_after FROM core.campaign_coupons WHERE business_id=p_business_id AND customer_id=u.id;
 RETURN jsonb_build_object('confirmed',true,'code','confirmed','issued',v_after-v_before,'idempotent',ev.id IS NULL);
END $$;

CREATE FUNCTION core.coupon_lookup_private_v1(p_business_id uuid,p_code text) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE cp core.campaign_coupons%ROWTYPE;c core.campaigns%ROWTYPE;v_name text;v_status text;
BEGIN
 SELECT * INTO cp FROM core.campaign_coupons WHERE code=core.coupon_normalize_code_v1(p_code);
 IF NOT FOUND OR cp.business_id<>p_business_id THEN RETURN jsonb_build_object('status',CASE WHEN cp.id IS NULL THEN 'not_found' ELSE 'wrong_business' END,
 'valid',false,'reason',CASE WHEN cp.id IS NULL THEN 'not_found' ELSE 'wrong_business' END,'customerNameMasked',NULL,'campaign',NULL,'couponId',NULL,'expiresAt',NULL,'redeemedAt',NULL);END IF;
 SELECT * INTO c FROM core.campaigns WHERE id=cp.campaign_id;
 SELECT CASE WHEN NULLIF(btrim(name),'') IS NULL THEN '***' ELSE left(btrim(name),1)||'***' END INTO v_name FROM core.customers WHERE id=cp.customer_id;
 v_status:=CASE WHEN cp.state='redeemed' THEN 'used' WHEN cp.expires_at<=statement_timestamp() THEN 'expired'
 WHEN c.status<>'active' OR c.starts_at>statement_timestamp() OR c.ends_at<=statement_timestamp() THEN 'inactive' ELSE 'valid' END;
 RETURN jsonb_build_object('status',v_status,'valid',v_status='valid','reason',CASE WHEN v_status='inactive' THEN 'campaign_inactive' ELSE v_status END,
 'customerNameMasked',v_name,'campaign',jsonb_build_object('id',c.id,'name',c.name,'benefitType','item','minimumAmountCents',c.min_amount_cents,'channels',c.coupon_channels,'units',1),
 'couponId',cp.id,'expiresAt',cp.expires_at,'redeemedAt',cp.redeemed_at);
END $$;
CREATE FUNCTION public.coupon_lookup_v1(p_business_id uuid,p_code text) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN IF auth.role() IS DISTINCT FROM 'authenticated' OR NOT core.staff_authorized_v1(p_business_id,'campaign.staff_mark') THEN
 RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 RETURN core.coupon_lookup_private_v1(p_business_id,p_code);END $$;

-- Preserve every historical order reward predicate. The extra dispatch guard
-- prevents a signup-earned benefit or its refund from bypassing the coupon.
ALTER FUNCTION core.campaign_eligibility_rules_v1(uuid,uuid,uuid,integer,text) RENAME TO campaign_order_eligibility_rules_v1;
REVOKE ALL ON FUNCTION core.campaign_order_eligibility_rules_v1(uuid,uuid,uuid,integer,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION core.campaign_eligibility_rules_v1(p_business_id uuid,p_campaign_id uuid,p_order_id uuid,p_units integer,p_stage text DEFAULT 'all')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM core.campaigns WHERE id=p_campaign_id AND business_id=p_business_id AND campaign_kind='signup_reward') THEN
 RETURN jsonb_build_object('eligible',false,'code','coupon_required');END IF;
 RETURN core.campaign_order_eligibility_rules_v1(p_business_id,p_campaign_id,p_order_id,p_units,p_stage);
END $$;
REVOKE ALL ON FUNCTION core.campaign_eligibility_rules_v1(uuid,uuid,uuid,integer,text) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION public.campaign_evaluate_v1(uuid,uuid,uuid,integer,text,uuid,text) SET SCHEMA core;
ALTER FUNCTION core.campaign_evaluate_v1(uuid,uuid,uuid,integer,text,uuid,text) RENAME TO campaign_order_evaluate_v1;
REVOKE ALL ON FUNCTION core.campaign_order_evaluate_v1(uuid,uuid,uuid,integer,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.campaign_evaluate_v1(p_business_id uuid,p_campaign_id uuid,p_order_id uuid,p_units integer DEFAULT 1,
 p_source text DEFAULT 'clover_trace',p_staff_actor uuid DEFAULT NULL,p_staff_note text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM core.campaigns WHERE business_id=p_business_id AND id=p_campaign_id AND campaign_kind='signup_reward') THEN
 RETURN jsonb_build_object('applied',false,'code','coupon_required');END IF;
 RETURN core.campaign_order_evaluate_v1(p_business_id,p_campaign_id,p_order_id,p_units,p_source,p_staff_actor,p_staff_note);
END $$;

-- Signup coupons never masquerade as the older order-earned eligibility label.
CREATE OR REPLACE FUNCTION public.campaign_eligibility_check_v1(p_business_id uuid,p_clover_order_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE o core.orders%ROWTYPE; c core.campaigns%ROWTYPE; v_rule jsonb; v_check jsonb;
  v_candidates jsonb:='[]'::jsonb; v_selected jsonb; v_first jsonb; v_unknown jsonb;
  v_count integer:=0; v_unknown_count integer:=0;
  v_known boolean; v_code text; v_context jsonb:=jsonb_build_object('checkedAt',statement_timestamp(),'snapshotAt',NULL);
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated'
    OR NOT core.staff_authorized_v1(p_business_id,'orders.read') THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE='42501'; END IF;
  IF p_clover_order_id IS NULL OR p_clover_order_id !~ '^[A-Za-z0-9]{8,32}$' THEN
    RAISE EXCEPTION 'Invalid Clover order ID' USING ERRCODE='22023'; END IF;
  SELECT * INTO o FROM core.orders WHERE business_id=p_business_id AND clover_order_id=p_clover_order_id;
  IF NOT FOUND THEN RETURN v_context||jsonb_build_object('known',false,'eligible',NULL,'reason','order_not_synced',
    'campaign',NULL,'remaining',NULL,'candidates',v_candidates); END IF;
  v_context:=v_context||jsonb_build_object('snapshotAt',o.last_seen_at);
  -- Do not infer a gift right from unrelated monetary/percentage campaigns.
  FOR c IN SELECT * FROM core.campaigns WHERE business_id=p_business_id AND status='active'
    AND benefit_type='item' AND campaign_kind='order_reward' ORDER BY starts_at,id LOOP
    v_rule:=core.campaign_eligibility_rules_v1(p_business_id,c.id,o.id,1,'all');
    IF EXISTS(SELECT 1 FROM core.offer_redemptions WHERE campaign_id=c.id AND order_id=o.id) THEN
      v_rule:=jsonb_build_object('eligible',false,'code','already_applied','remaining',
        CASE WHEN jsonb_typeof(v_rule->'remaining')='object'
          THEN jsonb_set(v_rule->'remaining','{person}','0'::jsonb)
          ELSE jsonb_build_object('person',0,'total',NULL,'perOrder',c.max_units_per_order) END);
    END IF;
    v_code:=v_rule->>'code';
    v_known:=v_code NOT IN('order_unmatched','amount_evidence_missing','order_not_found','campaign_not_found');
    v_check:=jsonb_build_object('known',v_known,'eligible',CASE WHEN v_known THEN (v_rule->>'eligible')::boolean END,
      'reason',v_code,'campaign',jsonb_build_object('id',c.id,'name',c.name,'benefitType',c.benefit_type,
        'targetItemId',c.target_clover_item_id),'remaining',v_rule->'remaining');
    v_candidates:=v_candidates||jsonb_build_array(v_check);
    IF v_first IS NULL THEN v_first:=v_check; END IF;
    IF NOT v_known THEN v_unknown_count:=v_unknown_count+1;
      IF v_unknown IS NULL THEN v_unknown:=v_check; END IF; END IF;
    IF (v_rule->>'eligible')::boolean THEN v_count:=v_count+1; v_selected:=v_check; END IF;
  END LOOP;
  IF v_count>1 OR (v_count=1 AND v_unknown_count>0) THEN RETURN v_context||jsonb_build_object('known',false,'eligible',NULL,'reason','ambiguous_campaign',
    'campaign',NULL,'remaining',NULL,'candidates',v_candidates); END IF;
  IF v_selected IS NULL THEN v_selected:=COALESCE(v_unknown,v_first); END IF;
  IF v_selected IS NULL THEN
    v_code:=CASE WHEN EXISTS(SELECT 1 FROM core.campaigns WHERE business_id=p_business_id AND status='active')
      THEN 'no_item_campaign' ELSE 'no_active_campaign' END;
    RETURN v_context||jsonb_build_object('known',true,'eligible',false,'reason',v_code,
      'campaign',NULL,'remaining',NULL,'candidates',v_candidates); END IF;
  RETURN v_context||v_selected||jsonb_build_object('candidates',v_candidates);
END $$;

CREATE OR REPLACE FUNCTION core.campaign_redemption_guard_v1() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE c core.campaigns%ROWTYPE;cp core.campaign_coupons%ROWTYPE;v_total numeric;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.coupon_id IS NOT NULL THEN RAISE EXCEPTION 'K10_COUPON_USE_NEVER_VOIDED' USING ERRCODE='42501';END IF;
  IF ROW(NEW.id,NEW.business_id,NEW.campaign_id,NEW.customer_id,NEW.order_id,NEW.applied_at,NEW.source,NEW.staff_actor,NEW.staff_note,NEW.period_key,NEW.units,NEW.snapshot,NEW.coupon_id,NEW.receipt_ref)
  IS DISTINCT FROM ROW(OLD.id,OLD.business_id,OLD.campaign_id,OLD.customer_id,OLD.order_id,OLD.applied_at,OLD.source,OLD.staff_actor,OLD.staff_note,OLD.period_key,OLD.units,OLD.snapshot,OLD.coupon_id,OLD.receipt_ref)
  OR OLD.status<>'applied' OR NEW.status<>'voided' OR NEW.voided_at IS NULL OR NEW.void_reason IS NULL THEN
   RAISE EXCEPTION 'K9_REDEMPTION_IMMUTABLE' USING ERRCODE='42501';END IF;
  IF NEW.quota_reserved IS DISTINCT FROM(NOT CASE NEW.void_reason WHEN 'full_refund' THEN(OLD.snapshot#>>'{campaign,restore_on_full_refund}')::boolean
  WHEN 'partial_below_minimum' THEN(OLD.snapshot#>>'{campaign,restore_on_partial_below_minimum}')::boolean END) THEN
   RAISE EXCEPTION 'K9_REFUND_POLICY_MISMATCH' USING ERRCODE='23514';END IF;RETURN NEW;
 END IF;
 SELECT * INTO c FROM core.campaigns WHERE id=NEW.campaign_id AND business_id=NEW.business_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'K9_CAMPAIGN_TENANT_MISMATCH' USING ERRCODE='23514';END IF;
 PERFORM 1 FROM core.customers WHERE id=NEW.customer_id AND business_id=NEW.business_id FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'K9_CUSTOMER_TENANT_MISMATCH' USING ERRCODE='23514';END IF;
 IF NEW.status<>'applied' OR NOT NEW.quota_reserved OR NEW.units>c.max_units_per_order OR NEW.snapshot->'campaign' IS DISTINCT FROM to_jsonb(c) THEN
 RAISE EXCEPTION 'K9_INVALID_REDEMPTION_LIMIT_OR_SNAPSHOT' USING ERRCODE='23514';END IF;
 IF c.campaign_kind='signup_reward' THEN
  SELECT * INTO cp FROM core.campaign_coupons WHERE id=NEW.coupon_id AND business_id=NEW.business_id AND campaign_id=c.id AND customer_id=NEW.customer_id FOR UPDATE;
  IF cp.id IS NULL OR cp.state<>'issued' OR NEW.source<>'staff_mark' OR NEW.staff_actor IS DISTINCT FROM auth.uid()
  OR NOT core.staff_authorized_v1(NEW.business_id,'campaign.staff_mark') OR NEW.units<>1
  OR NEW.period_key<>'campaign:'||c.id::text OR NEW.snapshot#>>'{coupon,id}' IS DISTINCT FROM cp.id::text THEN
   RAISE EXCEPTION 'K10_COUPON_REDEMPTION_REQUIRED' USING ERRCODE='42501';END IF;
 ELSIF NEW.coupon_id IS NOT NULL OR NEW.order_id IS NULL THEN RAISE EXCEPTION 'K9_REAL_ORDER_REQUIRED' USING ERRCODE='23514';END IF;
 SELECT reserved_units INTO STRICT v_total FROM core.campaign_usage WHERE campaign_id=c.id;
 IF c.max_total_units IS NOT NULL AND v_total+NEW.units>c.max_total_units THEN RAISE EXCEPTION 'K9_TOTAL_LIMIT' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION core.coupon_state_guard_v1() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF (to_jsonb(NEW)-ARRAY['state','redeemed_at','redeemed_by','redemption_id']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','redeemed_at','redeemed_by','redemption_id'])
 OR OLD.state<>'issued' OR NEW.state<>'redeemed' OR NOT EXISTS(SELECT 1 FROM core.offer_redemptions r WHERE r.id=NEW.redemption_id AND r.coupon_id=OLD.id
 AND r.business_id=OLD.business_id AND r.campaign_id=OLD.campaign_id AND r.customer_id=OLD.customer_id AND r.status='applied' AND r.staff_actor=NEW.redeemed_by AND r.applied_at=NEW.redeemed_at) THEN
 RAISE EXCEPTION 'K10_COUPON_STATE_IMMUTABLE' USING ERRCODE='42501';END IF;RETURN NEW;
END $$;
CREATE TRIGGER coupon_state_guard BEFORE UPDATE ON core.campaign_coupons FOR EACH ROW EXECUTE FUNCTION core.coupon_state_guard_v1();

CREATE FUNCTION core.coupon_outbox_state_guard_v1() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF ROW(NEW.id,NEW.business_id,NEW.coupon_id,NEW.message_key,NEW.event_unique_id,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.business_id,OLD.coupon_id,OLD.message_key,OLD.event_unique_id,OLD.created_at)
 OR(OLD.job_lease_id IS NOT NULL AND ROW(NEW.job_lease_id,NEW.lease_expires_at) IS DISTINCT FROM ROW(OLD.job_lease_id,OLD.lease_expires_at))
 OR(OLD.status IN('provider_accepted','unknown','blocked') AND NEW IS DISTINCT FROM OLD)
 OR(OLD.status='queued' AND NEW.status<>'claimed')
 OR(OLD.status='claimed' AND NEW.status NOT IN('provider_accepted','unknown','blocked')) THEN
 RAISE EXCEPTION 'K10_WELCOME_OUTBOX_IMMUTABLE' USING ERRCODE='42501';END IF;RETURN NEW;
END $$;
CREATE TRIGGER coupon_outbox_state_guard BEFORE UPDATE ON core.coupon_welcome_outbox FOR EACH ROW EXECUTE FUNCTION core.coupon_outbox_state_guard_v1();

CREATE FUNCTION public.coupon_redeem_v1(p_business_id uuid,p_code text,p_clover_order_id text DEFAULT NULL,p_note jsonb DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE cp core.campaign_coupons%ROWTYPE;c core.campaigns%ROWTYPE;o core.orders%ROWTYPE;r core.offer_redemptions%ROWTYPE;
 s record;a record;v_code text;v_receipt text;v_channel text;v_amount bigint;v_now timestamptz:=clock_timestamp();v_lookup jsonb;v_snapshot jsonb;v_amount_evidence jsonb;
BEGIN
 IF auth.role() IS DISTINCT FROM 'authenticated' OR NOT core.staff_authorized_v1(p_business_id,'campaign.staff_mark') THEN
  RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'K10_READ_COMMITTED_REQUIRED' USING ERRCODE='25000';END IF;
 v_code:=core.coupon_normalize_code_v1(p_code);
 SELECT * INTO cp FROM core.campaign_coupons WHERE code=v_code;
 IF NOT FOUND OR cp.business_id<>p_business_id THEN RETURN jsonb_build_object('redeemed',false,'status',CASE WHEN cp.id IS NULL THEN 'not_found' ELSE 'wrong_business' END,'code',CASE WHEN cp.id IS NULL THEN 'not_found' ELSE 'wrong_business' END);END IF;
 -- Customer consent is locked before any signup campaign. Optional order is
 -- also locked first: never hold a signup campaign while waiting on a K9
 -- order writer (which may itself be waiting on a consent transaction).
 PERFORM 1 FROM core.customers WHERE id=cp.customer_id AND business_id=p_business_id FOR SHARE;
 IF p_clover_order_id IS NOT NULL THEN
  IF p_clover_order_id !~ '^[A-Za-z0-9]{8,32}$' THEN RAISE EXCEPTION 'Invalid Clover order ID' USING ERRCODE='22023';END IF;
  SELECT * INTO o FROM core.orders WHERE business_id=p_business_id AND clover_order_id=p_clover_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('redeemed',false,'status','invalid','code','order_not_synced');END IF;
 END IF;
 SELECT * INTO c FROM core.campaigns WHERE id=cp.campaign_id AND business_id=p_business_id FOR UPDATE;
 SELECT * INTO cp FROM core.campaign_coupons WHERE code=v_code AND business_id=p_business_id FOR UPDATE;
 IF cp.state='redeemed' THEN RETURN jsonb_build_object('redeemed',false,'status','used','code','already_used','couponId',cp.id,'redemptionId',cp.redemption_id,'redeemedAt',cp.redeemed_at);END IF;
 v_lookup:=core.coupon_lookup_private_v1(p_business_id,v_code);
 IF NOT(v_lookup->>'valid')::boolean THEN RETURN jsonb_build_object('redeemed',false,'status',v_lookup->>'status','code',v_lookup->>'reason');END IF;
 IF p_note IS NULL OR jsonb_typeof(p_note)<>'object' OR octet_length(p_note::text)>8192
 OR p_note->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(p_note->'text') IS DISTINCT FROM 'string'
 OR length(btrim(p_note->>'text')) NOT BETWEEN 1 AND 1000 OR p_note->>'text' !~ '[^[:space:]]'
 OR jsonb_typeof(p_note->'channel') IS DISTINCT FROM 'string' OR jsonb_typeof(p_note->'receiptRef') IS DISTINCT FROM 'string'
 OR length(btrim(p_note->>'receiptRef')) NOT BETWEEN 1 AND 120 OR p_note->>'receiptRef' !~ '[^[:space:]]'
 OR jsonb_typeof(p_note->'qualifyingAmountCents') IS DISTINCT FROM 'number' OR p_note->>'qualifyingAmountCents' !~ '^[0-9]{1,12}$'
 OR jsonb_typeof(p_note->'receiptAt') IS DISTINCT FROM 'string' OR p_note->>'receiptAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
 RETURN jsonb_build_object('redeemed',false,'status','invalid','code','attestation_required');END IF;
 BEGIN
 IF NOT isfinite((p_note->>'receiptAt')::timestamptz) OR (p_note->>'receiptAt')::timestamptz<cp.issued_at
 OR (p_note->>'receiptAt')::timestamptz>clock_timestamp() THEN
 RETURN jsonb_build_object('redeemed',false,'status','invalid','code','order_before_coupon');END IF;
 EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
 RETURN jsonb_build_object('redeemed',false,'status','invalid','code','attestation_required');END;
 v_channel:=p_note->>'channel';v_amount:=(p_note->>'qualifyingAmountCents')::bigint;v_receipt:='staff:'||btrim(p_note->>'receiptRef');
 IF p_clover_order_id IS NOT NULL THEN
  IF o.created_at<cp.issued_at OR o.created_at>clock_timestamp() THEN RETURN jsonb_build_object('redeemed',false,'status','invalid','code','order_before_coupon');END IF;
  IF o.customer_id IS DISTINCT FROM cp.customer_id OR o.match_status NOT IN('exact','staff_resolved') THEN RETURN jsonb_build_object('redeemed',false,'status','invalid','code','order_unmatched');END IF;
  SELECT * INTO s FROM core.clover_order_status_v1(o.id);
  IF s.status<>'paid' OR s.net_cents<=0 THEN RETURN jsonb_build_object('redeemed',false,'status','invalid','code','order_not_paid');END IF;
  SELECT * INTO a FROM core.campaign_amount_v1(o.id,false,false);
  IF NOT a.known THEN RETURN jsonb_build_object('redeemed',false,'status','invalid','code','amount_evidence_missing');END IF;
  IF c.coupon_order_type_map->>o.clover_order_type_id IS NULL
  OR NOT(c.coupon_order_type_map->>o.clover_order_type_id)=ANY(c.coupon_channels)
  OR(o.online_order IS DISTINCT FROM((c.coupon_order_type_map->>o.clover_order_type_id)<>'dine_in')) THEN
   RETURN jsonb_build_object('redeemed',false,'status','invalid','code','channel_not_allowed');END IF;
  IF v_channel IS DISTINCT FROM c.coupon_order_type_map->>o.clover_order_type_id OR v_amount IS DISTINCT FROM a.amount_cents THEN
   RETURN jsonb_build_object('redeemed',false,'status','invalid','code','attestation_mismatch');END IF;
  v_receipt:='clover:'||o.clover_order_id;v_amount:=a.amount_cents;v_amount_evidence:=a.evidence;
 END IF;
 IF NOT v_channel=ANY(c.coupon_channels) THEN RETURN jsonb_build_object('redeemed',false,'status','invalid','code','channel_not_allowed');END IF;
 IF v_amount<c.min_amount_cents THEN RETURN jsonb_build_object('redeemed',false,'status','invalid','code','below_minimum');END IF;
 IF EXISTS(SELECT 1 FROM core.offer_redemptions WHERE business_id=p_business_id AND campaign_id=c.id AND(receipt_ref=v_receipt OR(order_id=o.id AND o.id IS NOT NULL))) THEN
  RETURN jsonb_build_object('redeemed',false,'status','invalid','code','order_already_rewarded');END IF;
 IF EXISTS(SELECT 1 FROM core.offer_redemptions WHERE campaign_id=c.id AND customer_id=cp.customer_id AND quota_reserved) THEN
  RETURN jsonb_build_object('redeemed',false,'status','used','code','already_used');END IF;
 IF c.max_total_units IS NOT NULL AND(SELECT reserved_units FROM core.campaign_usage WHERE campaign_id=c.id)>=c.max_total_units THEN
  RETURN jsonb_build_object('redeemed',false,'status','invalid','code','total_limit');END IF;
 v_snapshot:=jsonb_build_object('schemaVersion',1,'campaign',to_jsonb(c),'coupon',jsonb_build_object('id',cp.id,'confirmationEvidenceId',cp.confirmation_evidence_id),
 'staffEvidence',p_note,'evidenceMode',CASE WHEN o.id IS NULL THEN 'staff_attested' ELSE 'clover_verified' END,
 'amountEvidence',v_amount_evidence,'receiptRef',v_receipt,'evaluatedAt',v_now);
 INSERT INTO core.offer_redemptions(business_id,campaign_id,customer_id,order_id,applied_at,source,staff_actor,staff_note,period_key,units,snapshot,coupon_id,receipt_ref)
 VALUES(p_business_id,c.id,cp.customer_id,o.id,v_now,'staff_mark',auth.uid(),btrim(p_note->>'text'),'campaign:'||c.id::text,1,v_snapshot,cp.id,v_receipt) RETURNING * INTO r;
 UPDATE core.campaign_coupons SET state='redeemed',redeemed_at=v_now,redeemed_by=auth.uid(),redemption_id=r.id WHERE id=cp.id;
 INSERT INTO core.campaign_events(business_id,campaign_id,redemption_id,event_type,actor_id,payload)
 VALUES(p_business_id,c.id,r.id,'applied',auth.uid(),jsonb_build_object('couponId',cp.id,'source','staff_mark','evidenceMode',v_snapshot->>'evidenceMode'));
 RETURN jsonb_build_object('redeemed',true,'status','used','code','redeemed','couponId',cp.id,'redemptionId',r.id,'redeemedAt',v_now,'evidenceMode',v_snapshot->>'evidenceMode');
END $$;

CREATE FUNCTION core.coupon_welcome_context_private_v1(p_job_id uuid,p_job_lease_id uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE j core.coupon_welcome_outbox%ROWTYPE;cp core.campaign_coupons%ROWTYPE;c core.campaigns%ROWTYPE;u core.customers%ROWTYPE;
BEGIN
 SELECT * INTO j FROM core.coupon_welcome_outbox WHERE id=p_job_id AND job_lease_id=p_job_lease_id;
 IF NOT FOUND OR j.status<>'claimed' OR j.lease_expires_at<=statement_timestamp() THEN RETURN jsonb_build_object('allowed',false,'code','lease_unavailable');END IF;
 SELECT * INTO cp FROM core.campaign_coupons WHERE id=j.coupon_id AND business_id=j.business_id;
 SELECT * INTO c FROM core.campaigns WHERE id=cp.campaign_id AND business_id=j.business_id;
 SELECT * INTO u FROM core.customers WHERE id=cp.customer_id AND business_id=j.business_id;
 IF u.id IS NULL OR u.is_test OR cp.is_test OR u.email_status<>'subscribed' OR u.email_suppressed_at IS NOT NULL OR NULLIF(btrim(u.email),'') IS NULL
 OR c.status<>'active' OR c.starts_at>statement_timestamp() OR c.ends_at<=statement_timestamp() OR cp.state<>'issued' OR cp.expires_at<=statement_timestamp()
 OR NOT EXISTS(SELECT 1 FROM core.vip_confirmation_evidence e WHERE e.id=cp.confirmation_evidence_id AND e.email_sha256=encode(sha256(convert_to(lower(btrim(u.email)),'UTF8')),'hex'))
 OR EXISTS(SELECT 1 FROM core.klaviyo_email_observations ob WHERE ob.customer_id=u.id AND(ob.blocked_at IS NOT NULL OR ob.status IN('suppressed','unsubscribed')))
 THEN RETURN jsonb_build_object('allowed',false,'code','customer_ineligible');END IF;
 RETURN jsonb_build_object('allowed',true,'code','ok','jobId',j.id,'jobLeaseId',j.job_lease_id,'couponId',cp.id,'businessId',j.business_id,
 'customerId',u.id,'messageKey',j.message_key,'eventUniqueId',j.event_unique_id,'recipient',lower(btrim(u.email)),
 'properties',jsonb_build_object('coupon_code',cp.code,'coupon_qr_payload','VIPCOUPON1:'||cp.code,'coupon_qr_token',cp.qr_token,
 'coupon_qr_image_url',NULL,'campaign_id',c.id,'coupon_id',cp.id,'minimum_amount_cents',c.min_amount_cents,'channels',c.coupon_channels,'expires_at',cp.expires_at,'message_key',j.message_key));
END $$;
CREATE FUNCTION public.coupon_welcome_claim_v1(p_business_id uuid,p_coupon_id uuid DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j core.coupon_welcome_outbox%ROWTYPE;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 -- An abandoned or ambiguous event cannot be retried automatically.
 UPDATE core.coupon_welcome_outbox SET status='unknown',safe_code='lease_expired',updated_at=clock_timestamp()
 WHERE business_id=p_business_id AND status='claimed' AND lease_expires_at<=clock_timestamp();
 SELECT * INTO j FROM core.coupon_welcome_outbox WHERE business_id=p_business_id AND status='queued'
 AND(p_coupon_id IS NULL OR coupon_id=p_coupon_id) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN jsonb_build_object('allowed',false,'code','queue_empty');END IF;
 UPDATE core.coupon_welcome_outbox SET status='claimed',job_lease_id=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes',updated_at=clock_timestamp()
 WHERE id=j.id RETURNING * INTO j;
 RETURN core.coupon_welcome_context_private_v1(j.id,j.job_lease_id);
END $$;
CREATE FUNCTION public.coupon_welcome_context_v1(p_job_id uuid,p_job_lease_id uuid) RETURNS jsonb
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 RETURN core.coupon_welcome_context_private_v1(p_job_id,p_job_lease_id);END $$;
CREATE FUNCTION public.coupon_welcome_finish_v1(p_job_id uuid,p_job_lease_id uuid,p_outcome text,p_message_reservation_id uuid DEFAULT NULL,
 p_provider_event_id text DEFAULT NULL,p_safe_code text DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE j core.coupon_welcome_outbox%ROWTYPE;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN('provider_accepted','unknown','blocked') OR(p_safe_code IS NOT NULL AND p_safe_code !~ '^[a-z0-9_]{1,80}$')
 OR(p_provider_event_id IS NOT NULL AND length(p_provider_event_id)>200) THEN RAISE EXCEPTION 'Invalid welcome outcome' USING ERRCODE='22023';END IF;
 SELECT * INTO j FROM core.coupon_welcome_outbox WHERE id=p_job_id AND job_lease_id=p_job_lease_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('acknowledged',false,'code','lease_unavailable');END IF;
 IF j.status<>'claimed' THEN RETURN jsonb_build_object('acknowledged',j.status=p_outcome,'status',j.status,'code','already_finished');END IF;
 IF p_message_reservation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM core.message_log m JOIN core.campaign_coupons cp ON cp.id=j.coupon_id
 WHERE m.id=p_message_reservation_id AND m.business_id=j.business_id AND m.customer_id=cp.customer_id AND m.message_key=j.message_key AND m.message_kind='flow') THEN
 RAISE EXCEPTION 'K10_WELCOME_RESERVATION_MISMATCH' USING ERRCODE='22023';END IF;
 IF p_outcome='provider_accepted' AND NOT EXISTS(SELECT 1 FROM core.message_log m JOIN core.campaign_coupons cp ON cp.id=j.coupon_id
 WHERE m.id=p_message_reservation_id AND m.business_id=j.business_id AND m.customer_id=cp.customer_id
 AND m.message_key=j.message_key AND m.message_kind='flow' AND m.status='unknown' AND m.dispatch_authorized_at IS NOT NULL) THEN
 RAISE EXCEPTION 'K10_ACCEPTANCE_REQUIRES_CONSUMED_K6_GATE' USING ERRCODE='22023';END IF;
 UPDATE core.coupon_welcome_outbox SET status=p_outcome,message_reservation_id=p_message_reservation_id,provider_event_id=p_provider_event_id,safe_code=p_safe_code,updated_at=clock_timestamp() WHERE id=j.id;
 RETURN jsonb_build_object('acknowledged',true,'status',p_outcome,'code','finished');
END $$;
CREATE FUNCTION public.coupon_qr_payload_v1(p_token text) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE p text;BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 IF p_token IS NULL OR p_token !~ '^[0-9a-f]{32}$' THEN RAISE EXCEPTION 'Invalid render token' USING ERRCODE='22023';END IF;
 SELECT 'VIPCOUPON1:'||code INTO p FROM core.campaign_coupons WHERE qr_token=p_token;
 RETURN CASE WHEN p IS NULL THEN NULL ELSE jsonb_build_object('payload',p) END;
END $$;
CREATE FUNCTION public.coupon_record_negative_v1(p_business_id uuid,p_customer_id uuid,p_email text,p_status text,p_checked_at timestamptz) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u core.customers%ROWTYPE;o core.klaviyo_email_observations%ROWTYPE;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 IF p_status IS NULL OR p_status NOT IN('unsubscribed','suppressed') OR p_checked_at IS NULL OR NOT isfinite(p_checked_at)
 OR p_checked_at>clock_timestamp()+interval '1 minute' OR p_checked_at<clock_timestamp()-interval '5 minutes' THEN RAISE EXCEPTION 'Invalid negative evidence' USING ERRCODE='22023';END IF;
 SELECT * INTO u FROM core.customers WHERE business_id=p_business_id AND id=p_customer_id FOR UPDATE;
 IF NOT FOUND OR lower(btrim(u.email)) IS DISTINCT FROM p_email THEN RAISE EXCEPTION 'Customer changed or missing' USING ERRCODE='22023';END IF;
 SELECT * INTO o FROM core.klaviyo_email_observations WHERE customer_id=u.id;
 UPDATE core.customers SET email_status='unsubscribed',email_suppressed_at=COALESCE(email_suppressed_at,p_checked_at),updated_at=clock_timestamp() WHERE id=u.id;
 IF o.blocked_at IS NULL THEN INSERT INTO core.consent_events(customer_id,event_type,source,evidence_status,note)
 VALUES(u.id,'suppression','coupon_welcome_readback','admin_suppression','Provider negative evidence blocked coupon welcome.');END IF;
 INSERT INTO core.klaviyo_email_observations(customer_id,status,checked_at,provider_updated_at,blocked_status,blocked_at)
 VALUES(u.id,p_status,p_checked_at,p_checked_at,p_status,p_checked_at) ON CONFLICT(customer_id) DO UPDATE SET
 status=CASE WHEN core.klaviyo_email_observations.checked_at>=excluded.checked_at THEN core.klaviyo_email_observations.status ELSE excluded.status END,
 checked_at=greatest(core.klaviyo_email_observations.checked_at,excluded.checked_at),
 blocked_status=COALESCE(core.klaviyo_email_observations.blocked_status,excluded.blocked_status),blocked_at=COALESCE(core.klaviyo_email_observations.blocked_at,excluded.blocked_at);
 RETURN jsonb_build_object('blocked',true);
END $$;

DO $permissions$ DECLARE p record; BEGIN
 FOR p IN SELECT oid::regprocedure AS sig FROM pg_proc WHERE pronamespace='core'::regnamespace
 AND proname IN('coupon_history_guard_v1','coupon_campaign_guard_v1','coupon_normalize_code_v1','coupon_random_code_v1','coupon_issue_private_v1',
 'coupon_subscriber_trigger_v1','coupon_lookup_private_v1','coupon_state_guard_v1','coupon_outbox_state_guard_v1','coupon_welcome_context_private_v1') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',p.sig);END LOOP;
 FOR p IN SELECT oid::regprocedure AS sig FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN(
 'coupon_issue_confirmed_v1','coupon_confirmation_context_v1','coupon_record_confirmed_vip_v1','coupon_welcome_claim_v1','coupon_welcome_context_v1',
 'coupon_welcome_finish_v1','coupon_qr_payload_v1','coupon_record_negative_v1','campaign_evaluate_v1') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',p.sig);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',p.sig);END LOOP;
END $permissions$;
REVOKE ALL ON FUNCTION public.coupon_lookup_v1(uuid,text),public.coupon_redeem_v1(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.coupon_lookup_v1(uuid,text),public.coupon_redeem_v1(uuid,text,text,jsonb) TO authenticated;
ALTER TABLE core.vip_confirmation_evidence ENABLE ALWAYS TRIGGER vip_confirmation_evidence_immutable;
ALTER TABLE core.campaign_coupons ENABLE ALWAYS TRIGGER campaign_coupons_no_remove;
ALTER TABLE core.campaign_coupons ENABLE ALWAYS TRIGGER coupon_state_guard;
ALTER TABLE core.coupon_welcome_outbox ENABLE ALWAYS TRIGGER coupon_welcome_no_remove;
ALTER TABLE core.coupon_welcome_outbox ENABLE ALWAYS TRIGGER coupon_outbox_state_guard;
ALTER TABLE core.campaigns ENABLE ALWAYS TRIGGER coupon_campaign_guard;
ALTER TABLE core.customers ENABLE ALWAYS TRIGGER coupon_subscriber_issue;
COMMIT;
