-- Order 19, after K16 foundation/order 18. Additive only; no seed, send or cron.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF to_regclass('core.site_orders') IS NULL
 OR to_regclass('core.vip_confirmation_evidence') IS NULL
 OR to_regprocedure('public.coupon_record_confirmed_vip_v1(uuid,uuid,uuid,text,timestamptz,timestamptz,jsonb)') IS NULL
 OR has_schema_privilege('anon','core','USAGE')
 OR has_schema_privilege('authenticated','core','USAGE')
 OR has_schema_privilege('service_role','core','USAGE')
 THEN RAISE EXCEPTION 'DOI_REQUIRES_ORDER18_AND_PRIVATE_COUPONS'; END IF;
END $guard$;

CREATE TABLE core.vip_doi_webhook_receipts (
 business_id uuid NOT NULL REFERENCES core.businesses(id),
 event_key text NOT NULL CHECK(event_key ~ '^[a-f0-9]{64}$'),
 confirmation_evidence_id uuid NOT NULL REFERENCES core.vip_confirmation_evidence(id),
 confirmed_at timestamptz NOT NULL CHECK(isfinite(confirmed_at)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(business_id,event_key),UNIQUE(business_id,confirmation_evidence_id)
);
CREATE TABLE core.vip_doi_webhook_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL REFERENCES core.businesses(id),
 request_key text NOT NULL CHECK(request_key ~ '^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN('confirmed','blocked','retryable')),
 safe_code text NOT NULL CHECK(safe_code IN('confirmation_recorded','local_request_unmatched','local_request_ambiguous',
  'recipient_blocked','verification_unconfirmed','database_unavailable')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX vip_doi_attempts_recent ON core.vip_doi_webhook_attempts(business_id,occurred_at DESC);
ALTER TABLE core.vip_doi_webhook_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.vip_doi_webhook_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.vip_doi_webhook_receipts,core.vip_doi_webhook_attempts FROM PUBLIC,anon,authenticated,service_role;

-- The webhook has no authority to choose a tenant or an arbitrary local signup.
-- Ambiguous histories require review; never pick the first/latest by guesswork.
CREATE FUNCTION public.vip_doi_webhook_match_v1(p_business_id uuid,p_email text,p_list_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE c core.customers%ROWTYPE; s core.signups%ROWTYPE; n integer;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 IF p_email IS NULL OR p_email<>lower(btrim(p_email)) OR length(p_email)>254
 OR p_list_id IS NULL OR p_list_id !~ '^[A-Za-z0-9_-]{1,100}$'
 THEN RAISE EXCEPTION 'Invalid input' USING ERRCODE='22023';END IF;
 SELECT count(*) INTO n FROM core.customers WHERE business_id=p_business_id AND lower(btrim(email))=p_email AND NOT is_test;
 IF n<>1 THEN RETURN jsonb_build_object('allowed',false,'code',CASE WHEN n=0 THEN 'local_request_unmatched' ELSE 'local_request_ambiguous' END);END IF;
 SELECT * INTO c FROM core.customers WHERE business_id=p_business_id AND lower(btrim(email))=p_email AND NOT is_test;
 IF c.email_status='unsubscribed' OR c.email_suppressed_at IS NOT NULL THEN
 RETURN jsonb_build_object('allowed',false,'code','recipient_blocked');END IF;
 IF NOT EXISTS(SELECT 1 FROM core.campaigns WHERE business_id=p_business_id AND NOT is_test
  AND campaign_kind='signup_reward' AND vip_list_id=p_list_id) THEN
 RETURN jsonb_build_object('allowed',false,'code','local_request_unmatched');END IF;
 SELECT count(*) INTO n FROM core.signups x WHERE x.business_id=p_business_id AND x.customer_id=c.id
 AND NOT x.is_test AND x.consent_email AND x.source IN('website_vip_page','website_vip_form')
 AND lower(btrim(x.email))=p_email;
 IF n<>1 THEN RETURN jsonb_build_object('allowed',false,'code',CASE WHEN n=0 THEN 'local_request_unmatched' ELSE 'local_request_ambiguous' END);END IF;
 SELECT * INTO s FROM core.signups x WHERE x.business_id=p_business_id AND x.customer_id=c.id
 AND NOT x.is_test AND x.consent_email AND x.source IN('website_vip_page','website_vip_form') AND lower(btrim(x.email))=p_email;
 RETURN jsonb_build_object('allowed',true,'businessId',p_business_id,'customerId',c.id,'signupId',s.id);
END $$;

-- Existing K4/K10 function remains the only positive consent/issuance path.
-- Its row lock and unique coupon constraint serialize concurrent deliveries.
-- The receipt is committed in the SAME transaction, including on replay.
CREATE FUNCTION public.vip_doi_webhook_confirm_v1(p_business_id uuid,p_customer_id uuid,p_signup_id uuid,
 p_provider_profile_id text,p_confirmed_at timestamptz,p_checked_at timestamptz,p_evidence jsonb,p_account_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r jsonb;e uuid;k text;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 IF p_account_id IS NULL OR p_account_id !~ '^[A-Za-z0-9_-]{1,100}$' THEN
 RAISE EXCEPTION 'Invalid account' USING ERRCODE='22023';END IF;
 r:=public.coupon_record_confirmed_vip_v1(p_business_id,p_customer_id,p_signup_id,p_provider_profile_id,p_confirmed_at,p_checked_at,p_evidence);
 IF r->'confirmed' IS DISTINCT FROM 'true'::jsonb THEN RETURN r;END IF;
 SELECT id INTO STRICT e FROM core.vip_confirmation_evidence WHERE business_id=p_business_id
 AND customer_id=p_customer_id AND provider_profile_id=btrim(p_provider_profile_id) AND confirmed_at=p_confirmed_at;
 k:=encode(sha256(convert_to(jsonb_build_array(p_account_id,p_evidence->>'listId',p_provider_profile_id,
  extract(epoch FROM p_confirmed_at),p_customer_id)::text,'UTF8')),'hex');
 INSERT INTO core.vip_doi_webhook_receipts(business_id,event_key,confirmation_evidence_id,confirmed_at)
 VALUES(p_business_id,k,e,p_confirmed_at) ON CONFLICT DO NOTHING;
 RETURN r;
END $$;

CREATE FUNCTION public.vip_doi_webhook_observe_v1(p_business_id uuid,p_request_key text,p_status text,p_safe_code text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';END IF;
 INSERT INTO core.vip_doi_webhook_attempts(business_id,request_key,status,safe_code)
 VALUES(p_business_id,p_request_key,p_status,p_safe_code);
 RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.vip_doi_webhook_match_v1(uuid,text,text),
 public.vip_doi_webhook_confirm_v1(uuid,uuid,uuid,text,timestamptz,timestamptz,jsonb,text),
 public.vip_doi_webhook_observe_v1(uuid,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.vip_doi_webhook_match_v1(uuid,text,text),
 public.vip_doi_webhook_confirm_v1(uuid,uuid,uuid,text,timestamptz,timestamptz,jsonb,text),
 public.vip_doi_webhook_observe_v1(uuid,text,text,text) TO service_role;
CREATE TRIGGER vip_doi_receipts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON core.vip_doi_webhook_receipts
 FOR EACH STATEMENT EXECUTE FUNCTION core.coupon_history_guard_v1();
CREATE TRIGGER vip_doi_attempts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON core.vip_doi_webhook_attempts
 FOR EACH STATEMENT EXECUTE FUNCTION core.coupon_history_guard_v1();
ALTER TABLE core.vip_doi_webhook_receipts ENABLE ALWAYS TRIGGER vip_doi_receipts_immutable;
ALTER TABLE core.vip_doi_webhook_attempts ENABLE ALWAYS TRIGGER vip_doi_attempts_immutable;
NOTIFY pgrst,'reload schema';
COMMIT;
