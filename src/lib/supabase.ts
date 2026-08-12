// src/lib/supabase.ts
//
// Browser Supabase client for the marketing site.
//
// The client stays on the DEFAULT `public` schema. Supabase's Data API only
// exposes `public`, and exposing `core` to reach `core.signups` directly would
// also put `core.business_settings` and `core.commissions` on the wire — so we
// never talk to `core` from the browser at all.
//
// Everything goes through SECURITY DEFINER functions in `public` that `anon`
// may EXECUTE:
//
//   submit_signup(...)     inserts into core.signups on our behalf and rejects
//                          an unknown business_id
//   get_active_offers(...) reads the live offers for one business
//
// Each has a fixed argument list, so the browser's whole reach into the
// database is those two calls.
//
// The key below is the *publishable* (anon) key, so it is safe to ship in the
// bundle: EXECUTE on those two functions is all it buys you.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/* -------------------------------------------------------------------------- */
/* Database types                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One row of `core.signups`, as written by `public.submit_signup`. Not
 * reachable from the browser — kept here to document what the RPC produces.
 */
export type Signup = {
  id: string;
  business_id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  /** Free-form origin label, e.g. "website-form". */
  source: string | null;
  /** Captured UTM params, or null when the visitor arrived without any. */
  utm: Record<string, string> | null;
  consent_email: boolean | null;
  consent_sms: boolean | null;
  /** Flipped by the back-office once the lead has been actioned. */
  processed: boolean | null;
  created_at: string;
};

/** Arguments accepted by `public.submit_signup`. */
export type SubmitSignupArgs = {
  p_business_id: string;
  p_name: string | null;
  p_email: string | null;
  p_phone: string | null;
  p_source: string | null;
  p_consent_email: boolean;
  p_consent_sms: boolean;
  p_utm: Record<string, string> | null;
  /**
   * Free-form extras that don't have their own column — catering event date,
   * guest count, and so on. Optional: the function defaults it to NULL.
   */
  p_meta?: Record<string, unknown> | null;
};

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
      submit_signup: {
        Args: SubmitSignupArgs;
        /** The function returns void. */
        Returns: undefined;
      };
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

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** `core.businesses.id` for Nazar — passed to the RPC on every signup. */
export const NAZAR_BUSINESS_ID = (import.meta.env.VITE_NAZAR_BUSINESS_ID ?? "") as string;

/**
 * True when every env var the signup form needs is present. Deploys that forget
 * `.env.local` should degrade to a friendly message, not a blank page, so the
 * client is null instead of throwing at import time.
 */
export const isSupabaseConfigured = Boolean(
  supabaseUrl && supabaseAnonKey && NAZAR_BUSINESS_ID
);

export const supabase: NazarSupabaseClient | null = isSupabaseConfigured
  ? createClient<Database>(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        // No one signs in on the marketing site; skip the session machinery.
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
