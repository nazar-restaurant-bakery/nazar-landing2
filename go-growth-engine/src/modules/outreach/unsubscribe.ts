import crypto from 'crypto';
import { goRpc } from '../../lib/supabase-client.js';
import { isUuid } from '../../lib/validation.js';
import { getConfig } from '../../config.js';

// Token: base64url(business_id + ":" + email) + "." + base64url(HMAC-SHA256(secret, ilk kısım)). Süresiz.

function getSecret(): string {
  const secret = getConfig('GO_UNSUBSCRIBE_SECRET');
  if (!secret) {
    throw new Error('GO_UNSUBSCRIBE_SECRET boş; outreach gönderilemez.');
  }
  return secret;
}

// Outreach göndermeden önce çağrılır: ayar eksikse hata fırlatır
export function assertUnsubscribeConfig(): void {
  getSecret();
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

// Bağlantı adresi işletmenin outreach_link_base_url ayarından gelir
export function buildUnsubscribeUrl(linkBaseUrl: string, businessId: string, email: string): string {
  const secret = getSecret();
  const baseUrl = linkBaseUrl.replace(/\/+$/, '');
  const payload = Buffer.from(`${businessId}:${email.trim().toLowerCase()}`, 'utf8').toString('base64url');
  return `${baseUrl}/u/${payload}.${sign(payload, secret)}`;
}

export function verifyUnsubscribeToken(token: string): { businessId: string; email: string } | null {
  const secret = getConfig('GO_UNSUBSCRIBE_SECRET');
  if (!secret || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, signature] = parts;

  const givenBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(sign(payload, secret));
  if (givenBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(givenBuffer, expectedBuffer)) {
    return null;
  }

  const decoded = Buffer.from(payload, 'base64url').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;

  const businessId = decoded.slice(0, separator);
  const email = decoded.slice(separator + 1);
  if (!isUuid(businessId) || !email || email !== email.toLowerCase()) return null;

  return { businessId, email };
}

export interface SuppressionOptions {
  reason: 'unsubscribe_link';
  source: 'email';
  leadStatus: 'unsubscribed';
}

const UNSUBSCRIBE_LINK: SuppressionOptions = { reason: 'unsubscribe_link', source: 'email', leadStatus: 'unsubscribed' };

// Suppression kaydı varsa dokunulmaz (ilk neden korunur); lead durumu güncellenir.
// Fonksiyon yalnız ekler; engel listesinden kayıt kaldıran bir yol yoktur.
export async function suppressEmail(businessId: string, email: string, options: SuppressionOptions = UNSUBSCRIBE_LINK): Promise<void> {
  await goRpc<boolean>('go_suppress_email_v1', {
    p_business_id: businessId, p_email: email, p_reason: options.reason,
    p_source: options.source, p_lead_status: options.leadStatus
  });
}

export async function isEmailSuppressed(businessId: string, email: string): Promise<boolean> {
  const found = await goRpc<string[]>('go_suppressed_emails_v1', { p_business_id: businessId, p_emails: [email] });
  return found.length > 0;
}
