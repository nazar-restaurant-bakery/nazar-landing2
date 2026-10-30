import { coreDb } from '../../lib/supabase-client.js';
import { getBusinessSettings, BusinessSettings } from '../../lib/business-settings.js';
import { HttpError } from '../../lib/http-error.js';
import { zonedParts, zonedMidnightUtc } from '../../lib/time.js';
import { getConfig } from '../../config.js';

const APOLLO_MATCH_URL = 'https://api.apollo.io/api/v1/people/match';
const CREDIT_TIME_ZONE = 'America/New_York';
const PAGE_SIZE = 1000;

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

    let usedToday = 0;
    let usedMonth = 0;
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await coreDb()
        .from('enrichment_log')
        .select('credits_used, created_at')
        .eq('business_id', businessId)
        .gte('created_at', monthStart.toISOString())
        .gt('credits_used', 0)
        .order('created_at', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) {
        throw error;
      }
      for (const row of data || []) {
        usedMonth += row.credits_used;
        if (new Date(row.created_at) >= dayStart) {
          usedToday += row.credits_used;
        }
      }
      if (!data || data.length < PAGE_SIZE) break;
    }

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

    const batchSize = Math.min(options.limit ?? credits.remaining, credits.remaining);
    let query = coreDb()
      .from('b2b_leads')
      .select('id, email, apollo_person_id, metadata')
      .eq('business_id', businessId)
      .eq('status', 'enrichment_pending')
      .order('created_at', { ascending: true })
      .limit(batchSize);
    if (options.leadIds) {
      query = query.in('id', options.leadIds);
    }
    const { data: leads, error } = await query;
    if (error) {
      throw error;
    }

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
    const { error: logError } = await coreDb().from('enrichment_log').insert([{
      business_id: businessId,
      b2b_lead_id: lead.id,
      apollo_person_id: lead.apollo_person_id ?? (person?.id ? String(person.id) : null),
      credits_used: person ? 1 : 0,
      result
    }]);
    if (logError) {
      throw logError;
    }

    // API hatası geçici olabilir: lead bekletmede kalır, yalnız hata not edilir
    if (result === 'error') {
      const { error: updateError } = await coreDb()
        .from('b2b_leads')
        .update({
          metadata: { ...metadata, last_enrichment_error: { message: errorMessage, at: new Date().toISOString() } },
          updated_at: new Date().toISOString()
        })
        .eq('business_id', businessId)
        .eq('id', lead.id)
        .eq('status', 'enrichment_pending');
      if (updateError) {
        throw updateError;
      }
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

    const { data: duplicate, error: duplicateError } = await coreDb()
      .from('b2b_leads')
      .select('id')
      .eq('business_id', businessId)
      .eq('email', verifiedEmail)
      .neq('id', lead.id)
      .limit(1)
      .maybeSingle();
    if (duplicateError) {
      throw duplicateError;
    }
    if (duplicate) {
      await this.markFailed(businessId, lead.id, { ...metadata, duplicate_of: duplicate.id });
      return { b2b_lead_id: lead.id, result, status: 'enrichment_failed', reason: 'duplicate' };
    }

    const { error: updateError } = await coreDb()
      .from('b2b_leads')
      .update({ email: verifiedEmail, status: 'new', updated_at: new Date().toISOString() })
      .eq('business_id', businessId)
      .eq('id', lead.id)
      .eq('status', 'enrichment_pending');
    if (updateError) {
      throw updateError;
    }
    return { b2b_lead_id: lead.id, result, status: 'new' };
  }

  // E-posta silinmez; yalnız durum ve metadata güncellenir
  private async markFailed(businessId: string, leadId: string, metadata: Record<string, unknown>) {
    const { error } = await coreDb()
      .from('b2b_leads')
      .update({ status: 'enrichment_failed', metadata, updated_at: new Date().toISOString() })
      .eq('business_id', businessId)
      .eq('id', leadId)
      .eq('status', 'enrichment_pending');
    if (error) {
      throw error;
    }
  }
}
