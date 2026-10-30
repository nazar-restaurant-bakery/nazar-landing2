import crypto from 'crypto';
import { HttpError } from '../../lib/http-error.js';
import { suppressEmail } from '../outreach/unsubscribe.js';

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/**
 * Svix imzası: base64(HMAC-SHA256(base64decode(secret'in "whsec_" sonrası), `${id}.${timestamp}.${hamGövde}`)).
 * svix-signature boşlukla ayrılmış birden çok "v1,<imza>" içerebilir; biri eşleşmeli.
 */
export function verifySvixSignature(rawBody: string, headers: SvixHeaders, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !secret.startsWith('whsec_')) return false;

  // Hem eski hem ileri tarihli zaman damgası reddedilir
  const timestampSeconds = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || Math.abs(nowSeconds - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  if (key.length === 0) return false;

  const expected = Buffer.from(
    crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`, 'utf8').digest('base64')
  );

  for (const part of signature.split(' ')) {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) continue;
    const given = Buffer.from(value);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) {
      return true;
    }
  }
  return false;
}

/**
 * İmzası doğrulanmış olayı işler; sonucu kısa bir etiket olarak döner (log için).
 * Tekrar gelen olay sorun çıkarmaz: suppression çakışmada dokunulmaz, durum zaten hedefteyse güncellenmez.
 */
export async function handleResendEvent(event: any): Promise<string> {
  const type = event?.type;
  if (type !== 'email.bounced' && type !== 'email.complained') {
    return `ignored_type:${type}`;
  }

  const bounceType = event?.data?.bounce?.type;
  if (type === 'email.bounced' && bounceType !== 'Permanent') {
    // Geçici (ve bilinmeyen) geri dönmeler: yalnız log
    return `bounce_${bounceType ?? 'unknown'}_logged`;
  }

  const emailId = event?.data?.email_id;
  if (typeof emailId !== 'string' || !emailId) {
    return 'no_email_id';
  }

  // Gönderim kaydı (message_log ↔ provider_message_id) platforma Görev 6/7 ile taşınır.
  // O zamana kadar olay eşlenemez: 503 ile Resend yeniden dener, olay sessizce düşmez.
  throw new HttpError(503, 'İşlem başarısız', `dispatch_log_not_migrated:${emailId}`);
}

// Görev 7'de gönderim kaydı eşlemesi bu yardımcıyı kullanır (engel listesine yalnız ekler)
export async function suppressBouncedOrComplained(businessId: string, email: string, type: 'email.bounced' | 'email.complained') {
  await suppressEmail(businessId, email, type === 'email.bounced'
    ? { reason: 'hard_bounce', source: 'resend_webhook', leadStatus: 'bounced' }
    : { reason: 'complaint', source: 'resend_webhook', leadStatus: 'unsubscribed' });
}
