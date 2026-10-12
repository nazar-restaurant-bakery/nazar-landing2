-- Draft: apply only after the first staff Auth user has been invited.
-- Grant staff access by inserting that user's auth.users.id into core.crm_staff.
-- Never grant access based on an email address supplied by the browser.

BEGIN;

CREATE TABLE IF NOT EXISTS core.crm_staff (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'staff')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE core.crm_staff ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.crm_staff FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS core.customer_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES core.customers(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES auth.users(id),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_notes_recent ON core.customer_notes(customer_id, created_at DESC);
ALTER TABLE core.customer_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.customer_notes FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.crm_overview(p_search text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_search text := left(trim(coalesce(p_search, '')), 100);
  v_customers jsonb;
  v_requests jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.crm_staff
    WHERE auth_user_id = auth.uid() AND active
  ) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) INTO v_customers
  FROM (
    SELECT c.id, c.name, c.email, c.phone, c.email_status, c.created_at,
           (SELECT count(*) FROM core.signups s WHERE s.customer_id = c.id) AS signup_count,
           (SELECT max(s.created_at) FROM core.signups s WHERE s.customer_id = c.id) AS last_signup_at,
           (SELECT s.source FROM core.signups s WHERE s.customer_id = c.id
            ORDER BY s.created_at DESC LIMIT 1) AS last_source,
           (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.created_at DESC), '[]'::jsonb)
            FROM (SELECT id, body, created_at FROM core.customer_notes
                  WHERE customer_id = c.id ORDER BY created_at DESC LIMIT 10) n) AS notes
    FROM core.customers c
    WHERE c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid
      AND (v_search = '' OR coalesce(c.name, '') ILIKE '%' || v_search || '%'
           OR coalesce(c.email, '') ILIKE '%' || v_search || '%'
           OR coalesce(c.phone, '') ILIKE '%' || v_search || '%')
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
      AND (v_search = '' OR coalesce(c.name, '') ILIKE '%' || v_search || '%'
           OR coalesce(c.email, '') ILIKE '%' || v_search || '%'
           OR coalesce(c.phone, '') ILIKE '%' || v_search || '%')
    ORDER BY CASE WHEN r.status IN ('new', 'contacted', 'quoted') THEN 0 ELSE 1 END,
             r.follow_up_at ASC NULLS FIRST, r.created_at DESC
    LIMIT 100
  ) r;
  RETURN jsonb_build_object('customers', v_customers, 'requests', v_requests);
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_update_catering(
  p_request_id uuid, p_status text, p_assigned_to text, p_follow_up_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM core.crm_staff WHERE auth_user_id = auth.uid() AND active) THEN
    RAISE EXCEPTION 'Access denied' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('new', 'contacted', 'quoted', 'won', 'lost', 'closed')
     OR length(trim(coalesce(p_assigned_to, ''))) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid input' USING ERRCODE = '22023';
  END IF;
  IF p_status IN ('new', 'contacted', 'quoted') AND p_follow_up_at IS NULL THEN
    RAISE EXCEPTION 'Open requests require a follow-up time' USING ERRCODE = '22023';
  END IF;
  UPDATE core.catering_requests r
  SET status = p_status, assigned_to = trim(p_assigned_to), follow_up_at = p_follow_up_at
  FROM core.customers c
  WHERE r.id = p_request_id AND c.id = r.customer_id
    AND c.business_id = 'a358eba4-b197-4309-805b-46f43a718454'::uuid;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.crm_add_note(p_customer_id uuid, p_body text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
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

REVOKE ALL ON FUNCTION public.crm_overview(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crm_update_catering(uuid, text, text, timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.crm_add_note(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_overview(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crm_update_catering(uuid, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crm_add_note(uuid, text) TO authenticated;

COMMIT;
