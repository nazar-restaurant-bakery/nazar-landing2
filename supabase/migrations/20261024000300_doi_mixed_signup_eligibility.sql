-- Forward only: traceable genuine DOI may follow historical test signups.
-- No rows, flags, consent, negative observations or historical SQL are changed.
-- Application order is deliberately unassigned; review Sandbox before Production.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('doi_mixed_signup_eligibility_v1',0));
DO $guard$ BEGIN
 IF pg_catalog.to_regclass('core.vip_confirmation_evidence') IS NULL
 OR pg_catalog.to_regprocedure('core.klaviyo_profile_sync_eligible_v1(uuid,uuid)') IS NULL
 OR (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid='core.klaviyo_profile_sync_eligible_v1(uuid,uuid)'::regprocedure)
    IS DISTINCT FROM '2e59cde921d93fa1b3f403369aa7d029' THEN
 RAISE EXCEPTION 'DOI_MIXED_HISTORY_REVIEWED_PREREQUISITES_REQUIRED';END IF;
END $guard$;
CREATE OR REPLACE FUNCTION core.klaviyo_profile_sync_eligible_v1(p_business_id uuid,p_customer_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $$
  SELECT EXISTS (SELECT 1 FROM core.customers c
    WHERE c.id=p_customer_id AND c.business_id=p_business_id
      AND c.email_status='subscribed' AND c.email_suppressed_at IS NULL
      AND NULLIF(pg_catalog.btrim(c.email),'') IS NOT NULL
      AND pg_catalog.length(c.email)<=254
      AND c.email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'
      AND NOT COALESCE((pg_catalog.to_jsonb(c)->>'is_test')::boolean,false)
      AND c.email !~* '(@example[.]com$|[.]invalid$|[+]viptest)'
      AND COALESCE(c.name,'') !~* '(INTERNAL TEST|CRM Test|VERIFY)'
      AND (NOT EXISTS (SELECT 1 FROM core.signups s
        WHERE s.customer_id=c.id AND s.business_id=c.business_id AND s.is_test)
        OR EXISTS (
          SELECT 1 FROM core.vip_confirmation_evidence e
          JOIN core.signups s ON s.id=e.signup_id AND s.business_id=e.business_id
            AND s.customer_id=e.customer_id
          WHERE e.business_id=c.business_id AND e.customer_id=c.id
            AND s.is_test=false AND s.consent_email
            AND s.source IN ('website_vip_form','website_vip_page')
            AND pg_catalog.lower(pg_catalog.btrim(s.email))=pg_catalog.lower(pg_catalog.btrim(c.email))
            AND e.email_sha256=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.lower(pg_catalog.btrim(c.email)),'UTF8')),'hex')
            AND e.evidence->>'emailSha256'=e.email_sha256
            AND e.evidence->>'source'='klaviyo'
            AND e.evidence->'doubleOptIn'='true'::jsonb
            AND e.evidence->'canReceiveEmailMarketing'='true'::jsonb
            AND e.evidence->>'consent'='SUBSCRIBED'
            AND pg_catalog.isfinite(e.confirmed_at) AND pg_catalog.isfinite(e.checked_at)
            AND s.created_at<=e.confirmed_at AND e.confirmed_at<=e.checked_at
            AND e.checked_at<=pg_catalog.statement_timestamp()
            AND EXISTS (SELECT 1 FROM core.consent_events ce WHERE ce.customer_id=c.id
              AND ce.signup_id=s.id AND ce.event_type='request' AND ce.email_requested
              AND ce.source=s.source AND ce.created_at<=e.confirmed_at)
            AND EXISTS (SELECT 1 FROM core.campaigns ca WHERE ca.business_id=c.business_id
              AND ca.campaign_kind='signup_reward' AND ca.is_test=false
              AND ca.vip_list_id=e.evidence->>'listId')
            -- A later/equal-time test is not historical. Latest request must be
            -- this exact evidenced request; UUID ordering never establishes time.
            AND NOT EXISTS (SELECT 1 FROM core.signups later WHERE later.business_id=c.business_id
              AND later.customer_id=c.id AND later.id<>s.id AND later.created_at>=s.created_at)
        ))
      AND NOT EXISTS (SELECT 1 FROM core.klaviyo_email_observations o
        WHERE o.customer_id=c.id AND (o.blocked_at IS NOT NULL
          OR o.status IN ('unsubscribed','suppressed'))))
$$;
COMMIT;
