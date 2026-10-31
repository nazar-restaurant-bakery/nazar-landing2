import { getConfig } from '../config.js';

// Platform veritabanı: core şeması kapalıdır. GO tablolara doğrudan erişmez; yalnız
// service_role'e açık public.go_*_v1 fonksiyonlarını çağırır (migration 20261030000400).
export type GoFunction =
  | 'go_api_key_authorize_v1' | 'go_api_key_create_v1' | 'go_api_key_revoke_v1' | 'go_business_check_v1'
  | 'go_outreach_settings_get_v1' | 'go_outreach_business_ids_v1'
  | 'go_enrichment_credits_used_v1' | 'go_leads_enrichment_pending_v1' | 'go_enrichment_log_v1'
  | 'go_lead_enrichment_note_v1' | 'go_lead_enrichment_fail_v1' | 'go_lead_enrichment_found_v1'
  | 'go_leads_by_email_v1' | 'go_suppressed_emails_v1' | 'go_leads_insert_v1' | 'go_lead_fill_v1'
  | 'go_suppress_email_v1' | 'go_platform_verify_v1'
  // Sıra 32 (20261030000500): tek 168 saat kapısı + Smartlead
  | 'go_dispatch_quota_v1' | 'go_dispatch_due_v1' | 'go_dispatch_reserve_v1' | 'go_dispatch_result_v1'
  | 'go_smartlead_business_v1' | 'go_smartlead_campaigns_set_v1' | 'go_smartlead_event_v1';

type Rpc = (name: GoFunction, args: Record<string, unknown>) => Promise<unknown>;

let override: Rpc | null = null;

// PostgREST hatası: kod ve mesaj loga gider; anahtar ya da istek gövdesi yazılmaz
export class GoDatabaseError extends Error {
  constructor(public status: number, public code: string | null, message: string) {
    super(message);
  }
}

// Yeni sb_secret_ anahtarları JWT değildir: yalnız apikey başlığında gider.
// Eski service_role JWT'si ise Authorization başlığında da gönderilir.
function connection() {
  const supabaseUrl = getConfig('GO_SUPABASE_URL').replace(/\/+$/, '');
  const supabaseServiceKey = getConfig('GO_SUPABASE_SERVICE_ROLE_KEY');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl) || !supabaseServiceKey) {
    throw new Error('Veritabanı bağlantısı yok (GO_SUPABASE_URL / GO_SUPABASE_SERVICE_ROLE_KEY).');
  }
  const headers: Record<string, string> = { apikey: supabaseServiceKey, 'Content-Type': 'application/json' };
  if (!supabaseServiceKey.startsWith('sb_')) headers.Authorization = `Bearer ${supabaseServiceKey}`;
  return { url: supabaseUrl, headers };
}

export async function goRpc<T>(name: GoFunction, args: Record<string, unknown> = {}): Promise<T> {
  if (override) return await override(name, args) as T;
  const { url, headers } = connection();
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers, body: JSON.stringify(args), signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  if (!response.ok) {
    let fault: { code?: string; message?: string } = {};
    try { fault = JSON.parse(text); } catch { /* gövde JSON değil */ }
    throw new GoDatabaseError(response.status, fault.code ?? null, `${name}: ${fault.message ?? `HTTP ${response.status}`}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

// Yalnız testler: veritabanı yerine sahte çağrı
export function setGoRpcForTests(fake: Rpc | null): void {
  override = fake;
}
