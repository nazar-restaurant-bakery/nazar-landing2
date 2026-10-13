-- Local draft: one-use email review links and versioned catering quotes.
-- Do not apply to production before isolated database and browser tests.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.installation WHERE declared_project_ref = 'khgczybubufouraqyrcj')
     OR to_regclass('core.catering_requests') IS NULL
     OR to_regclass('core.crm_staff') IS NULL THEN
    RAISE EXCEPTION 'STOP: expected Nazar-production CRM foundation is missing';
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS core.catering_quote_links (
  request_id uuid PRIMARY KEY REFERENCES core.catering_requests(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  issued_by uuid NOT NULL REFERENCES auth.users(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
ALTER TABLE core.catering_quote_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.catering_quote_links FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS core.catering_quote_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES core.catering_requests(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  stage text NOT NULL DEFAULT 'approved' CHECK (stage IN ('approved','sent','accepted','declined')),
  menu text NOT NULL CHECK (length(trim(menu)) BETWEEN 1 AND 4000),
  total_cents integer NOT NULL CHECK (total_cents BETWEEN 1 AND 100000000),
  pickup_terms text NOT NULL CHECK (length(trim(pickup_terms)) BETWEEN 1 AND 1000),
  decision_name text NOT NULL CHECK (length(trim(decision_name)) BETWEEN 1 AND 100),
  approved_at timestamptz NOT NULL DEFAULT now(),
  approval_link_issued_by uuid NOT NULL REFERENCES auth.users(id),
  delivery_channel text CHECK (delivery_channel IN ('email','phone')),
  delivery_recipient text,
  sent_by uuid REFERENCES auth.users(id),
  sent_at timestamptz,
  response_note text CHECK (response_note IS NULL OR length(trim(response_note)) BETWEEN 1 AND 2000),
  response_at timestamptz,
  UNIQUE (request_id, version),
  CONSTRAINT quote_delivery_consistency CHECK ((stage = 'approved' AND sent_at IS NULL AND sent_by IS NULL)
    OR (stage IN ('sent','accepted','declined') AND sent_at IS NOT NULL AND sent_by IS NOT NULL)),
  CONSTRAINT quote_response_consistency CHECK ((stage IN ('approved','sent') AND response_at IS NULL)
    OR (stage IN ('accepted','declined') AND response_at IS NOT NULL AND response_note IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS catering_quote_history
  ON core.catering_quote_versions(request_id, version DESC);
ALTER TABLE core.catering_quote_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.catering_quote_versions FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.catering_issue_quote_link_v1(p_request_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_token text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Staff access required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM core.catering_requests r JOIN core.customers c ON c.id = r.customer_id
    WHERE r.id = p_request_id AND r.status IN ('new','contacted','quoted')
      AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
  ) THEN RAISE EXCEPTION 'Open request not found' USING ERRCODE = '22023'; END IF;
  -- Two independent cryptographic UUIDs provide an unguessable 64-hex token.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO core.catering_quote_links(request_id, token_hash, issued_by, expires_at)
  VALUES (p_request_id, md5(v_token), auth.uid(), now() + interval '48 hours')
  ON CONFLICT (request_id) DO UPDATE SET token_hash = excluded.token_hash,
    issued_by = excluded.issued_by, issued_at = now(),
    expires_at = excluded.expires_at, consumed_at = NULL;
  RETURN v_token;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.catering_quote_link_context_v1(p_token text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_result jsonb;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid or expired link' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_build_object('request_id', r.id, 'event_date', r.event_date,
    'guests', r.guests, 'message', r.message, 'expires_at', l.expires_at)
  INTO v_result
  FROM core.catering_quote_links l
  JOIN core.catering_requests r ON r.id = l.request_id
  JOIN core.customers c ON c.id = r.customer_id
  WHERE l.token_hash = md5(p_token) AND l.consumed_at IS NULL AND l.expires_at > now()
    AND r.status IN ('new','contacted','quoted')
    AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid;
  IF v_result IS NULL THEN RAISE EXCEPTION 'Invalid or expired link' USING ERRCODE = '22023'; END IF;
  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.catering_decide_quote_v1(
  p_token text, p_menu text, p_total_cents integer, p_pickup_terms text, p_decision_name text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_link core.catering_quote_links%ROWTYPE; v_version integer; v_id uuid;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$'
     OR length(trim(coalesce(p_menu, ''))) NOT BETWEEN 1 AND 4000
     OR p_total_cents IS NULL OR p_total_cents NOT BETWEEN 1 AND 100000000
     OR length(trim(coalesce(p_pickup_terms, ''))) NOT BETWEEN 1 AND 1000
     OR length(trim(coalesce(p_decision_name, ''))) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid quote decision' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_link FROM core.catering_quote_links
  WHERE token_hash = md5(p_token) AND consumed_at IS NULL AND expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid or expired link' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM core.catering_requests r JOIN core.customers c ON c.id = r.customer_id
  WHERE r.id = v_link.request_id AND r.status IN ('new','contacted','quoted')
    AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
  FOR UPDATE OF r;
  IF NOT FOUND THEN RAISE EXCEPTION 'Open request not found' USING ERRCODE = '22023'; END IF;
  SELECT coalesce(max(version), 0) + 1 INTO v_version
  FROM core.catering_quote_versions WHERE request_id = v_link.request_id;
  INSERT INTO core.catering_quote_versions(request_id, version, menu, total_cents,
    pickup_terms, decision_name, approval_link_issued_by)
  VALUES (v_link.request_id, v_version, trim(p_menu), p_total_cents,
    trim(p_pickup_terms), trim(p_decision_name), v_link.issued_by) RETURNING id INTO v_id;
  UPDATE core.catering_quote_links SET consumed_at = now()
  WHERE request_id = v_link.request_id;
  RETURN v_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.catering_quote_overview_v1()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
DECLARE v_rows jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Staff access required' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(q)), '[]'::jsonb) INTO v_rows FROM (
    SELECT q.id, q.request_id, q.version, q.stage, q.menu, q.total_cents, q.decision_name,
           q.pickup_terms, q.approved_at, q.sent_at, q.delivery_channel,
           q.delivery_recipient, q.response_note, q.response_at
    FROM core.catering_quote_versions q
    JOIN core.catering_requests r ON r.id = q.request_id
    JOIN core.customers c ON c.id = r.customer_id
    WHERE c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
    ORDER BY q.approved_at DESC LIMIT 100
  ) q;
  RETURN jsonb_build_object('items', v_rows);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.catering_mark_quote_sent_v1(
  p_quote_id uuid, p_channel text, p_recipient text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Staff access required' USING ERRCODE = '42501';
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('email','phone') THEN
    RAISE EXCEPTION 'Invalid delivery channel' USING ERRCODE = '22023';
  END IF;
  UPDATE core.catering_quote_versions q
  SET stage = 'sent', delivery_channel = p_channel, delivery_recipient = p_recipient,
      sent_by = auth.uid(), sent_at = now()
  FROM core.catering_requests r JOIN core.customers c ON c.id = r.customer_id
  WHERE q.id = p_quote_id AND q.request_id = r.id AND q.stage = 'approved'
    AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
    AND ((p_channel = 'email' AND p_recipient = c.email AND c.email IS NOT NULL)
      OR (p_channel = 'phone' AND p_recipient = c.phone AND c.phone IS NOT NULL));
  RETURN FOUND;
END;
$fn$;

REVOKE ALL ON FUNCTION public.catering_issue_quote_link_v1(uuid),
  public.catering_quote_link_context_v1(text),
  public.catering_decide_quote_v1(text,text,integer,text,text),
  public.catering_quote_overview_v1(),
  public.catering_mark_quote_sent_v1(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.catering_issue_quote_link_v1(uuid),
  public.catering_quote_overview_v1(),
  public.catering_mark_quote_sent_v1(uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.catering_quote_link_context_v1(text),
  public.catering_decide_quote_v1(text,text,integer,text,text) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
