// Ortam değişkenleri tek yerden okunur.
// Workers'ta nodejs_compat (compatibility_date ≥ 2025-04-01) process.env'i var/secret'larla doldurur;
// yerel scriptler .env'i dotenv ile yükler. Değerler modül yüklenirken değil, çağrı anında okunur.
export type ConfigKey =
  | 'GO_SUPABASE_URL'
  | 'GO_SUPABASE_SERVICE_ROLE_KEY'
  | 'APOLLO_API_KEY'
  | 'APIFY_API_TOKEN'
  | 'SMARTLEAD_API_KEY'
  | 'SMARTLEAD_WEBHOOK_SECRET'
  | 'GO_UNSUBSCRIBE_SECRET'
  | 'GO_SCHEDULER_ENABLED';

export function getConfig(key: ConfigKey): string {
  return (process.env[key] ?? '').trim();
}
