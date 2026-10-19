export const NAZAR_PROJECT = "https://khgczybubufouraqyrcj.supabase.co";
export const NAZAR_BUSINESS = "a358eba4-b197-4309-805b-46f43a718454";
export const OPS_BUCKET = "nazar-ops";
export const ACTIONS = ["collect", "sync_clover_csv", "retry_failed_job", "offer_set_active", "ads_set_status", "product_set_channel", "commission_report"] as const;
export type ActionName = typeof ACTIONS[number];
export type ActionStatus = "queued" | "running" | "done" | "failed" | "not_connected";
export type Environment = Record<string, string | undefined>;
export type SafeAction = { id: string; request_key: string; action: ActionName; requested_by: string | null; actor_kind?: "staff" | "scheduler"; requested_at: string; status: ActionStatus; result: SafeResult | Record<string, never>; finished_at: string | null };
export type ClaimedAction = { id: string; request_key: string; action: ActionName; payload: Record<string, unknown>; claim_token: string; requested_by: string | null; actor_kind?: "staff" | "scheduler"; requested_at: string };
export type SafeResult = { code: string; message: string; downloadPath?: string; [key: string]: unknown };
export type Commission = { business_id: string; period_month: string; qualified_sales: number; baseline: number; refunds: number; qicr: number; rate: number; commission_amount: number; computed_at: string; persisted: boolean; source_file?: string; collected_at?: string; period_start?: string; period_end?: string };
export const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function allowedOrigin(origin: string | null, env: Environment) {
  if (!origin) return true;
  if (["https://www.nazarrestaurantandbakery.com", "https://nazarrestaurantandbakery.com", "https://nazar-restaurant-website.pages.dev"].includes(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.nazar-restaurant-website\.pages\.dev$/.test(origin)) return true;
  return env.OPS_ALLOW_LOCALHOST === "true" && /^http:\/\/localhost(?::\d{1,5})?$/.test(origin);
}
