import crypto from 'crypto';
import { goRpc } from './supabase-client.js';

// Anahtar açık metin saklanmaz; yalnız SHA-256 hex özeti ve ilk 8 karakteri (key_prefix)
export function hashApiKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

export function generateApiKey(): string {
  return `go_${crypto.randomBytes(32).toString('base64url')}`;
}

export type ApiKeyCheck = 'ok' | 'invalid_key' | 'business_missing' | 'business_not_found' | 'forbidden';

// Önce anahtar, sonra işletme, sonra anahtar-işletme bağı (401 → 400/404 → 403 sırası korunur)
export async function authorizeApiKey(key: string, businessId: string | null): Promise<ApiKeyCheck> {
  return goRpc<ApiKeyCheck>('go_api_key_authorize_v1', { p_key_hash: hashApiKey(key), p_business_id: businessId });
}
