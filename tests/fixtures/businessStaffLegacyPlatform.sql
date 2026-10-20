-- LOCAL SYNTHETIC DATABASE ONLY. Never run on Supabase hosted projects.
-- This file supplies the managed auth/storage surface excluded from the reviewed
-- schema-only application dump. It does not replace or patch that dump.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE SET search_path=''
AS $$ SELECT nullif(pg_catalog.current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE SET search_path=''
AS $$ SELECT nullif(pg_catalog.current_setting('request.jwt.claim.role',true),'') $$;
GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION auth.uid(),auth.role() TO anon,authenticated,service_role;
CREATE SCHEMA storage;
CREATE TABLE storage.buckets(
  id text PRIMARY KEY,name text NOT NULL,public boolean NOT NULL DEFAULT false,
  file_size_limit bigint,allowed_mime_types text[]
);
CREATE TABLE storage.objects(
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  bucket_id text REFERENCES storage.buckets(id),name text NOT NULL
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;
GRANT SELECT ON storage.objects TO anon,authenticated;
