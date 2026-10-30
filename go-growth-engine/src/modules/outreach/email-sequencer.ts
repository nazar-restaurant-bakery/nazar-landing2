import { coreDb } from '../../lib/supabase-client.js';
import { getBusinessSettings, BusinessSettings } from '../../lib/business-settings.js';
import { sendEmail } from '../../lib/mailer.js';
import { startOfLocalDay } from '../../lib/time.js';
import { assertUnsubscribeConfig, buildUnsubscribeUrl, isEmailSuppressed } from './unsubscribe.js';

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

const STEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

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

/**
 * İşletmenin yerel takvim gününde ayrılan/gönderilen e-posta sayısı ('failed' sayılmaz).
 */
export async function countSentToday(businessId: string, settings: BusinessSettings, now: Date): Promise<number> {
  const { count, error } = await coreDb()
    .from('message_log')
    .select('id', { head: true, count: 'exact' })
    .eq('business_id', businessId)
    .in('status', ['reserved', 'sent'])
    .gte('created_at', startOfLocalDay(now, settings.outreach_timezone).toISOString());
  if (error) {
    throw error;
  }
  return count ?? 0;
}

// Günlük sınırdan kalan gönderim hakkı (scheduler ve runDue aynı sayacı kullanır)
export async function getDailySendQuota(businessId: string, settings: BusinessSettings, now: Date) {
  const sentToday = await countSentToday(businessId, settings, now);
  const limit = settings.outreach_daily_send_limit;
  return { daily_limit: limit, sent_today: sentToday, remaining: Math.max(0, limit - sentToday) };
}

export class OutreachSequencer {
  private sequenceSteps: OutreachStep[] = OUTREACH_STEPS;

  /**
   * Lead'in sıradaki adımını gönderir. Gönderimden önce her zaman gate v2 çağrılır.
   */
  async sendNextStep(businessId: string, leadId: string): Promise<SendStepResult> {
    if (!businessId || !leadId) {
      throw new Error('business_id ve b2b_lead_id zorunlu');
    }
    assertUnsubscribeConfig();

    const db = coreDb();
    const settings = await getBusinessSettings(businessId);

    const { data: lead, error: leadError } = await db
      .from('b2b_leads')
      .select('id, email, contact_name, company_name, status, sequence_step, next_step_at')
      .eq('business_id', businessId)
      .eq('id', leadId)
      .maybeSingle();
    if (leadError) {
      throw leadError;
    }
    if (!lead) {
      return { b2b_lead_id: leadId, sent: false, step: null, reason: 'lead_not_found' };
    }

    const stepNo = lead.sequence_step + 1;
    const step = this.sequenceSteps[stepNo - 1];
    if (!step) {
      return { b2b_lead_id: leadId, sent: false, step: null, reason: 'sequence_complete' };
    }
    if (lead.status === 'contacted' && (!lead.next_step_at || new Date(lead.next_step_at) > new Date())) {
      return { b2b_lead_id: leadId, sent: false, step: stepNo, reason: 'not_due' };
    }

    // Günlük sınır doluysa rezervasyon yapılmaz (elle tetiklenen uç noktalar dahil)
    if (await countSentToday(businessId, settings, new Date()) >= settings.outreach_daily_send_limit) {
      return { b2b_lead_id: leadId, sent: false, step: stepNo, reason: 'daily_limit_reached' };
    }

    const subject = renderOutreachText(step.subject, lead);
    const payload = { step: stepNo, subject };
    const { data: gateRows, error: gateError } = await db.rpc('check_and_reserve_dispatch_gate_v2', {
      p_business_id: businessId,
      p_b2b_lead_id: leadId,
      p_campaign_type: 'b2b_outreach',
      p_payload: payload
    });
    if (gateError) {
      throw gateError;
    }
    const gate = gateRows?.[0];
    if (!gate) {
      throw new Error('Gönderim kapısı sonuç döndürmedi');
    }
    if (!gate.allowed) {
      // Kapı e-postasız lead için 'status_<durum>' döner; nedeni açık yaz
      const reason = !lead.email && String(gate.reason).startsWith('status_') ? 'missing_email' : gate.reason;
      console.warn(`🛑 [Outreach] Gönderilmedi: lead ${leadId}, neden: ${reason}`);
      return { b2b_lead_id: leadId, sent: false, step: stepNo, reason };
    }

    const unsubscribeUrl = buildUnsubscribeUrl(settings.outreach_link_base_url, businessId, lead.email);
    const text = renderOutreachText(step.body_template, lead)
      + `\n\n${settings.outreach_physical_address}\nUnsubscribe: ${unsubscribeUrl}`;

    let providerMessageId: string | null;
    try {
      ({ id: providerMessageId } = await sendEmail({
        from: { name: settings.outreach_sender_name, address: settings.outreach_sender_email },
        replyTo: settings.outreach_reply_to,
        to: lead.email,
        subject,
        text,
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        },
        idempotencyKey: gate.reservation_id
      }));
    } catch (sendError: any) {
      console.error(`❌ [Outreach] Gönderim hatası (lead ${leadId}):`, sendError?.message ?? sendError);
      const { error: failLogError } = await db
        .from('message_log')
        .update({ status: 'failed', payload: { ...payload, error: String(sendError?.message ?? sendError) } })
        .eq('id', gate.reservation_id);
      if (failLogError) {
        throw failLogError;
      }
      return { b2b_lead_id: leadId, sent: false, step: stepNo, reason: 'send_failed' };
    }

