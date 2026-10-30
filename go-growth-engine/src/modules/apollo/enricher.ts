import { goRpc } from '../../lib/supabase-client.js';
import { getBusinessSettings, BusinessSettings } from '../../lib/business-settings.js';
import { HttpError } from '../../lib/http-error.js';
import { zonedParts, zonedMidnightUtc } from '../../lib/time.js';
import { getConfig } from '../../config.js';

const APOLLO_MATCH_URL = 'https://api.apollo.io/api/v1/people/match';
const CREDIT_TIME_ZONE = 'America/New_York';
// Veritabanı fonksiyonu tek çağrıda en fazla 1000 lead döndürür
const MAX_BATCH = 1000;

type EnrichResult = 'found' | 'not_found' | 'error';

export interface EnrichLeadDetail {
  b2b_lead_id: string;
  result: EnrichResult | 'skipped';
  status: 'new' | 'enrichment_failed' | 'enrichment_pending';
  reason?: string;
}

export class ApolloEnricher {
  private apiKey: string;

  constructor() {
    this.apiKey = getConfig('APOLLO_API_KEY');
  }

  /**
   * Kalan kredi = min(günlük sınır − bugün, aylık sınır − bu ay); America/New_York'a göre.
   */
  async getRemainingCredits(businessId: string, settings: BusinessSettings) {
    const now = new Date();
    const p = zonedParts(now, CREDIT_TIME_ZONE);
    const dayStart = zonedMidnightUtc(p.year, p.month, p.day, CREDIT_TIME_ZONE);
    const monthStart = zonedMidnightUtc(p.year, p.month, 1, CREDIT_TIME_ZONE);

    // Aynı toplam veritabanında hesaplanır (bu ay ve bugün, America/New_York)
    const used = await goRpc<{ used_today: number; used_month: number }>('go_enrichment_credits_used_v1', {
      p_business_id: businessId, p_day_start: dayStart.toISOString(), p_month_start: monthStart.toISOString()
    });
    const usedToday = Number(used.used_today);
    const usedMonth = Number(used.used_month);

    const remaining = Math.min(
      settings.enrichment_daily_credit_limit - usedToday,
      settings.enrichment_monthly_credit_limit - usedMonth
    );
    return { used_today: usedToday, used_month: usedMonth, remaining };
  }

  async enrichLeads(businessId: string, options: { leadIds?: string[]; limit?: number } = {}) {
    if (!this.apiKey) {
      throw new HttpError(503, 'Zenginleştirme şu an kullanılamıyor', 'APOLLO_API_KEY boş');
    }

    const settings = await getBusinessSettings(businessId);
    const credits = await this.getRemainingCredits(businessId, settings);
    if (credits.remaining <= 0) {
      throw new HttpError(429, 'Zenginleştirme kredi sınırına ulaşıldı', `Kredi sınırı doldu: ${JSON.stringify(credits)}`);
    }

    const batchSize = Math.min(options.limit ?? credits.remaining, credits.remaining, MAX_BATCH);
    const leads = await goRpc<any[]>('go_leads_enrichment_pending_v1', {
      p_business_id: businessId, p_limit: batchSize, p_lead_ids: options.leadIds ?? null
    });

    const details: EnrichLeadDetail[] = [];
    let creditsUsed = 0;
    for (const lead of leads || []) {
      const detail = await this.enrichOne(businessId, lead);
      details.push(detail);
      if (detail.result === 'found') creditsUsed++;
      // API hatası (anahtar, oran sınırı vb.) büyük olasılıkla sonrakileri de etkiler: kalanlara dokunma
      if (detail.result === 'error') {
        console.warn('⚠️ [Enrichment] Apollo hatası sonrası işlem durduruldu; lead\'ler enrichment_pending kaldı.');
        break;
      }
    }

    return {
      credits_before: credits,
      processed: details.length,
      enriched_count: details.filter((d) => d.status === 'new').length,
      failed_count: details.filter((d) => d.status === 'enrichment_failed').length,
      credits_used: creditsUsed,
      details
    };
  }

  private async enrichOne(businessId: string, lead: any): Promise<EnrichLeadDetail> {
    const metadata = lead.metadata || {};
    const matchKey = lead.apollo_person_id ? { id: lead.apollo_person_id } : lead.email ? { email: lead.email } : null;

    if (!matchKey) {
      await this.markFailed(businessId, lead.id, { ...metadata, enrichment_error: 'no_match_key' });
      return { b2b_lead_id: lead.id, result: 'skipped', status: 'enrichment_failed', reason: 'no_match_key' };
    }

    let person: any = null;
    let result: EnrichResult;
    let errorMessage = '';
    try {
      const response = await fetch(APOLLO_MATCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'x-api-key': this.apiKey
        },
        body: JSON.stringify({ ...matchKey, reveal_personal_emails: false })
      });
      if (!response.ok) {
        throw new Error(`Apollo people/match hatası (${response.status}): ${await response.text()}`);
      }
      const data: any = await response.json();
      person = data?.person ?? null;
      result = person ? 'found' : 'not_found';
    } catch (matchError: any) {
      errorMessage = String(matchError?.message ?? matchError);
      console.error(`❌ [Enrichment] lead ${lead.id}:`, errorMessage);
      result = 'error';
    }

    // Kredi muhasebesi lead güncellemesinden önce yazılır
    await goRpc<void>('go_enrichment_log_v1', {
      p_business_id: businessId,
      p_lead_id: lead.id,
      p_apollo_person_id: lead.apollo_person_id ?? (person?.id ? String(person.id) : null),
      p_credits_used: person ? 1 : 0,
      p_result: result
    });

    // API hatası geçici olabilir: lead bekletmede kalır, yalnız hata not edilir
    if (result === 'error') {
      await goRpc<boolean>('go_lead_enrichment_note_v1', {
        p_business_id: businessId, p_lead_id: lead.id,
        p_metadata: { ...metadata, last_enrichment_error: { message: errorMessage, at: new Date().toISOString() } }
      });
      return { b2b_lead_id: lead.id, result, status: 'enrichment_pending', reason: 'api_error' };
    }

    const verifiedEmail = person?.email && person.email_status === 'verified'
      ? String(person.email).trim().toLowerCase()
      : null;

    if (!verifiedEmail) {
      const reason = result === 'found' ? 'no_verified_email' : 'not_found';
      await this.markFailed(businessId, lead.id, { ...metadata, enrichment_error: reason });
      return { b2b_lead_id: lead.id, result, status: 'enrichment_failed', reason };
    }

    // Aynı işletmede bu e-posta başka lead'deyse: enrichment_failed + duplicate_of (tek işlemde)
    const outcome = await goRpc<{ status: string; duplicate_of?: string }>('go_lead_enrichment_found_v1', {
      p_business_id: businessId, p_lead_id: lead.id, p_email: verifiedEmail, p_metadata: metadata
    });
    if (outcome.status === 'enrichment_failed') {
      return { b2b_lead_id: lead.id, result, status: 'enrichment_failed', reason: 'duplicate' };
    }
    return { b2b_lead_id: lead.id, result, status: 'new' };
  }

  // E-posta silinmez; yalnız durum ve metadata güncellenir
  private async markFailed(businessId: string, leadId: string, metadata: Record<string, unknown>) {
    await goRpc<boolean>('go_lead_enrichment_fail_v1', { p_business_id: businessId, p_lead_id: leadId, p_metadata: metadata });
  }
}
