import crypto from 'crypto';
import { goRpc } from '../../lib/supabase-client.js';
import { getBusinessSettings, BusinessSettings } from '../../lib/business-settings.js';
import { addLeadToCampaign, ensureCampaignStarted } from '../../lib/smartlead.js';
import { assertUnsubscribeConfig, buildUnsubscribeUrl } from './unsubscribe.js';

// Gönderim (Görev 6/7): her e-posta platformdaki tek 168 saat kapısından geçer
// (public.go_dispatch_reserve_v1) ve Smartlead'e verilir. Dizinin her adımı ayrı, tek
// adımlı bir Smartlead kampanyasıdır (gün 1, 8, 15). Kayıt Smartlead EMAIL_SENT
// olayıyla 'sent' olur; sonraki adım 7 gün sonra yine kapıdan geçer.

export interface OutreachStep {
  step: number;
  day: number;
  subject: string;
  body_template: string;
}

export interface SendStepResult {
  b2b_lead_id: string;
  // true: Smartlead adayı kabul etti; e-posta Smartlead'in gönderim penceresinde çıkar
  queued: boolean;
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

export interface DueLead {
  id: string;
  step: number;
  email: string;
  contact_name: string | null;
  company_name: string | null;
}

// Günlük sınırdan kalan gönderim hakkı (kapı ve zamanlayıcı aynı sayacı kullanır)
export async function getDailySendQuota(businessId: string): Promise<{ daily_limit: number; sent_today: number; remaining: number }> {
  return goRpc('go_dispatch_quota_v1', { p_business_id: businessId });
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// Adımın konu ve gövdesi GO'da hazırlanır; Smartlead kampanyasında yalnız
// {{go_subject}} ve {{go_body}} alanları vardır. Gövde sonunda fiziksel adres ve
// GO'nun abonelikten çıkma bağlantısı bulunur.
export function buildStepMessage(settings: BusinessSettings, businessId: string, lead: DueLead) {
  const step = OUTREACH_STEPS[lead.step - 1];
  if (!step) throw new Error(`Geçersiz adım: ${lead.step}`);
  const subject = renderOutreachText(step.subject, lead);
  const unsubscribeUrl = buildUnsubscribeUrl(settings.outreach_link_base_url, businessId, lead.email);
  const text = renderOutreachText(step.body_template, lead)
    + `\n\n${settings.outreach_physical_address}\nUnsubscribe: ${unsubscribeUrl}`;
  const html = text.split('\n').map((line) => escapeHtml(line)).join('<br>');
  const payloadSha256 = crypto.createHash('sha256').update(JSON.stringify({ step: lead.step, subject, text }), 'utf8').digest('hex');
  return { subject, text, html, payloadSha256 };
}

type Reservation = { allowed: boolean; code: string; message_id?: string; lease_id?: string; campaign_id?: number };

export class OutreachSequencer {
  /**
   * Tek aday: sıradaki adım kapıdan geçer ve Smartlead kampanyasına eklenir.
   * stopRun: Smartlead yapılandırma hatası (401/403/404); aynı turda başka aday denenmez.
   * startChecked: bu çalışmada başlatma kontrolü yapılmış kampanyalar (kampanya başına bir kez).
   */
  async dispatch(businessId: string, settings: BusinessSettings, lead: DueLead,
    startChecked: Set<number> = new Set()): Promise<SendStepResult & { stopRun?: boolean }> {
    const message = buildStepMessage(settings, businessId, lead);
    const gate = await goRpc<Reservation>('go_dispatch_reserve_v1', {
      p_business_id: businessId, p_lead_id: lead.id, p_step: lead.step, p_payload_sha256: message.payloadSha256
    });
    if (!gate.allowed || !gate.message_id || !gate.lease_id || !gate.campaign_id) {
      return { b2b_lead_id: lead.id, queued: false, step: lead.step, reason: gate.code };
    }

    const nameParts = (lead.contact_name ?? '').trim().split(/\s+/).filter(Boolean);
    const added = await addLeadToCampaign(gate.campaign_id, {
      email: lead.email,
      ...(nameParts[0] ? { first_name: nameParts[0] } : {}),
      ...(nameParts.length > 1 ? { last_name: nameParts.slice(1).join(' ') } : {}),
      ...(lead.company_name ? { company_name: lead.company_name } : {}),
      custom_fields: { go_subject: message.subject, go_body: message.html, go_message_id: gate.message_id }
    });
    await goRpc('go_dispatch_result_v1', {
      p_business_id: businessId, p_message_id: gate.message_id, p_lease_id: gate.lease_id, p_outcome: added.outcome,
      p_smartlead_lead_id: added.outcome === 'accepted' ? added.smartleadLeadId : null
    });
    if (added.outcome === 'accepted') {
      console.log(`✅ [Outreach] Adım ${lead.step} Smartlead'e verildi: lead ${lead.id}`);
      // Taslak kampanya ilk adayla başlar; sonuç yalnız loglanır, gönderim sonucunu değiştirmez.
      if (!startChecked.has(gate.campaign_id)) {
        startChecked.add(gate.campaign_id);
        const start = await ensureCampaignStarted(gate.campaign_id);
        console.log(`[Outreach] Kampanya ${gate.campaign_id} başlatma kontrolü: ${start}`);
      }
      return { b2b_lead_id: lead.id, queued: true, step: lead.step, reason: 'queued' };
    }
    console.warn(`🛑 [Outreach] Smartlead kabul etmedi: lead ${lead.id}, ${added.outcome} (${added.reason})`);
    return {
      b2b_lead_id: lead.id, queued: false, step: lead.step, reason: `smartlead_${added.outcome}`,
      stopRun: added.outcome === 'rejected' && /^http_(401|403|404)$/.test(added.reason)
    };
  }

  // Tekil tetikleme: aday zamanı gelmişse sıradaki adım (kapı yine tüm kuralları uygular)
  async sendNextStep(businessId: string, leadId: string): Promise<SendStepResult> {
    if (!businessId || !leadId) {
      throw new Error('business_id ve b2b_lead_id zorunlu');
    }
    assertUnsubscribeConfig();
    const settings = await getBusinessSettings(businessId);
    const due = await goRpc<DueLead[]>('go_dispatch_due_v1', { p_business_id: businessId, p_limit: 1, p_lead_id: leadId });
    if (due.length === 0) {
      return { b2b_lead_id: leadId, queued: false, step: null, reason: 'not_due_or_ineligible' };
    }
    const { stopRun: _stop, ...result } = await this.dispatch(businessId, settings, due[0]);
    return result;
  }

  // Zamanı gelen adaylar: en fazla min(limit, günlük sınırdan kalan)
  async runDue(businessId: string, limit: number) {
    assertUnsubscribeConfig();
    const settings = await getBusinessSettings(businessId);
    const { remaining } = await getDailySendQuota(businessId);
    if (remaining <= 0) {
      return { selected: 0, queued_count: 0, not_queued_count: 0, reasons: { daily_limit_reached: 1 }, details: [] as SendStepResult[] };
    }
    const due = await goRpc<DueLead[]>('go_dispatch_due_v1', { p_business_id: businessId, p_limit: Math.min(limit, remaining, 100) });

    const details: SendStepResult[] = [];
    const startChecked = new Set<number>();
    for (const lead of due) {
      try {
        const { stopRun, ...result } = await this.dispatch(businessId, settings, lead, startChecked);
        details.push(result);
        if (stopRun) break;
      } catch (stepError: any) {
        console.error(`❌ [Outreach run-due] lead ${lead.id}:`, stepError?.message ?? stepError);
        details.push({ b2b_lead_id: lead.id, queued: false, step: lead.step, reason: 'error' });
        break;
      }
    }

    const reasons: Record<string, number> = {};
    for (const detail of details) {
      reasons[detail.reason] = (reasons[detail.reason] || 0) + 1;
    }
    return {
      selected: details.length,
      queued_count: reasons.queued || 0,
      not_queued_count: details.length - (reasons.queued || 0),
      reasons,
      details
    };
  }
}
