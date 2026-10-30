import { getBusinessSettings, BusinessSettings } from '../../lib/business-settings.js';
import { sendEmail } from '../../lib/mailer.js';
import { HttpError } from '../../lib/http-error.js';
import { isEmailSuppressed } from './unsubscribe.js';

// Gönderim kapısı (168 saat, check_and_reserve_dispatch_gate_v2) ve gönderim kaydı
// (message_log) platforma Görev 6/7 ile taşınır. Platform message_log'u GO'nun
// kullandığı sütunları içermez; o zamana kadar sıra gönderimi veritabanına dokunmadan
// kapalı döner. Test e-postası (sendTestEmail) ayar ve engel listesi fonksiyonlarıyla çalışır.
export const DISPATCH_NOT_MIGRATED = 'dispatch_not_migrated';

export interface OutreachStep {
  step: number;
  day: number;
  subject: string;
  body_template: string;
}

export interface SendStepResult {
  b2b_lead_id: string;
  sent: boolean;
  step: number | null;
  reason: string;
}

export const OUTREACH_STEPS: OutreachStep[] = [
  {
    step: 1,
    day: 1,
    subject: 'Lunch for the {{company_name}} team',
    body_template: [
      'Hi {{contact_name}},',
      '',
      "I'm reaching out from Nazar Restaurant & Bakery in West Haven. We make fresh Turkish and Mediterranean food that works well for office lunches: wraps and sandwiches, brick-oven pide and lahmacun, salads and mezze.",
      '',
      'For everyday team lunches, you can order online for pickup or delivery:',
      'https://www.nazarrestaurantandbakery.com',
      '',
      'For meetings and company events, our catering packages serve 10 to 50 guests:',
      'https://www.nazarrestaurantandbakery.com/catering',
      '',
      "For a large order, give us a call at (203) 408-2697 and we'll work out the details.",
      '',
      'Best regards,',
      'Nazar Restaurant & Bakery'
    ].join('\n')
  },
  {
    step: 2,
    day: 8,
    subject: 'Catering for groups from 10 to 50',
    body_template: [
      'Hi {{contact_name}},',
      '',
      'Following up on my note last week. Our catering comes in packages for 10, 20, 30 or 50 guests, so it works for a small team lunch as well as a company event.',
      '',
      'The menu includes Adana and chicken shish, grilled meatballs and gyro served with rice pilav, along with salads, falafel and appetizer platters.',
      'https://www.nazarrestaurantandbakery.com/catering',
      '',
      "Just reply with your date and headcount and we'll put your order together.",
      '',
      'Best,',
      'Nazar Restaurant & Bakery'
    ].join('\n')
  },
  {
    step: 3,
    day: 15,
    subject: '15% off your first catering order',
    body_template: [
      'Hi {{contact_name}},',
      '',
      "One last note from us: {{company_name}}'s first catering order with Nazar comes with 15% off. Just mention this email when you reply here or call us at (203) 408-2697.",
      '',
      'Our catering menu: https://www.nazarrestaurantandbakery.com/catering',
      '',
      'Thanks,',
      'Nazar Restaurant & Bakery'
    ].join('\n')
  }
];

/**
 * Konu ve gövdedeki yer tutucuları doldurur.
 * {{contact_name}} → ilk kelime, boşsa "there". {{company_name}} → şirket adı, boşsa
 * doğal İngilizce karşılık: "the X team" → "your team", "X's" → "your team's", "X" → "your team".
 */
export function renderOutreachText(template: string, lead: { contact_name?: string | null; company_name?: string | null }): string {
  const firstName = (lead.contact_name ?? '').trim().split(/\s+/)[0] || 'there';
  const company = (lead.company_name ?? '').trim();

  let text = template.replaceAll('{{contact_name}}', firstName);
  if (company) {
    return text.replaceAll('{{company_name}}', company);
  }
  text = text.replaceAll('the {{company_name}} team', 'your team');
  text = text.replaceAll("{{company_name}}'s", "your team's");
  return text.replaceAll('{{company_name}}', 'your team');
}

// Günlük sınırdan kalan gönderim hakkı. Sayaç gönderim kaydına (message_log) dayanır;
// kayıt platforma taşınana kadar (Görev 6/7) kota okunamaz, hata ile durur.
export async function getDailySendQuota(_businessId: string, _settings: BusinessSettings, _now: Date):
  Promise<{ daily_limit: number; sent_today: number; remaining: number }> {
  throw new HttpError(503, 'Gönderim şu an kullanılamıyor', DISPATCH_NOT_MIGRATED);
}

export class OutreachSequencer {
  /**
   * Lead'in sıradaki adımı. Gönderim kapısı ve gönderim kaydı platforma taşınana kadar
   * (Görev 6/7) hiçbir rezervasyon ya da gönderim yapılmaz; veritabanına dokunulmaz.
   */
  async sendNextStep(businessId: string, leadId: string): Promise<SendStepResult> {
    if (!businessId || !leadId) {
      throw new Error('business_id ve b2b_lead_id zorunlu');
    }
    console.warn(`🛑 [Outreach] Gönderilmedi: lead ${leadId}, neden: ${DISPATCH_NOT_MIGRATED}`);
    return { b2b_lead_id: leadId, sent: false, step: null, reason: DISPATCH_NOT_MIGRATED };
  }

  /**
   * Gönderim ayarlarını sınamak için test e-postası. Lead'e bağlı değil (gate çağrılamaz);
   * suppression listesindeki adrese gönderilmez.
   */
  async sendTestEmail(businessId: string, to: string) {
    const settings = await getBusinessSettings(businessId);
    if (await isEmailSuppressed(businessId, to)) {
      return { sent: false, reason: 'suppressed' };
    }

    const { id } = await sendEmail({
      from: { name: settings.outreach_sender_name, address: settings.outreach_sender_email },
      replyTo: settings.outreach_reply_to,
      to,
      subject: 'GO Growth Engine – test e-postası',
      text: 'Bu bir test e-postasıdır. Gönderim ayarları çalışıyor.'
    });
    return { sent: true, reason: 'sent', provider_message_id: id };
  }

  /**
   * Zamanı gelen adımlar. Gönderim kaydı platforma taşınana kadar (Görev 6/7) lead seçilmez.
   */
  async runDue(_businessId: string, _limit: number) {
    return { selected: 0, sent_count: 0, not_sent_count: 0, reasons: { [DISPATCH_NOT_MIGRATED]: 1 }, details: [] as SendStepResult[] };
  }
}
