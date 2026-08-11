-- =============================================================================
-- Nazar VIP signups — REQUIRED server-side setup
-- =============================================================================
--
-- Run this ONCE against the Supabase project (zvsvciufzbxjmrlbwxgy), in the
-- Dashboard SQL editor. Until it runs, the VIP form on the website will fail:
-- the browser client currently gets
--
--     PGRST106  "Invalid schema: core"
--     hint: Only the following schemas are exposed: public, graphql_public, marketing
--
-- Two things are missing today:
--   1. the `core` schema is not exposed to the Data API (PostgREST), and
--   2. the `anon` role has NO table grant on core.signups.
--
-- There IS already an RLS policy ("anon insert signups", WITH CHECK true), but a
-- policy only narrows what a granted role may do — it does not grant anything on
-- its own. Both pieces are needed.
--
-- Pick ONE of the two options below.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- OPTION A — expose `core` and let anon INSERT (matches the shipped frontend)
-- -----------------------------------------------------------------------------
-- This is what src/lib/supabase.ts expects: the client is pinned to
-- `db: { schema: "core" }` and inserts straight into core.signups.

grant usage on schema core to anon;
grant insert on table core.signups to anon;

-- Do NOT grant select/update/delete: the form only ever writes.
-- The existing "anon insert signups" RLS policy already covers the INSERT.

-- Expose the schema to the Data API. Prefer doing this in the Dashboard
-- (Settings -> API -> Exposed schemas -> add `core`) so the setting survives
-- project config changes; the SQL below is the equivalent.
alter role authenticator
  set pgrst.db_schemas = 'public, graphql_public, marketing, core';

notify pgrst, 'reload config';
notify pgrst, 'reload schema';

-- Heads-up: exposing `core` also makes core.businesses / core.business_settings
-- / core.commissions / core.offers visible to PostgREST. anon holds no grants on
-- those, so requests get "permission denied" — but if that surface bothers you,
-- use Option B instead.


-- -----------------------------------------------------------------------------
-- OPTION B — keep `core` private, expose one SECURITY DEFINER RPC in `public`
-- -----------------------------------------------------------------------------
-- Tighter: nothing about `core` is reachable from the browser, and the function
-- controls exactly which columns a visitor can set.
--
-- If you choose this, ALSO change the frontend:
--   - src/lib/supabase.ts  -> drop the `db: { schema: "core" }` option
--   - src/components/VipSignupForm.tsx -> replace the
--       supabase.from("signups").insert({...})
--     call with
--       supabase.rpc("vip_signup", { p_business_id: ..., p_name: ..., ... })
--
-- Then run everything below instead of Option A.

/*
create or replace function public.vip_signup(
  p_business_id   uuid,
  p_name          text default null,
  p_email         text default null,
  p_phone         text default null,
  p_source        text default 'website_vip_form',
  p_utm           jsonb default null,
  p_consent_email boolean default false,
  p_consent_sms   boolean default false
)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if coalesce(p_email, '') = '' and coalesce(p_phone, '') = '' then
    raise exception 'email or phone is required';
  end if;

  if not exists (select 1 from core.businesses b where b.id = p_business_id) then
    raise exception 'unknown business';
  end if;

  insert into core.signups (
    business_id, name, email, phone, source, utm, consent_email, consent_sms
  )
  values (
    p_business_id,
    nullif(btrim(p_name), ''),
    lower(nullif(btrim(p_email), '')),
    nullif(btrim(p_phone), ''),
    coalesce(nullif(btrim(p_source), ''), 'website_vip_form'),
    p_utm,
    coalesce(p_consent_email, false),
    coalesce(p_consent_sms, false)
  );
end;
$$;

revoke all on function public.vip_signup(uuid, text, text, text, text, jsonb, boolean, boolean) from public;
grant execute on function public.vip_signup(uuid, text, text, text, text, jsonb, boolean, boolean) to anon;

notify pgrst, 'reload schema';
*/


-- -----------------------------------------------------------------------------
-- Optional hardening (works with either option)
-- -----------------------------------------------------------------------------
-- Stops the same address being submitted twice. Note that a plain unique index
-- makes the second submit return a 409; the form surfaces that as a generic
-- error, so add it only if you'd rather have clean data than a silent re-signup.
/*
create unique index if not exists signups_business_email_uniq
  on core.signups (business_id, lower(email))
  where email is not null;

create unique index if not exists signups_business_phone_uniq
  on core.signups (business_id, phone)
  where phone is not null;
*/
