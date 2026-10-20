-- Local-only PostgreSQL fixture; never run on hosted Supabase.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE SCHEMA auth;
CREATE SCHEMA core;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('test.jwt_role',true)$$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULLIF(current_setting('test.uid',true),'')::uuid$$;
GRANT USAGE ON SCHEMA auth TO service_role,authenticated;
GRANT EXECUTE ON FUNCTION auth.role(),auth.uid() TO service_role,authenticated;
CREATE TABLE core.businesses(id uuid PRIMARY KEY,name text NOT NULL);
CREATE TABLE core.customers(id uuid PRIMARY KEY,business_id uuid NOT NULL REFERENCES core.businesses(id),email text,phone text);
CREATE TABLE core.crm_staff(auth_user_id uuid PRIMARY KEY,active boolean NOT NULL);
CREATE FUNCTION public.crm_staff_authorized_v1() RETURNS boolean LANGUAGE sql SECURITY DEFINER
  SET search_path='' AS $$SELECT current_setting('test.staff',true)='1'$$;
REVOKE ALL ON FUNCTION public.crm_staff_authorized_v1() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.crm_staff_authorized_v1() TO authenticated;
INSERT INTO core.businesses VALUES ('11111111-1111-4111-8111-111111111111','Synthetic restaurant');
INSERT INTO core.customers VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','ONE@EXAMPLE.invalid','2035550101'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111','two@example.invalid','2035550102'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111','three@example.invalid','2035550102');
