--
-- PostgreSQL database dump
--

\restrict iai0gQMHFj7pzi797Y7eH79dulTVAo4e4ffBFbt1VelJLYMr4L1d3ubfeAJFIN4

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: core; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA core;


--
-- Name: classify_test_catering_v1(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.classify_test_catering_v1() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE signup_test boolean; reason text;
BEGIN
 SELECT s.is_test,s.test_reason INTO signup_test,reason FROM core.signups s WHERE s.id=NEW.signup_id;
 IF signup_test THEN NEW.is_test:=true; NEW.test_reason:=reason; END IF;
 RETURN NEW;
END $$;


--
-- Name: classify_test_signup_v1(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.classify_test_signup_v1() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE reason text;
BEGIN
 reason:=core.test_lead_reason_v1(NEW.name,NEW.email);
 IF reason IS NOT NULL THEN NEW.is_test:=true; NEW.test_reason:=reason; END IF;
 RETURN NEW;
END $$;


--
-- Name: link_catering_form_request(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.link_catering_form_request() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_request_id text;
BEGIN
  v_request_id := pg_catalog.current_setting('nazar.form_request_id', true);
  IF nullif(v_request_id, '') IS NOT NULL THEN
    NEW.form_request_id := v_request_id::uuid;
  END IF;
  RETURN NEW;
END
$$;


--
-- Name: propagate_test_signup_v1(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.propagate_test_signup_v1() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
 IF NEW.is_test THEN
  UPDATE core.catering_requests SET is_test=true,test_reason=NEW.test_reason
  WHERE signup_id=NEW.id AND (NOT is_test OR test_reason IS DISTINCT FROM NEW.test_reason);
 END IF;
 RETURN NEW;
END $$;


--
-- Name: set_form_request_context(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.set_form_request_context() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  PERFORM pg_catalog.set_config('nazar.form_request_id', NEW.request_id::text, true);
  RETURN NEW;
END
$$;


--
-- Name: suppress_email(text, text); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.suppress_email(p_email text, p_reason text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_id uuid; v_count integer:=0;
BEGIN
  IF nullif(btrim(p_reason),'') IS NULL OR length(p_reason)>1000 THEN
    RAISE EXCEPTION 'Suppression reason required (max 1000 characters)';
  END IF;
  FOR v_id IN UPDATE core.customers SET email_status='unsubscribed',
    email_suppressed_at=now(),updated_at=now() WHERE lower(email)=lower(btrim(p_email)) RETURNING id
  LOOP
    INSERT INTO core.consent_events(customer_id,event_type,source,evidence_status,note)
      VALUES(v_id,'suppression','admin','admin_suppression',p_reason);
    v_count:=v_count+1;
  END LOOP;
  RETURN v_count;
END $$;


--
-- Name: test_lead_reason_v1(text, text); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.test_lead_reason_v1(p_name text, p_email text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $_$
 SELECT CASE
 WHEN lower(btrim(coalesce(p_email,''))) ~ '@(example[.](com|net|org)|([^@]*[.])?invalid)$' THEN 'reserved_test_email'
 WHEN btrim(coalesce(p_name,'')) ~* '^INTERNAL[[:space:]]+TEST([[:space:]]|$)' THEN 'internal_test_name'
 ELSE NULL END;
$_$;


--
-- Name: claim_catering_staff_notification_v1(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_catering_staff_notification_v1(p_request_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_row record;
BEGIN
  UPDATE core.catering_requests r
  SET staff_notification_attempted_at = now(), staff_notification_error = NULL
  FROM core.customers c
  WHERE r.form_request_id = p_request_id AND c.id = r.customer_id
    AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
    AND r.staff_notification_sent_at IS NULL
    AND (r.staff_notification_attempted_at IS NULL
         OR r.staff_notification_attempted_at < now() - interval '5 minutes')
  RETURNING r.id, r.created_at, r.event_date, r.guests INTO v_row;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN pg_catalog.jsonb_build_object(
    'requestId', p_request_id, 'requestDate', v_row.created_at,
    'eventDate', v_row.event_date, 'guests', v_row.guests
  );
END
$$;


--
-- Name: crm_add_note(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_add_note(p_customer_id uuid, p_body text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
$$;


--
-- Name: crm_catering_decisions_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_catering_decisions_v1() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_rows jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(d)), '[]'::jsonb) INTO v_rows FROM (
    SELECT q.id, q.request_id, q.question, q.requested_at,
           q.decision, q.recorded_at, r.status AS request_status,
           c.name AS customer_name
    FROM core.catering_decisions q
    JOIN core.catering_requests r ON r.id = q.request_id
    JOIN core.customers c ON c.id = r.customer_id
    WHERE c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
    ORDER BY q.recorded_at NULLS FIRST, q.requested_at DESC LIMIT 100
  ) d;
  RETURN jsonb_build_object('items', v_rows);
END;
$$;


--
-- Name: crm_catering_notification_status_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_catering_notification_status_v1() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_items jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff
                 WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(pg_catalog.jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_items
  FROM (
    SELECT r.id AS request_id, r.form_request_id IS NOT NULL AS tracked,
           r.staff_notification_attempted_at AS attempted_at,
           r.staff_notification_sent_at AS sent_at,
           r.staff_notification_error AS error
    FROM core.catering_requests r
    JOIN core.customers c ON c.id = r.customer_id
    WHERE c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
      AND r.created_at >= now() - interval '30 days'
    ORDER BY r.created_at DESC LIMIT 100
  ) x;
  RETURN pg_catalog.jsonb_build_object('items', v_items);
END
$$;


--
-- Name: crm_complete_task_v1(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_complete_task_v1(p_task_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
  RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
 END IF;
 UPDATE core.customer_follow_up_tasks t SET completed_at = now()
 FROM core.customers c WHERE t.id = p_task_id AND t.customer_id = c.id
  AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid AND t.completed_at IS NULL;
 RETURN FOUND;
END;
$$;


--
-- Name: crm_create_task_v1(uuid, text, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_create_task_v1(p_customer_id uuid, p_title text, p_assigned_to text, p_due_at timestamp with time zone) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_id uuid;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
  RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
 END IF;
 IF length(trim(coalesce(p_title, ''))) NOT BETWEEN 1 AND 300 OR length(trim(coalesce(p_assigned_to, ''))) NOT BETWEEN 1 AND 100 OR p_due_at IS NULL THEN
  RAISE EXCEPTION 'Invalid task' USING ERRCODE = '22023';
 END IF;
 INSERT INTO core.customer_follow_up_tasks(customer_id, created_by, title, assigned_to, due_at)
 SELECT id, auth.uid(), trim(p_title), trim(p_assigned_to), p_due_at
 FROM core.customers WHERE id = p_customer_id AND business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
 RETURNING id INTO v_id;
 IF v_id IS NULL THEN RAISE EXCEPTION 'Customer not found' USING ERRCODE = '22023'; END IF;
 RETURN v_id;
END;
$$;


--
-- Name: crm_customer_tasks_v1(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_customer_tasks_v1(p_customer_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_tasks jsonb;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
  RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM core.customers WHERE id = p_customer_id AND business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid) THEN
  RAISE EXCEPTION 'Customer not found' USING ERRCODE = '22023';
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_tasks FROM (
  SELECT id, title, assigned_to, due_at, completed_at, created_at
  FROM core.customer_follow_up_tasks WHERE customer_id = p_customer_id
  ORDER BY completed_at NULLS FIRST, due_at ASC LIMIT 50
 ) t;
 RETURN v_tasks;
END;
$$;


--
-- Name: crm_follow_up_queue_v1(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_follow_up_queue_v1(p_queue text DEFAULT 'open_catering'::text, p_offset integer DEFAULT 0) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_result jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  IF p_queue IS NULL OR p_queue NOT IN ('open_catering','missing_owner','missing_followup',
    'overdue_catering','open_tasks','overdue_tasks','pending_decisions')
    OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'Invalid queue or offset' USING ERRCODE = '22023';
  END IF;
  WITH customers AS MATERIALIZED (
    SELECT c.id, c.name FROM core.customers c
    WHERE c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
      AND (EXISTS (SELECT 1 FROM core.signups s WHERE s.customer_id = c.id AND NOT s.is_test)
        OR NOT EXISTS (SELECT 1 FROM core.signups s WHERE s.customer_id = c.id))
  ), requests AS MATERIALIZED (
    SELECT r.id, r.customer_id, c.name AS customer_name, r.status AS request_status,
      r.assigned_to, r.follow_up_at AS due_at, r.created_at,
      r.follow_up_at < now() AS overdue,
      nullif(btrim(r.assigned_to), '') IS NULL AS missing_owner,
      r.follow_up_at IS NULL AS missing_followup
    FROM core.catering_requests r JOIN customers c ON c.id = r.customer_id
    WHERE NOT r.is_test AND r.status IN ('new','contacted','quoted')
  ), tasks AS MATERIALIZED (
    SELECT t.id, t.customer_id, c.name AS customer_name, t.title, t.assigned_to,
      t.due_at, t.created_at, t.due_at < now() AS overdue
    FROM core.customer_follow_up_tasks t JOIN customers c ON c.id = t.customer_id
    WHERE t.completed_at IS NULL
  ), decisions AS MATERIALIZED (
    SELECT d.id, r.id AS request_id, r.customer_id, r.customer_name, d.question AS title,
      r.request_status, r.assigned_to, r.due_at, d.requested_at AS created_at
    FROM core.catering_decisions d JOIN requests r ON r.id = d.request_id
    WHERE d.recorded_at IS NULL
  ), entries AS (
    SELECT 'request'::text AS kind, r.id, r.id AS request_id, r.customer_id, r.customer_name,
      'Catering follow-up'::text AS title, r.request_status, r.assigned_to, r.due_at, r.created_at,
      array_remove(ARRAY[CASE WHEN r.overdue THEN 'overdue' END,
        CASE WHEN r.missing_owner THEN 'missing_owner' END,
        CASE WHEN r.missing_followup THEN 'missing_followup' END], NULL) AS flags,
      CASE WHEN r.overdue THEN 0 WHEN r.missing_followup THEN 1 WHEN r.missing_owner THEN 2 ELSE 3 END AS priority
    FROM requests r
    WHERE p_queue = 'open_catering' OR (p_queue = 'missing_owner' AND r.missing_owner)
      OR (p_queue = 'missing_followup' AND r.missing_followup)
      OR (p_queue = 'overdue_catering' AND r.overdue)
    UNION ALL
    SELECT 'task', t.id, NULL::uuid, t.customer_id, t.customer_name, t.title, NULL::text,
      t.assigned_to, t.due_at, t.created_at,
      CASE WHEN t.overdue THEN ARRAY['overdue'] ELSE ARRAY[]::text[] END,
      CASE WHEN t.overdue THEN 0 ELSE 3 END
    FROM tasks t WHERE p_queue = 'open_tasks' OR (p_queue = 'overdue_tasks' AND t.overdue)
    UNION ALL
    SELECT 'decision', d.id, d.request_id, d.customer_id, d.customer_name, d.title,
      d.request_status, d.assigned_to, d.due_at, d.created_at, ARRAY['decision'], 1
    FROM decisions d WHERE p_queue = 'pending_decisions'
  ), page AS (
    SELECT * FROM entries ORDER BY priority, due_at ASC NULLS LAST, created_at, id
    LIMIT 25 OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'generated_at', now(), 'queue', p_queue, 'offset', p_offset, 'page_size', 25,
    'total', (SELECT count(*) FROM entries),
    'counts', jsonb_build_object(
      'open_catering', (SELECT count(*) FROM requests),
      'missing_owner', (SELECT count(*) FROM requests WHERE missing_owner),
      'missing_followup', (SELECT count(*) FROM requests WHERE missing_followup),
      'overdue_catering', (SELECT count(*) FROM requests WHERE overdue),
      'open_tasks', (SELECT count(*) FROM tasks),
      'overdue_tasks', (SELECT count(*) FROM tasks WHERE overdue),
      'pending_decisions', (SELECT count(*) FROM decisions)),
    'items', coalesce((SELECT jsonb_agg(to_jsonb(p) - 'priority'
      ORDER BY p.priority, p.due_at ASC NULLS LAST, p.created_at, p.id) FROM page p), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$$;


--
-- Name: crm_form_errors_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_form_errors_v1() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_items jsonb; v_total bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  SELECT count(*) INTO v_total FROM core.form_errors WHERE resolved_at IS NULL;
  SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) INTO v_items FROM (
    SELECT id,occurred_at,form_kind,stage,error_code,http_status,alert_status
    FROM core.form_errors WHERE resolved_at IS NULL ORDER BY occurred_at DESC LIMIT 50
  ) x;
  RETURN jsonb_build_object('total_open',v_total,'items',v_items);
END $$;


--
-- Name: crm_klaviyo_status_v1(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_klaviyo_status_v1(p_customer_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM core.crm_staff WHERE auth_user_id=auth.uid() AND active) THEN
  RAISE EXCEPTION 'Access denied' USING ERRCODE='42501';
 END IF;
 SELECT jsonb_build_object('email',lower(trim(c.email)),'localStatus',c.email_status,
   'saved',CASE WHEN o.customer_id IS NULL THEN NULL ELSE jsonb_build_object(
    'status',o.status,'checkedAt',o.checked_at,'providerUpdatedAt',o.provider_updated_at,
    'blocked',c.email_status='unsubscribed' OR o.blocked_at IS NOT NULL,
    'blockedStatus',o.blocked_status,'blockedAt',coalesce(o.blocked_at,c.email_suppressed_at)) END)
 INTO v_result FROM core.customers c LEFT JOIN core.klaviyo_email_observations o ON o.customer_id=c.id
 WHERE c.id=p_customer_id AND c.business_id='a358eba4-b197-4309-805b-46f43a718454'::uuid;
 RETURN v_result;
END $$;


--
-- Name: crm_overview(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_overview(p_search text DEFAULT ''::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
 v_search text := left(trim(coalesce(p_search, '')), 100);
 v_customers jsonb;
 v_requests jsonb;
BEGIN
 IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
  RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
 END IF;
 SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) INTO v_customers FROM (
  SELECT c.id, c.name, c.email, c.phone, c.email_status, c.created_at,
   (SELECT count(*) FROM core.signups s WHERE s.customer_id = c.id) AS signup_count,
   (SELECT max(s.created_at) FROM core.signups s WHERE s.customer_id = c.id) AS last_signup_at,
   (SELECT s.source FROM core.signups s WHERE s.customer_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS last_source,
   (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.created_at DESC), '[]'::jsonb)
    FROM (SELECT id, body, created_at FROM core.customer_notes WHERE customer_id = c.id ORDER BY created_at DESC LIMIT 10) n) AS notes
  FROM core.customers c
  WHERE c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
   AND (v_search = '' OR coalesce(c.name, '') ILIKE '%' || v_search || '%'
    OR coalesce(c.email, '') ILIKE '%' || v_search || '%'
    OR coalesce(c.phone, '') ILIKE '%' || v_search || '%')
  ORDER BY c.created_at DESC LIMIT 100
 ) c;
 SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) INTO v_requests FROM (
  SELECT r.id, r.customer_id, r.event_date, r.guests, r.message,
   r.status, r.assigned_to, r.follow_up_at, r.created_at, c.name, c.email, c.phone
  FROM core.catering_requests r JOIN core.customers c ON c.id = r.customer_id
  WHERE c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
   AND (v_search = '' OR coalesce(c.name, '') ILIKE '%' || v_search || '%'
    OR coalesce(c.email, '') ILIKE '%' || v_search || '%'
    OR coalesce(c.phone, '') ILIKE '%' || v_search || '%')
  ORDER BY CASE WHEN r.status IN ('new','contacted','quoted') THEN 0 ELSE 1 END,
   r.follow_up_at ASC NULLS FIRST, r.created_at DESC LIMIT 100
 ) r;
 RETURN jsonb_build_object('customers', v_customers, 'requests', v_requests);
END;
$$;


--
-- Name: crm_overview_v2(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_overview_v2(p_search text DEFAULT ''::text, p_segment text DEFAULT 'all'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
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
            FROM (SELECT id, body, created_at, author_id FROM core.customer_notes
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
$$;


--
-- Name: crm_record_catering_decision_v1(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_record_catering_decision_v1(p_decision_id uuid, p_decision text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
       BEGIN
        IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active)
            OR NOT EXISTS (SELECT 1 FROM core.catering_decision_makers WHERE auth_user_id = auth.uid() AND active) THEN
              RAISE EXCEPTION 'Decision maker access required' USING ERRCODE = '42501';
               END IF;
                IF length(trim(coalesce(p_decision, ''))) NOT BETWEEN 1 AND 2000 THEN
                  RAISE EXCEPTION 'Invalid decision' USING ERRCODE = '22023';
                   END IF;
                    UPDATE core.catering_decisions q
                     SET decision = trim(p_decision), recorded_by = auth.uid(), recorded_at = now()
                      FROM core.catering_requests r
                       JOIN core.customers c ON c.id = r.customer_id
                        WHERE q.id = p_decision_id AND q.request_id = r.id AND q.recorded_at IS NULL
                           AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid;
                            RETURN FOUND;
                            END;
                            $$;


--
-- Name: crm_request_catering_decision_v1(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_request_catering_decision_v1(p_request_id uuid, p_question text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  IF length(trim(coalesce(p_question, ''))) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'Invalid question' USING ERRCODE = '22023';
  END IF;
  INSERT INTO core.catering_decisions(request_id, question, requested_by)
  SELECT r.id, trim(p_question), auth.uid()
  FROM core.catering_requests r
  JOIN core.customers c ON c.id = r.customer_id
  WHERE r.id = p_request_id
    AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
  ON CONFLICT (request_id) WHERE recorded_at IS NULL DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'Request missing or a decision is already pending' USING ERRCODE = '22023';
  END IF;
  RETURN v_id;
END;
$$;


--
-- Name: crm_resolve_form_error_v1(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_resolve_form_error_v1(p_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_changed integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  UPDATE core.form_errors SET resolved_at = now(), resolved_by = auth.uid() WHERE id = p_id AND resolved_at IS NULL;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed = 1;
END $$;


--
-- Name: crm_staff_authorized_v1(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_staff_authorized_v1() RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active);
$$;


--
-- Name: crm_update_catering(uuid, text, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.crm_update_catering(p_request_id uuid, p_status text, p_assigned_to text, p_follow_up_at timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE v_assigned_to text := regexp_replace(coalesce(p_assigned_to, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g');
BEGIN
 IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
  RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
 END IF;
 IF p_status IS NULL OR p_status NOT IN ('new','contacted','quoted','won','lost','closed')
  OR length(v_assigned_to) NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'Invalid input' USING ERRCODE = '22023';
 END IF;
 IF p_status IN ('new','contacted','quoted') AND p_follow_up_at IS NULL THEN
  RAISE EXCEPTION 'Open requests require a follow-up time' USING ERRCODE = '22023';
 END IF;
 UPDATE core.catering_requests r
 SET status = p_status, assigned_to = v_assigned_to, follow_up_at = p_follow_up_at
 FROM core.customers c
 WHERE r.id = p_request_id AND c.id = r.customer_id
  AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid;
 RETURN FOUND;
END;
$_$;


--
-- Name: finish_catering_staff_notification_v1(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finish_catering_staff_notification_v1(p_request_id uuid, p_sent boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  UPDATE core.catering_requests r
  SET staff_notification_sent_at = CASE WHEN p_sent THEN now() ELSE NULL END,
      staff_notification_error = CASE WHEN p_sent THEN NULL ELSE 'delivery_failed' END
  FROM core.customers c
  WHERE r.form_request_id = p_request_id AND c.id = r.customer_id
    AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
    AND r.staff_notification_attempted_at IS NOT NULL
    AND r.staff_notification_sent_at IS NULL;
END
$$;


--
-- Name: finish_form_error_alert_v1(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finish_form_error_alert_v1(p_id uuid, p_accepted boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  UPDATE core.form_errors SET alert_status = CASE WHEN p_accepted THEN 'accepted' ELSE 'failed' END,
    alert_accepted_at = CASE WHEN p_accepted THEN now() ELSE NULL END
    WHERE id = p_id AND alert_status = 'claimed';
END $$;


--
-- Name: get_active_offers(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_active_offers(p_business_id uuid) RETURNS TABLE(id uuid, name text, description text, code text, channel_target text, starts_at date, ends_at date)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  SELECT o.id,o.name,o.description,o.code,o.channel_target,o.starts_at,o.ends_at
  FROM core.offers o JOIN core.businesses b ON b.id=o.business_id
  WHERE o.business_id=p_business_id AND o.active
    AND (now() AT TIME ZONE b.timezone)::date BETWEEN o.starts_at AND o.ends_at
  ORDER BY o.starts_at DESC,o.id
$$;


--
-- Name: record_form_error_v1(uuid, uuid, text, text, text, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_form_error_v1(p_id uuid, p_request_id uuid, p_kind text, p_stage text, p_code text, p_status integer, p_claim_alert boolean DEFAULT false) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE v_inserted integer; v_claimed integer := 0;
BEGIN
  IF p_request_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text, 0));
  END IF;
  INSERT INTO core.form_errors(id,request_id,form_kind,stage,error_code,http_status)
    VALUES(p_id,p_request_id,p_kind,p_stage,p_code,p_status) ON CONFLICT(id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN RETURN false; END IF;
  -- A delayed background logger must not reopen an already accepted retry.
  IF EXISTS (SELECT 1 FROM core.signup_request_keys WHERE request_id = p_request_id) THEN
    UPDATE core.form_errors SET resolved_at = now() WHERE id = p_id;
    RETURN false;
  END IF;
  IF p_claim_alert THEN
    -- One atomic account-wide gate, including failed delivery attempts.
    UPDATE core.form_error_alert_gate SET last_attempt_at = now()
      WHERE singleton AND last_attempt_at <= now() - interval '15 minutes';
    GET DIAGNOSTICS v_claimed = ROW_COUNT;
    UPDATE core.form_errors SET alert_status = CASE WHEN v_claimed = 1 THEN 'claimed' ELSE 'suppressed' END
      WHERE id = p_id;
  END IF;
  RETURN v_claimed = 1;
END $$;


--
-- Name: record_klaviyo_status_v1(uuid, text, text, timestamp with time zone, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_klaviyo_status_v1(p_customer_id uuid, p_email text, p_status text, p_checked_at timestamp with time zone, p_provider_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE c core.customers%ROWTYPE; o core.klaviyo_email_observations%ROWTYPE; v_negative boolean;
 v_blocked_status text; v_blocked_at timestamptz;
BEGIN
 IF p_status IS NULL OR p_status NOT IN ('confirmed','pending','unsubscribed','suppressed','not_on_list')
  OR p_checked_at IS NULL OR p_checked_at>clock_timestamp()+interval '1 minute'
  OR p_checked_at<clock_timestamp()-interval '5 minutes' THEN
  RAISE EXCEPTION 'Invalid observation' USING ERRCODE='22023';
 END IF;
 -- Serialize observations and form updates for this customer; never trust a client-supplied email.
 SELECT * INTO c FROM core.customers WHERE id=p_customer_id
  AND business_id='a358eba4-b197-4309-805b-46f43a718454'::uuid FOR UPDATE;
 IF NOT FOUND OR c.email IS NULL OR lower(trim(c.email)) IS DISTINCT FROM p_email THEN
  RAISE EXCEPTION 'Customer changed or missing' USING ERRCODE='22023';
 END IF;
 SELECT * INTO o FROM core.klaviyo_email_observations WHERE customer_id=c.id;
 v_negative:=p_status IN ('unsubscribed','suppressed');
 IF o.checked_at IS NOT NULL AND o.checked_at>=p_checked_at AND NOT v_negative THEN
  RETURN jsonb_build_object('status',o.status,'checkedAt',o.checked_at,'providerUpdatedAt',o.provider_updated_at,
   'blocked',c.email_status='unsubscribed' OR o.blocked_at IS NOT NULL,
   'blockedStatus',o.blocked_status,'blockedAt',coalesce(o.blocked_at,c.email_suppressed_at));
 END IF;
 v_blocked_status:=coalesce(o.blocked_status,CASE WHEN v_negative THEN p_status END);
 v_blocked_at:=coalesce(o.blocked_at,CASE WHEN v_negative THEN p_checked_at END);
 IF v_negative THEN
  UPDATE core.customers SET email_status='unsubscribed',
   email_suppressed_at=coalesce(email_suppressed_at,p_checked_at),updated_at=now() WHERE id=c.id;
  -- One evidence event on first provider block, not on every profile refresh.
  IF o.blocked_at IS NULL THEN
   INSERT INTO core.consent_events(customer_id,event_type,source,evidence_status,note)
    VALUES(c.id,'suppression','klaviyo_readback','admin_suppression',
     CASE p_status WHEN 'unsubscribed' THEN 'Klaviyo unsubscribe observed; email marketing blocked.'
     ELSE 'Klaviyo suppression observed; email marketing blocked.' END);
  END IF;
 END IF;
 -- A late negative observation still blocks delivery, but cannot replace a newer snapshot.
 IF o.checked_at IS NOT NULL AND o.checked_at>=p_checked_at THEN
  p_status:=o.status; p_checked_at:=o.checked_at; p_provider_updated_at:=o.provider_updated_at;
 END IF;
 INSERT INTO core.klaviyo_email_observations(customer_id,status,checked_at,provider_updated_at,blocked_status,blocked_at)
 VALUES(c.id,p_status,p_checked_at,p_provider_updated_at,
  v_blocked_status,v_blocked_at)
 ON CONFLICT(customer_id) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,
  provider_updated_at=excluded.provider_updated_at,blocked_status=excluded.blocked_status,blocked_at=excluded.blocked_at;
 SELECT * INTO o FROM core.klaviyo_email_observations WHERE customer_id=c.id;
 RETURN jsonb_build_object('status',o.status,'checkedAt',o.checked_at,'providerUpdatedAt',o.provider_updated_at,
  'blocked',v_negative OR c.email_status='unsubscribed' OR o.blocked_at IS NOT NULL,
  'blockedStatus',o.blocked_status,'blockedAt',coalesce(o.blocked_at,c.email_suppressed_at));
END $$;


--
-- Name: resolve_form_errors_v1(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_form_errors_v1(p_request_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  -- Success of the same idempotent submission resolves its earlier failures only.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text, 0));
  UPDATE core.form_errors SET resolved_at = now() WHERE request_id = p_request_id AND resolved_at IS NULL;
END $$;


--
-- Name: submit_signup(uuid, text, text, text, text, boolean, boolean, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.submit_signup(p_business_id uuid, p_name text, p_email text, p_phone text, p_source text, p_consent_email boolean, p_consent_sms boolean, p_utm jsonb, p_meta jsonb DEFAULT NULL::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
  v_email text := nullif(lower(btrim(p_email)),'');
  v_phone text := nullif(btrim(p_phone),'');
  v_name text := nullif(btrim(p_name),'');
  v_source text := btrim(p_source);
  v_utm jsonb := coalesce(p_utm,'{}'::jsonb);
  v_meta jsonb := coalesce(p_meta,'{}'::jsonb);
  v_key text;
  v_customer uuid;
  v_signup uuid;
  v_fingerprint text;
  v_date date;
  v_guests integer;
  v_email_request boolean;
BEGIN
  IF p_business_id IS DISTINCT FROM 'a358eba4-b197-4309-805b-46f43a718454'::uuid OR
     NOT EXISTS (SELECT 1 FROM core.businesses WHERE id=p_business_id AND intake_enabled) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Intake unavailable';
  END IF;
  IF v_source IS NULL OR v_source NOT IN ('website_vip_form','website_vip_page','catering') THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid source';
  END IF;
  IF v_email IS NULL AND v_phone IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Contact required';
  END IF;
  IF v_email IS NOT NULL AND (length(v_email)>254 OR v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$') THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid email';
  END IF;
  IF v_phone IS NOT NULL AND v_phone !~ '^\+1[0-9]{10}$' THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid US phone';
  END IF;
  IF length(v_name)>200 OR jsonb_typeof(v_meta)<>'object' OR jsonb_typeof(v_utm)<>'object'
     OR octet_length(v_meta::text)>8192 OR octet_length(v_utm::text)>4096 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid or oversized input';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(v_meta) k WHERE k NOT IN ('event_date','guests','message')) THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Unsupported metadata';
  END IF;
  IF v_source<>'catering' AND v_meta<>'{}'::jsonb THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Metadata reserved for catering';
  END IF;
  IF length(v_meta->>'message')>4000 THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Message too long';
  END IF;
  IF nullif(v_meta->>'event_date','') IS NOT NULL THEN
    IF (v_meta->>'event_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid date';
    END IF;
    v_date := (v_meta->>'event_date')::date;
  END IF;
  IF v_meta ? 'guests' AND v_meta->>'guests' IS NOT NULL THEN
    IF (v_meta->>'guests') !~ '^[0-9]{1,5}$' THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid guests';
    END IF;
    v_guests := (v_meta->>'guests')::integer;
    IF v_guests<1 OR v_guests>10000 THEN
      RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid guests';
    END IF;
  END IF;
  v_email_request := v_source<>'catering' AND coalesce(p_consent_email,false) AND v_email IS NOT NULL;
  v_key := CASE WHEN v_email IS NOT NULL THEN 'email:'||v_email ELSE 'phone:'||v_phone END;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_key,0));
  v_fingerprint := md5(jsonb_build_array(p_business_id,v_name,v_email,v_phone,v_source,
                      coalesce(p_consent_email,false),coalesce(p_consent_sms,false),v_utm,v_meta)::text);
  IF EXISTS (SELECT 1 FROM core.signups WHERE fingerprint=v_fingerprint
             AND created_at>clock_timestamp()-interval '10 minutes') THEN RETURN; END IF;
  INSERT INTO core.customers(business_id,identity_key,name,email,phone,email_status)
    VALUES(p_business_id,v_key,v_name,v_email,v_phone,
           CASE WHEN v_email_request THEN 'pending_review' ELSE 'not_subscribed' END)
    ON CONFLICT(identity_key) DO UPDATE SET
      updated_at=now(),
      email_status=CASE WHEN core.customers.email_status='not_subscribed' AND v_email_request
                        AND core.customers.email_suppressed_at IS NULL
                        THEN 'pending_review' ELSE core.customers.email_status END
    RETURNING id INTO v_customer;
  INSERT INTO core.signups(business_id,customer_id,name,email,phone,source,consent_email,
                          consent_sms,utm,meta,fingerprint)
    VALUES(p_business_id,v_customer,v_name,v_email,v_phone,v_source,v_email_request,
           coalesce(p_consent_sms,false) AND v_phone IS NOT NULL,v_utm,v_meta,v_fingerprint)
    RETURNING id INTO v_signup;
  INSERT INTO core.consent_events(customer_id,signup_id,event_type,source,email_requested,
                                  sms_requested,evidence_status)
    VALUES(v_customer,v_signup,'request',v_source,v_email_request,
           coalesce(p_consent_sms,false) AND v_phone IS NOT NULL,
           CASE WHEN v_source='catering' THEN 'not_marketing' ELSE 'pending_review' END);
  IF v_source='catering' THEN
    INSERT INTO core.catering_requests(signup_id,customer_id,event_date,guests,message)
      VALUES(v_signup,v_customer,v_date,v_guests,v_meta->>'message');
  END IF;
END $_$;


--
-- Name: submit_signup_once(uuid, uuid, text, text, text, text, boolean, boolean, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.submit_signup_once(p_request_id uuid, p_business_id uuid, p_name text, p_email text, p_phone text, p_source text, p_consent_email boolean, p_consent_sms boolean, p_utm jsonb, p_meta jsonb DEFAULT NULL::jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_hash text;
  v_existing text;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Request ID required';
  END IF;
  v_hash := md5(pg_catalog.jsonb_build_array(
    p_business_id, p_name, p_email, p_phone, p_source,
    p_consent_email, p_consent_sms, p_utm, p_meta
  )::text);
  INSERT INTO core.signup_request_keys(request_id, payload_hash)
  VALUES (p_request_id, v_hash) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    SELECT payload_hash INTO v_existing
    FROM core.signup_request_keys WHERE request_id = p_request_id;
    IF v_existing IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Request ID reused with different content';
    END IF;
    RETURN;
  END IF;
  PERFORM public.submit_signup(
    p_business_id, p_name, p_email, p_phone, p_source,
    p_consent_email, p_consent_sms, p_utm, p_meta
  );
END
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: businesses; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.businesses (
    id uuid NOT NULL,
    name text NOT NULL,
    timezone text DEFAULT 'America/New_York'::text NOT NULL,
    intake_enabled boolean DEFAULT false NOT NULL,
    CONSTRAINT businesses_id_check CHECK ((id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid))
);


--
-- Name: catering_decision_makers; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.catering_decision_makers (
    auth_user_id uuid NOT NULL,
    active boolean DEFAULT true NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: catering_decisions; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.catering_decisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_id uuid NOT NULL,
    question text NOT NULL,
    requested_by uuid NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    decision text,
    recorded_by uuid,
    recorded_at timestamp with time zone,
    CONSTRAINT catering_decisions_decision_check CHECK (((decision IS NULL) OR ((length(TRIM(BOTH FROM decision)) >= 1) AND (length(TRIM(BOTH FROM decision)) <= 2000)))),
    CONSTRAINT catering_decisions_question_check CHECK (((length(TRIM(BOTH FROM question)) >= 1) AND (length(TRIM(BOTH FROM question)) <= 1000))),
    CONSTRAINT decision_consistency CHECK ((((decision IS NULL) AND (recorded_by IS NULL) AND (recorded_at IS NULL)) OR ((decision IS NOT NULL) AND (recorded_by IS NOT NULL) AND (recorded_at IS NOT NULL))))
);


--
-- Name: catering_requests; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.catering_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    signup_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    event_date date,
    guests integer,
    message text,
    status text DEFAULT 'new'::text NOT NULL,
    assigned_to text DEFAULT 'Talip'::text NOT NULL,
    follow_up_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    form_request_id uuid,
    staff_notification_attempted_at timestamp with time zone,
    staff_notification_sent_at timestamp with time zone,
    staff_notification_error text,
    is_test boolean DEFAULT false NOT NULL,
    test_reason text,
    CONSTRAINT catering_requests_guests_check CHECK (((guests > 0) AND (guests <= 10000))),
    CONSTRAINT catering_requests_status_check CHECK ((status = ANY (ARRAY['new'::text, 'contacted'::text, 'quoted'::text, 'won'::text, 'lost'::text, 'closed'::text])))
);


--
-- Name: consent_events; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.consent_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    signup_id uuid,
    event_type text NOT NULL,
    source text NOT NULL,
    email_requested boolean DEFAULT false NOT NULL,
    sms_requested boolean DEFAULT false NOT NULL,
    evidence_status text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT consent_events_event_type_check CHECK ((event_type = ANY (ARRAY['request'::text, 'suppression'::text]))),
    CONSTRAINT consent_events_evidence_status_check CHECK ((evidence_status = ANY (ARRAY['pending_review'::text, 'not_marketing'::text, 'admin_suppression'::text])))
);


--
-- Name: crm_staff; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.crm_staff (
    auth_user_id uuid NOT NULL,
    role text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_staff_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'staff'::text])))
);


--
-- Name: customer_follow_up_tasks; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.customer_follow_up_tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    created_by uuid NOT NULL,
    title text NOT NULL,
    assigned_to text NOT NULL,
    due_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_follow_up_tasks_assigned_to_check CHECK (((length(TRIM(BOTH FROM assigned_to)) >= 1) AND (length(TRIM(BOTH FROM assigned_to)) <= 100))),
    CONSTRAINT customer_follow_up_tasks_title_check CHECK (((length(TRIM(BOTH FROM title)) >= 1) AND (length(TRIM(BOTH FROM title)) <= 300)))
);


--
-- Name: customer_notes; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.customer_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    customer_id uuid NOT NULL,
    author_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customer_notes_body_check CHECK (((length(TRIM(BOTH FROM body)) >= 1) AND (length(TRIM(BOTH FROM body)) <= 2000)))
);


--
-- Name: customers; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    identity_key text NOT NULL,
    name text,
    email text,
    phone text,
    email_status text DEFAULT 'not_subscribed'::text NOT NULL,
    email_suppressed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT customers_check CHECK (((email IS NOT NULL) OR (phone IS NOT NULL))),
    CONSTRAINT customers_check1 CHECK (((email_suppressed_at IS NULL) OR (email_status = 'unsubscribed'::text))),
    CONSTRAINT customers_email_status_check CHECK ((email_status = ANY (ARRAY['not_subscribed'::text, 'pending_review'::text, 'subscribed'::text, 'unsubscribed'::text])))
);


--
-- Name: form_error_alert_gate; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.form_error_alert_gate (
    singleton boolean DEFAULT true NOT NULL,
    last_attempt_at timestamp with time zone DEFAULT '-infinity'::timestamp with time zone NOT NULL,
    CONSTRAINT form_error_alert_gate_singleton_check CHECK (singleton)
);


--
-- Name: form_errors; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.form_errors (
    id uuid NOT NULL,
    request_id uuid,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    form_kind text NOT NULL,
    stage text NOT NULL,
    error_code text NOT NULL,
    http_status integer NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    alert_status text DEFAULT 'not_requested'::text NOT NULL,
    alert_accepted_at timestamp with time zone,
    CONSTRAINT form_errors_alert_status_check CHECK ((alert_status = ANY (ARRAY['not_requested'::text, 'suppressed'::text, 'claimed'::text, 'accepted'::text, 'failed'::text]))),
    CONSTRAINT form_errors_error_code_check CHECK ((error_code = ANY (ARRAY['missing_server_configuration'::text, 'challenge_unavailable'::text, 'database_unavailable'::text, 'upstream_timeout'::text, 'upstream_network_error'::text, 'controlled_delivery_test'::text]))),
    CONSTRAINT form_errors_form_kind_check CHECK ((form_kind = ANY (ARRAY['vip'::text, 'catering'::text, 'unknown'::text]))),
    CONSTRAINT form_errors_http_status_check CHECK ((http_status = 503)),
    CONSTRAINT form_errors_stage_check CHECK ((stage = ANY (ARRAY['configuration'::text, 'challenge'::text, 'database'::text])))
);


--
-- Name: installation; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.installation (
    version text NOT NULL,
    declared_project_ref text NOT NULL,
    installed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: klaviyo_email_observations; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.klaviyo_email_observations (
    customer_id uuid NOT NULL,
    status text NOT NULL,
    checked_at timestamp with time zone NOT NULL,
    provider_updated_at timestamp with time zone,
    blocked_status text,
    blocked_at timestamp with time zone,
    CONSTRAINT klaviyo_email_observations_blocked_status_check CHECK ((blocked_status = ANY (ARRAY['unsubscribed'::text, 'suppressed'::text]))),
    CONSTRAINT klaviyo_email_observations_check CHECK (((blocked_status IS NULL) = (blocked_at IS NULL))),
    CONSTRAINT klaviyo_email_observations_status_check CHECK ((status = ANY (ARRAY['confirmed'::text, 'pending'::text, 'unsubscribed'::text, 'suppressed'::text, 'not_on_list'::text])))
);


--
-- Name: offers; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.offers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    code text,
    channel_target text DEFAULT 'clover'::text NOT NULL,
    starts_at date NOT NULL,
    ends_at date NOT NULL,
    active boolean DEFAULT false NOT NULL,
    CONSTRAINT offers_channel_target_check CHECK ((channel_target = 'clover'::text)),
    CONSTRAINT offers_check CHECK ((ends_at >= starts_at)),
    CONSTRAINT offers_name_check CHECK (((length(name) >= 1) AND (length(name) <= 200)))
);


--
-- Name: reporting_catering_v1; Type: VIEW; Schema: core; Owner: -
--

CREATE VIEW core.reporting_catering_v1 AS
 SELECT id,
    signup_id,
    customer_id,
    event_date,
    guests,
    message,
    status,
    assigned_to,
    follow_up_at,
    created_at,
    form_request_id,
    staff_notification_attempted_at,
    staff_notification_sent_at,
    staff_notification_error,
    is_test,
    test_reason
   FROM core.catering_requests
  WHERE (NOT is_test);


--
-- Name: signups; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.signups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    business_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    name text,
    email text,
    phone text,
    source text NOT NULL,
    consent_email boolean DEFAULT false NOT NULL,
    consent_sms boolean DEFAULT false NOT NULL,
    utm jsonb DEFAULT '{}'::jsonb NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    fingerprint text NOT NULL,
    processed boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_test boolean DEFAULT false NOT NULL,
    test_reason text,
    CONSTRAINT signups_source_check CHECK ((source = ANY (ARRAY['website_vip_form'::text, 'website_vip_page'::text, 'catering'::text])))
);


--
-- Name: reporting_signups_v1; Type: VIEW; Schema: core; Owner: -
--

CREATE VIEW core.reporting_signups_v1 AS
 SELECT id,
    business_id,
    customer_id,
    name,
    email,
    phone,
    source,
    consent_email,
    consent_sms,
    utm,
    meta,
    fingerprint,
    processed,
    created_at,
    is_test,
    test_reason
   FROM core.signups
  WHERE (NOT is_test);


--
-- Name: signup_request_keys; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.signup_request_keys (
    request_id uuid NOT NULL,
    payload_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: businesses businesses_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.businesses
    ADD CONSTRAINT businesses_pkey PRIMARY KEY (id);


--
-- Name: catering_decision_makers catering_decision_makers_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.catering_decision_makers
    ADD CONSTRAINT catering_decision_makers_pkey PRIMARY KEY (auth_user_id);


--
-- Name: catering_decisions catering_decisions_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.catering_decisions
    ADD CONSTRAINT catering_decisions_pkey PRIMARY KEY (id);


--
-- Name: catering_requests catering_requests_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.catering_requests
    ADD CONSTRAINT catering_requests_pkey PRIMARY KEY (id);


--
-- Name: catering_requests catering_requests_signup_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.catering_requests
    ADD CONSTRAINT catering_requests_signup_id_key UNIQUE (signup_id);


--
-- Name: consent_events consent_events_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.consent_events
    ADD CONSTRAINT consent_events_pkey PRIMARY KEY (id);


--
-- Name: crm_staff crm_staff_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.crm_staff
    ADD CONSTRAINT crm_staff_pkey PRIMARY KEY (auth_user_id);


--
-- Name: customer_follow_up_tasks customer_follow_up_tasks_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.customer_follow_up_tasks
    ADD CONSTRAINT customer_follow_up_tasks_pkey PRIMARY KEY (id);


--
-- Name: customer_notes customer_notes_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.customer_notes
    ADD CONSTRAINT customer_notes_pkey PRIMARY KEY (id);


--
-- Name: customers customers_identity_key_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.customers
    ADD CONSTRAINT customers_identity_key_key UNIQUE (identity_key);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: form_error_alert_gate form_error_alert_gate_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.form_error_alert_gate
    ADD CONSTRAINT form_error_alert_gate_pkey PRIMARY KEY (singleton);


--
-- Name: form_errors form_errors_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.form_errors
    ADD CONSTRAINT form_errors_pkey PRIMARY KEY (id);


--
-- Name: installation installation_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.installation
    ADD CONSTRAINT installation_pkey PRIMARY KEY (version);


--
-- Name: klaviyo_email_observations klaviyo_email_observations_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.klaviyo_email_observations
    ADD CONSTRAINT klaviyo_email_observations_pkey PRIMARY KEY (customer_id);


--
-- Name: offers offers_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.offers
    ADD CONSTRAINT offers_pkey PRIMARY KEY (id);


--
-- Name: signup_request_keys signup_request_keys_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.signup_request_keys
    ADD CONSTRAINT signup_request_keys_pkey PRIMARY KEY (request_id);


--
-- Name: signups signups_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.signups
    ADD CONSTRAINT signups_pkey PRIMARY KEY (id);


--
-- Name: catering_decisions_queue; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX catering_decisions_queue ON core.catering_decisions USING btree (recorded_at, requested_at DESC);


--
-- Name: catering_one_pending_decision_per_request; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX catering_one_pending_decision_per_request ON core.catering_decisions USING btree (request_id) WHERE (recorded_at IS NULL);


--
-- Name: catering_requests_form_request_id_unique; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX catering_requests_form_request_id_unique ON core.catering_requests USING btree (form_request_id) WHERE (form_request_id IS NOT NULL);


--
-- Name: customer_follow_up_tasks_due; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX customer_follow_up_tasks_due ON core.customer_follow_up_tasks USING btree (customer_id, completed_at, due_at);


--
-- Name: customer_notes_recent; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX customer_notes_recent ON core.customer_notes USING btree (customer_id, created_at DESC);


--
-- Name: customers_email_unique; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX customers_email_unique ON core.customers USING btree (lower(email)) WHERE (email IS NOT NULL);


--
-- Name: form_errors_open_time; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX form_errors_open_time ON core.form_errors USING btree (occurred_at DESC) WHERE (resolved_at IS NULL);


--
-- Name: form_errors_request; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX form_errors_request ON core.form_errors USING btree (request_id) WHERE (resolved_at IS NULL);


--
-- Name: signups_retry_lookup; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX signups_retry_lookup ON core.signups USING btree (fingerprint, created_at);


--
-- Name: catering_requests classify_test_catering; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER classify_test_catering BEFORE INSERT OR UPDATE ON core.catering_requests FOR EACH ROW EXECUTE FUNCTION core.classify_test_catering_v1();


--
-- Name: signups classify_test_signup; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER classify_test_signup BEFORE INSERT OR UPDATE OF name, email, is_test ON core.signups FOR EACH ROW EXECUTE FUNCTION core.classify_test_signup_v1();


--
-- Name: catering_requests link_catering_form_request; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER link_catering_form_request BEFORE INSERT ON core.catering_requests FOR EACH ROW EXECUTE FUNCTION core.link_catering_form_request();


--
-- Name: signups propagate_test_signup; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER propagate_test_signup AFTER UPDATE OF is_test, test_reason ON core.signups FOR EACH ROW EXECUTE FUNCTION core.propagate_test_signup_v1();


--
-- Name: signup_request_keys set_form_request_context; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER set_form_request_context AFTER INSERT ON core.signup_request_keys FOR EACH ROW EXECUTE FUNCTION core.set_form_request_context();


--
-- Name: catering_decision_makers catering_decision_makers_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.catering_decision_makers
    ADD CONSTRAINT catering_decision_makers_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: catering_decisions catering_decisions_recorded_by_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.catering_decisions
    ADD CONSTRAINT catering_decisions_recorded_by_fkey FOREIGN KEY (recorded_by) REFERENCES auth.users(id);


--
-- Name: catering_decisions catering_decisions_request_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.catering_decisions
    ADD CONSTRAINT catering_decisions_request_id_fkey FOREIGN KEY (request_id) REFERENCES core.catering_requests(id) ON DELETE CASCADE;


--
-- Name: catering_decisions catering_decisions_requested_by_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.catering_decisions
    ADD CONSTRAINT catering_decisions_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id);


--
-- Name: catering_requests catering_requests_customer_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.catering_requests
    ADD CONSTRAINT catering_requests_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES core.customers(id);


--
-- Name: catering_requests catering_requests_signup_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.catering_requests
    ADD CONSTRAINT catering_requests_signup_id_fkey FOREIGN KEY (signup_id) REFERENCES core.signups(id);


--
-- Name: consent_events consent_events_customer_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.consent_events
    ADD CONSTRAINT consent_events_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES core.customers(id);


--
-- Name: consent_events consent_events_signup_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.consent_events
    ADD CONSTRAINT consent_events_signup_id_fkey FOREIGN KEY (signup_id) REFERENCES core.signups(id);


--
-- Name: crm_staff crm_staff_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.crm_staff
    ADD CONSTRAINT crm_staff_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: customer_follow_up_tasks customer_follow_up_tasks_created_by_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.customer_follow_up_tasks
    ADD CONSTRAINT customer_follow_up_tasks_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: customer_follow_up_tasks customer_follow_up_tasks_customer_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.customer_follow_up_tasks
    ADD CONSTRAINT customer_follow_up_tasks_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES core.customers(id) ON DELETE CASCADE;


--
-- Name: customer_notes customer_notes_author_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.customer_notes
    ADD CONSTRAINT customer_notes_author_id_fkey FOREIGN KEY (author_id) REFERENCES auth.users(id);


--
-- Name: customer_notes customer_notes_customer_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.customer_notes
    ADD CONSTRAINT customer_notes_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES core.customers(id) ON DELETE CASCADE;


--
-- Name: customers customers_business_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.customers
    ADD CONSTRAINT customers_business_id_fkey FOREIGN KEY (business_id) REFERENCES core.businesses(id);


--
-- Name: klaviyo_email_observations klaviyo_email_observations_customer_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.klaviyo_email_observations
    ADD CONSTRAINT klaviyo_email_observations_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES core.customers(id);


--
-- Name: offers offers_business_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.offers
    ADD CONSTRAINT offers_business_id_fkey FOREIGN KEY (business_id) REFERENCES core.businesses(id);


--
-- Name: signups signups_business_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.signups
    ADD CONSTRAINT signups_business_id_fkey FOREIGN KEY (business_id) REFERENCES core.businesses(id);


--
-- Name: signups signups_customer_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.signups
    ADD CONSTRAINT signups_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES core.customers(id);


--
-- Name: businesses; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.businesses ENABLE ROW LEVEL SECURITY;

--
-- Name: catering_decision_makers; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.catering_decision_makers ENABLE ROW LEVEL SECURITY;

--
-- Name: catering_decisions; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.catering_decisions ENABLE ROW LEVEL SECURITY;

--
-- Name: catering_requests; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.catering_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: consent_events; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.consent_events ENABLE ROW LEVEL SECURITY;

--
-- Name: crm_staff; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.crm_staff ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_follow_up_tasks; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.customer_follow_up_tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_notes; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.customer_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: customers; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.customers ENABLE ROW LEVEL SECURITY;

--
-- Name: form_error_alert_gate; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.form_error_alert_gate ENABLE ROW LEVEL SECURITY;

--
-- Name: form_errors; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.form_errors ENABLE ROW LEVEL SECURITY;

--
-- Name: installation; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.installation ENABLE ROW LEVEL SECURITY;

--
-- Name: klaviyo_email_observations; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.klaviyo_email_observations ENABLE ROW LEVEL SECURITY;

--
-- Name: offers; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.offers ENABLE ROW LEVEL SECURITY;

--
-- Name: signup_request_keys; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.signup_request_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: signups; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.signups ENABLE ROW LEVEL SECURITY;

--
-- Name: FUNCTION classify_test_catering_v1(); Type: ACL; Schema: core; Owner: -
--

REVOKE ALL ON FUNCTION core.classify_test_catering_v1() FROM PUBLIC;


--
-- Name: FUNCTION classify_test_signup_v1(); Type: ACL; Schema: core; Owner: -
--

REVOKE ALL ON FUNCTION core.classify_test_signup_v1() FROM PUBLIC;


--
-- Name: FUNCTION link_catering_form_request(); Type: ACL; Schema: core; Owner: -
--

REVOKE ALL ON FUNCTION core.link_catering_form_request() FROM PUBLIC;


--
-- Name: FUNCTION propagate_test_signup_v1(); Type: ACL; Schema: core; Owner: -
--

REVOKE ALL ON FUNCTION core.propagate_test_signup_v1() FROM PUBLIC;


--
-- Name: FUNCTION set_form_request_context(); Type: ACL; Schema: core; Owner: -
--

REVOKE ALL ON FUNCTION core.set_form_request_context() FROM PUBLIC;


--
-- Name: FUNCTION suppress_email(p_email text, p_reason text); Type: ACL; Schema: core; Owner: -
--

REVOKE ALL ON FUNCTION core.suppress_email(p_email text, p_reason text) FROM PUBLIC;


--
-- Name: FUNCTION test_lead_reason_v1(p_name text, p_email text); Type: ACL; Schema: core; Owner: -
--

REVOKE ALL ON FUNCTION core.test_lead_reason_v1(p_name text, p_email text) FROM PUBLIC;


--
-- Name: FUNCTION claim_catering_staff_notification_v1(p_request_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_catering_staff_notification_v1(p_request_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_catering_staff_notification_v1(p_request_id uuid) TO service_role;


--
-- Name: FUNCTION crm_add_note(p_customer_id uuid, p_body text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_add_note(p_customer_id uuid, p_body text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_add_note(p_customer_id uuid, p_body text) TO authenticated;


--
-- Name: FUNCTION crm_catering_decisions_v1(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_catering_decisions_v1() FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_catering_decisions_v1() TO authenticated;


--
-- Name: FUNCTION crm_catering_notification_status_v1(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_catering_notification_status_v1() FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_catering_notification_status_v1() TO authenticated;


--
-- Name: FUNCTION crm_complete_task_v1(p_task_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_complete_task_v1(p_task_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_complete_task_v1(p_task_id uuid) TO authenticated;


--
-- Name: FUNCTION crm_create_task_v1(p_customer_id uuid, p_title text, p_assigned_to text, p_due_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_create_task_v1(p_customer_id uuid, p_title text, p_assigned_to text, p_due_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_create_task_v1(p_customer_id uuid, p_title text, p_assigned_to text, p_due_at timestamp with time zone) TO authenticated;


--
-- Name: FUNCTION crm_customer_tasks_v1(p_customer_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_customer_tasks_v1(p_customer_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_customer_tasks_v1(p_customer_id uuid) TO authenticated;


--
-- Name: FUNCTION crm_follow_up_queue_v1(p_queue text, p_offset integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_follow_up_queue_v1(p_queue text, p_offset integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_follow_up_queue_v1(p_queue text, p_offset integer) TO authenticated;


--
-- Name: FUNCTION crm_form_errors_v1(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_form_errors_v1() FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_form_errors_v1() TO authenticated;


--
-- Name: FUNCTION crm_klaviyo_status_v1(p_customer_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_klaviyo_status_v1(p_customer_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_klaviyo_status_v1(p_customer_id uuid) TO authenticated;


--
-- Name: FUNCTION crm_overview(p_search text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_overview(p_search text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_overview(p_search text) TO authenticated;


--
-- Name: FUNCTION crm_overview_v2(p_search text, p_segment text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_overview_v2(p_search text, p_segment text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_overview_v2(p_search text, p_segment text) TO authenticated;


--
-- Name: FUNCTION crm_record_catering_decision_v1(p_decision_id uuid, p_decision text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_record_catering_decision_v1(p_decision_id uuid, p_decision text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_record_catering_decision_v1(p_decision_id uuid, p_decision text) TO authenticated;


--
-- Name: FUNCTION crm_request_catering_decision_v1(p_request_id uuid, p_question text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_request_catering_decision_v1(p_request_id uuid, p_question text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_request_catering_decision_v1(p_request_id uuid, p_question text) TO authenticated;


--
-- Name: FUNCTION crm_resolve_form_error_v1(p_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_resolve_form_error_v1(p_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_resolve_form_error_v1(p_id uuid) TO authenticated;


--
-- Name: FUNCTION crm_staff_authorized_v1(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_staff_authorized_v1() FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_staff_authorized_v1() TO authenticated;


--
-- Name: FUNCTION crm_update_catering(p_request_id uuid, p_status text, p_assigned_to text, p_follow_up_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.crm_update_catering(p_request_id uuid, p_status text, p_assigned_to text, p_follow_up_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.crm_update_catering(p_request_id uuid, p_status text, p_assigned_to text, p_follow_up_at timestamp with time zone) TO authenticated;


--
-- Name: FUNCTION finish_catering_staff_notification_v1(p_request_id uuid, p_sent boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finish_catering_staff_notification_v1(p_request_id uuid, p_sent boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finish_catering_staff_notification_v1(p_request_id uuid, p_sent boolean) TO service_role;


--
-- Name: FUNCTION finish_form_error_alert_v1(p_id uuid, p_accepted boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.finish_form_error_alert_v1(p_id uuid, p_accepted boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.finish_form_error_alert_v1(p_id uuid, p_accepted boolean) TO service_role;


--
-- Name: FUNCTION get_active_offers(p_business_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_active_offers(p_business_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_active_offers(p_business_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_active_offers(p_business_id uuid) TO authenticated;


--
-- Name: FUNCTION record_form_error_v1(p_id uuid, p_request_id uuid, p_kind text, p_stage text, p_code text, p_status integer, p_claim_alert boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_form_error_v1(p_id uuid, p_request_id uuid, p_kind text, p_stage text, p_code text, p_status integer, p_claim_alert boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_form_error_v1(p_id uuid, p_request_id uuid, p_kind text, p_stage text, p_code text, p_status integer, p_claim_alert boolean) TO service_role;


--
-- Name: FUNCTION record_klaviyo_status_v1(p_customer_id uuid, p_email text, p_status text, p_checked_at timestamp with time zone, p_provider_updated_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_klaviyo_status_v1(p_customer_id uuid, p_email text, p_status text, p_checked_at timestamp with time zone, p_provider_updated_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_klaviyo_status_v1(p_customer_id uuid, p_email text, p_status text, p_checked_at timestamp with time zone, p_provider_updated_at timestamp with time zone) TO service_role;


--
-- Name: FUNCTION resolve_form_errors_v1(p_request_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.resolve_form_errors_v1(p_request_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.resolve_form_errors_v1(p_request_id uuid) TO service_role;


--
-- Name: FUNCTION submit_signup(p_business_id uuid, p_name text, p_email text, p_phone text, p_source text, p_consent_email boolean, p_consent_sms boolean, p_utm jsonb, p_meta jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.submit_signup(p_business_id uuid, p_name text, p_email text, p_phone text, p_source text, p_consent_email boolean, p_consent_sms boolean, p_utm jsonb, p_meta jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.submit_signup(p_business_id uuid, p_name text, p_email text, p_phone text, p_source text, p_consent_email boolean, p_consent_sms boolean, p_utm jsonb, p_meta jsonb) TO service_role;


--
-- Name: FUNCTION submit_signup_once(p_request_id uuid, p_business_id uuid, p_name text, p_email text, p_phone text, p_source text, p_consent_email boolean, p_consent_sms boolean, p_utm jsonb, p_meta jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.submit_signup_once(p_request_id uuid, p_business_id uuid, p_name text, p_email text, p_phone text, p_source text, p_consent_email boolean, p_consent_sms boolean, p_utm jsonb, p_meta jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.submit_signup_once(p_request_id uuid, p_business_id uuid, p_name text, p_email text, p_phone text, p_source text, p_consent_email boolean, p_consent_sms boolean, p_utm jsonb, p_meta jsonb) TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict iai0gQMHFj7pzi797Y7eH79dulTVAo4e4ffBFbt1VelJLYMr4L1d3ubfeAJFIN4

