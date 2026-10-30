import crypto from 'crypto';
import { goRpc } from '../../lib/supabase-client.js';

// Smartlead webhook'ları imzalı değildir (belgede imza/secret yok). Kimlik doğrulama,
// webhook adresindeki gizli belirteçle yapılır: /webhooks/smartlead/<SMARTLEAD_WEBHOOK_SECRET>.
export const HANDLED_EVENTS = ['EMAIL_SENT', 'EMAIL_REPLY', 'EMAIL_BOUNCE', 'LEAD_UNSUBSCRIBED'] as const;
type HandledEvent = (typeof HANDLED_EVENTS)[number];

export function verifyWebhookToken(given: string | undefined, secret: string): boolean {
  if (!given || secret.length < 32) return false;
  const a = crypto.createHash('sha256').update(given, 'utf8').digest();
  const b = crypto.createHash('sha256').update(secret, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// Olay türüne göre aday adresi farklı alanda gelir; veritabanı, bu kampanyada
// gönderimi olan adayla eşleşeni seçer (gönderen posta kutusu eşleşmez).
function candidateEmails(event: any): string[] {
  const values = [event?.lead_email, event?.sl_lead_email, event?.to_email, event?.from_email, event?.email, event?.lead?.email];
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.includes('@')).map((v) => v.trim().toLowerCase()))].slice(0, 6);
}

function occurredAt(event: any): string | null {
  for (const value of [event?.time_sent, event?.time_replied, event?.event_timestamp, event?.timestamp]) {
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  }
  return null;
}

export type WebhookOutcome = { status: number; outcome: string };

// Ham gövdenin SHA-256'sı olay anahtarıdır: Smartlead'in yeniden denemesi aynı anahtarı üretir.
export async function handleSmartleadEvent(rawBody: string): Promise<WebhookOutcome> {
  let event: any;
  try { event = JSON.parse(rawBody); } catch { return { status: 400, outcome: 'invalid_body' }; }
  const type = event?.event_type;
  if (!HANDLED_EVENTS.includes(type)) return { status: 200, outcome: `ignored_type:${String(type).slice(0, 40)}` };
  const campaignId = Number(event?.campaign_id);
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0) return { status: 400, outcome: 'invalid_campaign' };

  const businessId = await goRpc<string | null>('go_smartlead_business_v1', { p_campaign_id: campaignId });
  if (!businessId) return { status: 200, outcome: 'unknown_campaign' };

  const result = await goRpc<{ outcome: string }>('go_smartlead_event_v1', {
    p_business_id: businessId,
    p_campaign_id: campaignId,
    p_event_type: type as HandledEvent,
    p_emails: candidateEmails(event),
    p_event_key: crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex'),
    p_provider_message_id: typeof event?.message_id === 'string' ? event.message_id.slice(0, 300) : null,
    p_occurred_at: occurredAt(event)
  });
  return { status: 200, outcome: result.outcome };
}
