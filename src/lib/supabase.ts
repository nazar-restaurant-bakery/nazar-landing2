// src/lib/supabase.ts
//
// Browser Supabase client for the marketing site.
//
// The client stays on the DEFAULT `public` schema. Supabase's Data API only
// exposes `public`, and exposing `core` to reach `core.signups` directly would
// also put `core.business_settings` and `core.commissions` on the wire — so we
// never talk to `core` from the browser at all.
//
// The browser may only call get_active_offers. VIP and catering submissions go
// to the protected Cloudflare Pages Function at /api/signup, which verifies
// Turnstile before using a server-only Supabase secret key.
//
// The key below is the *publishable* (anon) key, so it is safe to ship in the
// bundle: it cannot write a signup after the database cutover.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveBrowserEnvironment } from "./deploymentEnvironment";

/* -------------------------------------------------------------------------- */
/* Database types                                                             */
/* -------------------------------------------------------------------------- */

/** One row returned by `public.get_active_offers`. */
export type Offer = {
  id: string;
  name: string;
  description: string | null;
  code: string | null;
  /** Which ordering channel the offer applies to, e.g. "clover". */
  channel_target: string | null;
  /** ISO date (`YYYY-MM-DD`), not a timestamp. */
  starts_at: string | null;
  ends_at: string | null;
};

export type Database = {
  public: {
    Tables: Record<never, never>;
    Views: Record<never, never>;
    Functions: {
      get_active_offers: {
        Args: { p_business_id: string };
        Returns: Offer[];
      };
    };
    Enums: Record<never, never>;
    CompositeTypes: Record<never, never>;
  };
};

export type NazarSupabaseClient = SupabaseClient<Database>;

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export const browserDeployment = resolveBrowserEnvironment(import.meta.env, typeof window === "undefined" ? "" : window.location.hostname);
const supabaseUrl = browserDeployment.url;
const supabaseAnonKey = browserDeployment.key;

/** `core.businesses.id` for Nazar — used for public offer lookup. */
export const NAZAR_BUSINESS_ID = browserDeployment.businessId;

/**
 * True when every env var the signup form needs is present. Deploys that forget
 * `.env.local` should degrade to a friendly message, not a blank page, so the
 * client is null instead of throwing at import time.
 */
export const isSupabaseConfigured = browserDeployment.configured;

export const supabase: NazarSupabaseClient | null = isSupabaseConfigured
  ? createClient<Database>(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        // No one signs in on the marketing site; skip the session machinery.
        storageKey: "nazar-marketing-no-session",
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
  : null;

if (!isSupabaseConfigured && import.meta.env.DEV) {
  console.warn(
    "[supabase] Missing VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY or " +
      "VITE_NAZAR_BUSINESS_ID — copy .env.example to .env.local."
  );
}

export default supabase;
