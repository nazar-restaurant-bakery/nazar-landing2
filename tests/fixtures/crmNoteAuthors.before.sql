CREATE OR REPLACE FUNCTION public.crm_overview_v2(p_search text DEFAULT ''::text, p_segment text DEFAULT 'all'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;
CREATE OR REPLACE FUNCTION public.crm_add_note(p_customer_id uuid, p_body text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
 RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
 END IF;
 IF length(trim(coalesce(p_body, ''))) NOT BETWEEN 1 AND 2000 THEN
 RAISE EXCEPTION 'Invalid input' USING ERRCODE = '22023';
 END IF;
 INSERT INTO core.customer_notes(customer_id, author_id, body)
 SELECT id, auth.uid(), trim(p_body) FROM core.customers
 WHERE id = p_customer_id AND business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid;
 RETURN FOUND;
END;
$function$
;
