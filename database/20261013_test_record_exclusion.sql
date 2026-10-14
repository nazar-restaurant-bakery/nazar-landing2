-- Nazar only: explicit test markers, no deletion and no marketing consent changes.
BEGIN;
SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.installation WHERE declared_project_ref='khgczybubufouraqyrcj')
 THEN RAISE EXCEPTION 'Wrong project'; END IF;
END $guard$;
ALTER TABLE core.signups ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS test_reason text;
ALTER TABLE core.catering_requests ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false,
 ADD COLUMN IF NOT EXISTS test_reason text;
CREATE OR REPLACE FUNCTION core.test_lead_reason_v1(p_name text,p_email text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path='' AS $fn$
 SELECT CASE
 WHEN lower(btrim(coalesce(p_email,''))) ~ '@(example[.](com|net|org)|([^@]*[.])?invalid)$' THEN 'reserved_test_email'
 WHEN btrim(coalesce(p_name,'')) ~* '^INTERNAL[[:space:]]+TEST([[:space:]]|$)' THEN 'internal_test_name'
 ELSE NULL END;
$fn$;
REVOKE ALL ON FUNCTION core.test_lead_reason_v1(text,text) FROM PUBLIC,anon,authenticated;
UPDATE core.signups s SET is_test=true,
 test_reason=coalesce(core.test_lead_reason_v1(s.name,s.email),'legacy_crm_test_assignment')
WHERE s.business_id='a358eba4-b197-4309-805b-46f43a718454'::uuid
 AND (core.test_lead_reason_v1(s.name,s.email) IS NOT NULL
 OR EXISTS(SELECT 1 FROM core.catering_requests r WHERE r.signup_id=s.id AND r.assigned_to='CRM Test'));
UPDATE core.catering_requests r SET is_test=true,test_reason=s.test_reason
FROM core.signups s WHERE s.id=r.signup_id AND s.is_test;
CREATE OR REPLACE FUNCTION core.classify_test_signup_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE reason text;
BEGIN
 reason:=core.test_lead_reason_v1(NEW.name,NEW.email);
 IF reason IS NOT NULL THEN NEW.is_test:=true; NEW.test_reason:=reason; END IF;
 RETURN NEW;
END $fn$;
CREATE OR REPLACE FUNCTION core.classify_test_catering_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE signup_test boolean; reason text;
BEGIN
 SELECT s.is_test,s.test_reason INTO signup_test,reason FROM core.signups s WHERE s.id=NEW.signup_id;
 IF signup_test THEN NEW.is_test:=true; NEW.test_reason:=reason; END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION core.classify_test_signup_v1(),core.classify_test_catering_v1() FROM PUBLIC,anon,authenticated;
CREATE OR REPLACE FUNCTION core.propagate_test_signup_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
 IF NEW.is_test THEN
  UPDATE core.catering_requests SET is_test=true,test_reason=NEW.test_reason
  WHERE signup_id=NEW.id AND (NOT is_test OR test_reason IS DISTINCT FROM NEW.test_reason);
 END IF;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION core.propagate_test_signup_v1() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS propagate_test_signup ON core.signups;
CREATE TRIGGER propagate_test_signup AFTER UPDATE OF is_test,test_reason ON core.signups
 FOR EACH ROW EXECUTE FUNCTION core.propagate_test_signup_v1();
DROP TRIGGER IF EXISTS classify_test_signup ON core.signups;
CREATE TRIGGER classify_test_signup BEFORE INSERT OR UPDATE OF name,email,is_test ON core.signups
 FOR EACH ROW EXECUTE FUNCTION core.classify_test_signup_v1();
DROP TRIGGER IF EXISTS classify_test_catering ON core.catering_requests;
CREATE TRIGGER classify_test_catering BEFORE INSERT OR UPDATE ON core.catering_requests
 FOR EACH ROW EXECUTE FUNCTION core.classify_test_catering_v1();
CREATE OR REPLACE VIEW core.reporting_signups_v1 AS SELECT * FROM core.signups WHERE NOT is_test;
CREATE OR REPLACE VIEW core.reporting_catering_v1 AS SELECT * FROM core.catering_requests WHERE NOT is_test;
REVOKE ALL ON core.reporting_signups_v1,core.reporting_catering_v1 FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.crm_overview_v2(
  p_search text DEFAULT '', p_segment text DEFAULT 'all'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_search text := left(trim(coalesce(p_search, '')), 100);
  v_segment text := coalesce(p_segment, 'all');
  v_customers jsonb;
  v_requests jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.crm_staff
    WHERE auth_user_id = auth.uid() AND active
  ) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  IF v_segment NOT IN ('all', 'vip', 'kevin', 'test') THEN
    RAISE EXCEPTION 'Invalid segment' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) INTO v_customers
  FROM (
    SELECT c.id, c.name, c.email, c.phone, c.email_status, c.created_at,
           (SELECT count(*) FROM core.signups s WHERE s.customer_id = c.id AND s.is_test = (v_segment = 'test')) AS signup_count,
           (SELECT max(s.created_at) FROM core.signups s WHERE s.customer_id = c.id AND s.is_test = (v_segment = 'test')) AS last_signup_at,
           (SELECT s.source FROM core.signups s WHERE s.customer_id = c.id AND s.is_test = (v_segment = 'test')
            ORDER BY s.created_at DESC LIMIT 1) AS last_source,
           (SELECT count(*) FROM core.signups s
            WHERE s.customer_id = c.id AND s.is_test = (v_segment = 'test') AND s.source = 'website_vip_page') AS vip_signup_count,
           (SELECT count(*) FROM core.signups s
            WHERE s.customer_id = c.id AND s.is_test = (v_segment = 'test')
              AND s.source = 'website_vip_page'
              AND s.utm->>'utm_campaign' = 'onscene_20261013') AS kevin_signup_count,
           (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.created_at DESC), '[]'::jsonb)
            FROM (SELECT id, source, created_at, utm->>'utm_campaign' AS campaign
                  FROM core.signups WHERE customer_id = c.id AND is_test = (v_segment = 'test')
                  ORDER BY created_at DESC LIMIT 10) s) AS recent_signups,
           (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.created_at DESC), '[]'::jsonb)
            FROM (SELECT id, body, created_at FROM core.customer_notes
                  WHERE customer_id = c.id ORDER BY created_at DESC LIMIT 10) n) AS notes
    FROM core.customers c
    WHERE c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
      AND (EXISTS (SELECT 1 FROM core.signups matching WHERE matching.customer_id = c.id AND matching.is_test = (v_segment = 'test'))
           OR (v_segment <> 'test' AND NOT EXISTS (SELECT 1 FROM core.signups any_signup WHERE any_signup.customer_id = c.id)))
      AND (v_search = '' OR coalesce(c.name, '') ILIKE '%' || v_search || '%'
           OR coalesce(c.email, '') ILIKE '%' || v_search || '%'
           OR coalesce(c.phone, '') ILIKE '%' || v_search || '%')
      AND (v_segment IN ('all', 'test')
           OR EXISTS (
             SELECT 1 FROM core.signups s
             WHERE s.customer_id = c.id AND s.is_test = (v_segment = 'test') AND s.source = 'website_vip_page'
               AND (v_segment = 'vip'
                    OR s.utm->>'utm_campaign' = 'onscene_20261013')
           ))
    ORDER BY c.created_at DESC LIMIT 100
  ) c;

  SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_requests
  FROM (
    SELECT r.id, r.customer_id, r.event_date, r.guests, r.message,
           r.status, r.assigned_to, r.follow_up_at, r.created_at,
           c.name, c.email, c.phone
    FROM core.catering_requests r
    JOIN core.customers c ON c.id = r.customer_id
    WHERE c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
      AND r.is_test = (v_segment = 'test')
      AND (v_search = '' OR coalesce(c.name, '') ILIKE '%' || v_search || '%'
           OR coalesce(c.email, '') ILIKE '%' || v_search || '%'
           OR coalesce(c.phone, '') ILIKE '%' || v_search || '%')
      AND (v_segment IN ('all', 'test')
           OR EXISTS (
             SELECT 1 FROM core.signups s
             WHERE s.customer_id = c.id AND s.is_test = (v_segment = 'test') AND s.source = 'website_vip_page'
               AND (v_segment = 'vip'
                    OR s.utm->>'utm_campaign' = 'onscene_20261013')
           ))
    ORDER BY CASE WHEN r.status IN ('new', 'contacted', 'quoted') THEN 0 ELSE 1 END,
             r.follow_up_at ASC NULLS FIRST, r.created_at DESC
    LIMIT 100
  ) r;
  RETURN jsonb_build_object('customers', v_customers, 'requests', v_requests);
END;
$fn$;


NOTIFY pgrst,'reload schema';
COMMIT;
