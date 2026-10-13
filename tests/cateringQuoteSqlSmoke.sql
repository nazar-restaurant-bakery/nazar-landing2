\set ON_ERROR_STOP on
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;
CREATE SCHEMA auth;
CREATE SCHEMA core;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE TABLE core.installation(declared_project_ref text);
INSERT INTO core.installation VALUES ('khgczybubufouraqyrcj');
CREATE TABLE core.customers(
  id uuid PRIMARY KEY, business_id uuid NOT NULL, name text, email text, phone text
);
CREATE TABLE core.catering_requests(
  id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES core.customers(id),
  status text NOT NULL, event_date date, guests integer, message text
);
CREATE TABLE core.crm_staff(auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id), active boolean);
INSERT INTO auth.users VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO core.crm_staff VALUES ('11111111-1111-4111-8111-111111111111', true);
INSERT INTO core.customers VALUES (
  '22222222-2222-4222-8222-222222222222',
  'a358eba4-b197-4309-805b-46f43a718454', 'Synthetic Customer',
  'synthetic@example.com', '+12035550123'
);
INSERT INTO core.catering_requests VALUES (
  '33333333-3333-4333-8333-333333333333',
  '22222222-2222-4222-8222-222222222222', 'new',
  '2026-10-20', 20, 'Synthetic tray request'
);
\ir ../database/20261013_catering_quote_versions.sql

SELECT NOT has_table_privilege('anon', 'core.catering_quote_versions', 'SELECT')
  AND NOT has_table_privilege('authenticated', 'core.catering_quote_versions', 'SELECT')
  AND NOT has_function_privilege('anon', 'public.catering_issue_quote_link_v1(uuid)', 'EXECUTE')
  AS access_ok \gset
\if :access_ok
\else
  \echo 'FAIL: direct table or link-issue access is exposed'
  \quit 1
\endif
SET ROLE anon;
SET request.jwt.claim.sub = '';
DO $$
BEGIN
  BEGIN
    PERFORM public.catering_issue_quote_link_v1('33333333-3333-4333-8333-333333333333');
    RAISE EXCEPTION 'Unexpected anonymous link issue success';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END
$$;
RESET ROLE;

SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SELECT public.catering_issue_quote_link_v1('33333333-3333-4333-8333-333333333333') AS token \gset
SET ROLE anon;
SET request.jwt.claim.sub = '';
SELECT (public.catering_quote_link_context_v1(:'token')->>'message') = 'Synthetic tray request' AS context_ok \gset
\if :context_ok
\else
  \echo 'FAIL: context mismatch'
  \quit 1
\endif
SELECT public.catering_decide_quote_v1(:'token', 'Mixed Grill tray', 47500,
  'Pickup October 20 at 2 PM', 'Yücel') AS quote_id \gset
RESET ROLE;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SELECT set_config('test.quote_token', :'token', false);
SELECT count(*) = 1 AS quote_ok FROM core.catering_quote_versions
WHERE id = :'quote_id'::uuid AND stage = 'approved' AND total_cents = 47500
  AND decision_name = 'Yücel' \gset
\if :quote_ok
\else
  \echo 'FAIL: quote mismatch'
  \quit 1
\endif
DO $$
BEGIN
  BEGIN
    PERFORM public.catering_decide_quote_v1(
      current_setting('test.quote_token'), 'Second menu', 10, 'Pickup', 'Test');
    RAISE EXCEPTION 'Unexpected repeat success';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END
$$;
DO $$
BEGIN
  BEGIN
    PERFORM public.catering_quote_link_context_v1(current_setting('test.quote_token'));
    RAISE EXCEPTION 'Unexpected consumed link access';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;
END
$$;
SELECT public.catering_issue_quote_link_v1('33333333-3333-4333-8333-333333333333') AS token2 \gset
SET ROLE anon;
SET request.jwt.claim.sub = '';
SELECT public.catering_decide_quote_v1(:'token2', 'Updated Mixed Grill tray', 48000,
  'Pickup October 20 at 2 PM', 'Yücel') AS quote2_id \gset
RESET ROLE;
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
SELECT public.catering_mark_quote_sent_v1(:'quote_id'::uuid, 'email',
  'synthetic@example.com') AS stale_send_ok \gset
\if :stale_send_ok
  \echo 'FAIL: superseded quote marked sent'
  \quit 1
\endif
SELECT public.catering_mark_quote_sent_v1(:'quote2_id'::uuid, 'email',
  'synthetic@example.com') AS sent_ok \gset
\if :sent_ok
\else
  \echo 'FAIL: send record failed'
  \quit 1
\endif
SELECT public.catering_mark_quote_sent_v1(:'quote2_id'::uuid, 'email',
  'synthetic@example.com') AS repeat_send_ok \gset
\if :repeat_send_ok
  \echo 'FAIL: duplicate send record accepted'
  \quit 1
\endif
\echo 'PASS: quote link, decision, and manual delivery state'
