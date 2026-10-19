import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { browserDeployment } from "./supabase";

// Share the existing default staff Auth session. Callers which use provider
// routes must still enforce their isolated-Preview block independently.
let staffClient: SupabaseClient | null | undefined;

export function getStaffSupabase() {
  if (staffClient === undefined) staffClient = browserDeployment.configured
    ? createClient(browserDeployment.url, browserDeployment.key) : null;
  return staffClient;
}