    const now = new Date();
    const { error: sentLogError } = await db
      .from('message_log')
      .update({ status: 'sent', sent_at: now.toISOString(), provider_message_id: providerMessageId })
      .eq('id', gate.reservation_id);
    if (sentLogError) {
      throw sentLogError;
    }

    // Gönderim sırasında durum değiştiyse (ör. 'unsubscribed') geri çekme
    const { error: leadUpdateError } = await db
      .from('b2b_leads')
      .update({
        status: 'contacted',
        sequence_step: stepNo,
        next_step_at: stepNo < this.sequenceSteps.length ? new Date(now.getTime() + STEP_INTERVAL_MS).toISOString() : null,
        updated_at: now.toISOString()
      })
      .eq('business_id', businessId)
      .eq('id', leadId)
      .in('status', ['new', 'contacted']);
    if (leadUpdateError) {
      throw leadUpdateError;
    }

    console.log(`✅ [Outreach] Adım ${stepNo} gönderildi: lead ${leadId}`);
    return { b2b_lead_id: leadId, sent: true, step: stepNo, reason: 'sent' };
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
   * Zamanı gelen lead'leri seçer: 'new' + adım 0 ve 'contacted' + next_step_at geçmiş.
   * En fazla min(limit, günlük sınırdan kalan) lead seçilir.
   */
  async runDue(businessId: string, limit: number) {
    assertUnsubscribeConfig();
    const settings = await getBusinessSettings(businessId);

    const now = new Date();
    const { remaining } = await getDailySendQuota(businessId, settings, now);
    if (remaining <= 0) {
      return { selected: 0, sent_count: 0, not_sent_count: 0, reasons: { daily_limit_reached: 1 }, details: [] };
    }

    const nowIso = now.toISOString();
    const { data: dueLeads, error } = await coreDb()
      .from('b2b_leads')
      .select('id')
      .eq('business_id', businessId)
      .not('email', 'is', null)
      .or(`and(status.eq.new,sequence_step.eq.0),and(status.eq.contacted,sequence_step.lt.${this.sequenceSteps.length},next_step_at.lte.${nowIso})`)
      .order('next_step_at', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: true })
      .limit(Math.min(limit, remaining));
    if (error) {
      throw error;
    }

    const details: SendStepResult[] = [];
    for (const lead of dueLeads || []) {
      try {
        details.push(await this.sendNextStep(businessId, lead.id));
      } catch (stepError: any) {
        console.error(`❌ [Outreach run-due] lead ${lead.id}:`, stepError?.message ?? stepError);
        details.push({ b2b_lead_id: lead.id, sent: false, step: null, reason: 'error' });
      }
    }

    const reasons: Record<string, number> = {};
    for (const detail of details) {
      reasons[detail.reason] = (reasons[detail.reason] || 0) + 1;
    }

    return {
      selected: details.length,
      sent_count: reasons.sent || 0,
      not_sent_count: details.length - (reasons.sent || 0),
      reasons,
      details
    };
  }
}
