// Shared, side-effect-free routing policy. Production identifiers are the existing
// deployment guard, not configurable fallback targets for a test environment.
export const PRODUCTION_SUPABASE_URL = "https://khgczybubufouraqyrcj.supabase.co";
export const PRODUCTION_BUSINESS_ID = "a358eba4-b197-4309-805b-46f43a718454";
export const PRODUCTION_PAGES_HOST = "nazar-restaurant-website.pages.dev";
export const TEST_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
export const TEST_TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
type Values = Record<string, string | boolean | undefined>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isPreviewHost(hostname: string) {
  return (hostname.endsWith(".pages.dev") && hostname !== PRODUCTION_PAGES_HOST) || ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}
export function requiresIsolatedEnvironment(hostname: string, mode: unknown) {
  return isPreviewHost(hostname) || (typeof mode === "string" && mode !== "" && mode !== "production");
}
function testTarget(url: unknown, businessId: unknown) {
  return typeof url === "string" && /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url)
    && url !== PRODUCTION_SUPABASE_URL && typeof businessId === "string"
    && uuid.test(businessId);
}
function validHostname(value: unknown): value is string {
  return typeof value === "string" && value.length <= 253
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(value);
}
export function resolveBrowserEnvironment(env: Values, hostname = "") {
  const isolated = requiresIsolatedEnvironment(hostname, env.VITE_APP_ENV);
  const url = isolated ? env.VITE_TEST_SUPABASE_URL : env.VITE_SUPABASE_URL;
  const key = isolated ? env.VITE_TEST_SUPABASE_ANON_KEY : env.VITE_SUPABASE_ANON_KEY;
  const businessId = isolated ? env.VITE_TEST_BUSINESS_ID : env.VITE_NAZAR_BUSINESS_ID;
  const configured = isolated
    ? env.VITE_APP_ENV === "isolated-test" && testTarget(url, businessId)
      && typeof key === "string" && key.startsWith("sb_publishable_") && key !== env.VITE_SUPABASE_ANON_KEY
    : url === PRODUCTION_SUPABASE_URL && typeof key === "string" && key.startsWith("sb_publishable_") && businessId === PRODUCTION_BUSINESS_ID;
  const productionSiteKey = typeof env.VITE_TURNSTILE_SITE_KEY === "string" && !/^[123]x0+(?:AA|AB|BB|FF)$/.test(env.VITE_TURNSTILE_SITE_KEY) ? env.VITE_TURNSTILE_SITE_KEY : undefined;
  return { isolated, configured, url: configured ? String(url) : "", key: configured ? String(key) : "", businessId: configured ? String(businessId) : "",
    turnstileSiteKey: isolated ? configured && env.VITE_TEST_TURNSTILE_SITE_KEY === TEST_TURNSTILE_SITE_KEY ? TEST_TURNSTILE_SITE_KEY : undefined : productionSiteKey };
}
export function resolveServerEnvironment(env: Values, hostname = "") {
  const isolated = requiresIsolatedEnvironment(hostname, env.APP_ENV);
  if (!isolated) return { isolated: false, configured: !/^[123]x0+AA$/.test(String(env.TURNSTILE_SECRET_KEY || "")), url: PRODUCTION_SUPABASE_URL, businessId: PRODUCTION_BUSINESS_ID,
    secret: typeof env.SUPABASE_SECRET_KEY === "string" ? env.SUPABASE_SECRET_KEY : "", turnstileSecret: typeof env.TURNSTILE_SECRET_KEY === "string" ? env.TURNSTILE_SECRET_KEY : "", turnstileExpectedHostname: hostname };
  const configured = env.APP_ENV === "isolated-test" && testTarget(env.TEST_SUPABASE_URL, env.TEST_BUSINESS_ID)
    && typeof env.TEST_SUPABASE_SECRET_KEY === "string" && env.TEST_SUPABASE_SECRET_KEY.startsWith("sb_secret_")
    && env.TEST_SUPABASE_SECRET_KEY !== env.SUPABASE_SECRET_KEY && env.TEST_TURNSTILE_SECRET_KEY === TEST_TURNSTILE_SECRET_KEY
    && validHostname(env.TEST_TURNSTILE_EXPECTED_HOSTNAME);
  return { isolated: true, configured, url: configured ? String(env.TEST_SUPABASE_URL) : "", businessId: configured ? String(env.TEST_BUSINESS_ID) : "",
    secret: configured ? String(env.TEST_SUPABASE_SECRET_KEY) : "", turnstileSecret: configured ? TEST_TURNSTILE_SECRET_KEY : "",
    turnstileExpectedHostname: configured ? String(env.TEST_TURNSTILE_EXPECTED_HOSTNAME) : "" };
}
export function isolatedBrowser() {
  const env = (import.meta as ImportMeta & { env?: Values }).env;
  return requiresIsolatedEnvironment(typeof window === "undefined" ? "" : window.location.hostname || "", env?.VITE_APP_ENV);
}
