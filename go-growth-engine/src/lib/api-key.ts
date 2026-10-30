import crypto from 'crypto';
import { coreDb } from './supabase-client.js';

// Anahtar açık metin saklanmaz; yalnız SHA-256 hex özeti ve ilk 8 karakteri (key_prefix)
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateApiKey(): string {
  return `go_${crypto.randomBytes(32).toString('base64url')}`;
}

export async function findActiveApiKeyId(key: string): Promise<string | null> {
  const { data, error } = await coreDb()
    .from('api_keys')
    .select('id')
    .eq('key_hash', hashApiKey(key))
    .is('revoked_at', null)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data?.id ?? null;
}

export async function isApiKeyBoundToBusiness(apiKeyId: string, businessId: string): Promise<boolean> {
  const { data, error } = await coreDb()
    .from('api_key_businesses')
    .select('api_key_id')
    .eq('api_key_id', apiKeyId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return Boolean(data);
}
