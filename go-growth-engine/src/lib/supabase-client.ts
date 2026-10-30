import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getConfig } from '../config.js';

let client: SupabaseClient | null = null;

// core şemasına bağlı istemci; ilk çağrıda kurulur, ayar eksikse hata fırlatır
export function coreDb() {
  if (!client) {
    const supabaseUrl = getConfig('GO_SUPABASE_URL');
    const supabaseServiceKey = getConfig('GO_SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl.startsWith('http') || !supabaseServiceKey) {
      throw new Error('Veritabanı bağlantısı yok (GO_SUPABASE_URL / GO_SUPABASE_SERVICE_ROLE_KEY).');
    }
    client = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });
  }
  return client.schema('core');
}
