import { getConfig } from '../config.js';

// Smartlead API: https://server.smartlead.ai/api/v1, anahtar ?api_key= ile.
// Anahtar hiçbir hata mesajına ya da loga yazılmaz.
const SMARTLEAD_BASE = 'https://server.smartlead.ai/api/v1';
const MAX_ATTEMPTS = 3;

export class SmartleadError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function apiKey(): string {
  const key = getConfig('SMARTLEAD_API_KEY');
  if (!key) throw new SmartleadError(503, 'SMARTLEAD_API_KEY boş');
  return key;
}

// 429'da (10 istek / 2 sn) üstel bekleme; diğer hatalar hemen döner
export async function smartleadRequest<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const url = new URL(SMARTLEAD_BASE + path);
  url.searchParams.set('api_key', apiKey());
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method, signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (error: any) {
      throw new SmartleadError(0, `${method} ${path}: ağ hatası (${error?.name ?? 'Error'})`);
    }
    if (response.status === 429 && attempt < MAX_ATTEMPTS) {
      await sleep(2000 * 2 ** (attempt - 1));
      continue;
    }
    const text = await response.text();
    if (!response.ok) {
      throw new SmartleadError(response.status, `${method} ${path}: HTTP ${response.status}`);
    }
    try {
      return (text ? JSON.parse(text) : null) as T;
    } catch {
      throw new SmartleadError(response.status, `${method} ${path}: yanıt JSON değil`);
    }
  }
}

export type CampaignStartResult = 'already_active' | 'started' | `not_started_${string}` | 'error';

// Smartlead adayı olmayan kampanyayı yayına almaz; GO ilk adayı ekledikten sonra taslak
// (DRAFTED) kampanyayı başlatır. PAUSED, STOPPED ve diğer durumlar asla otomatik
// başlatılmaz (Smartlead'in geri dönme koruması durdurmuş olabilir). Asla throw etmez.
export async function ensureCampaignStarted(campaignId: number): Promise<CampaignStartResult> {
  try {
    const campaign = await smartleadRequest<{ status?: unknown } | null>('GET', `/campaigns/${campaignId}`);
    const raw = campaign?.status;
    const status = typeof raw === 'string' && /^[A-Za-z_]{1,32}$/.test(raw) ? raw : 'UNKNOWN';
    if (status === 'ACTIVE') return 'already_active';
    if (status !== 'DRAFTED') {
      console.warn(`⚠️ [Smartlead] Kampanya ${campaignId} otomatik başlatılmadı: durum ${status}`);
      return `not_started_${status}`;
    }
    await smartleadRequest('POST', `/campaigns/${campaignId}/status`, { status: 'START' });
    console.log(`▶️ [Smartlead] Taslak kampanya ${campaignId} başlatıldı`);
    return 'started';
  } catch (error) {
    const detail = error instanceof SmartleadError ? `HTTP ${error.status}` : 'beklenmeyen hata';
    console.warn(`⚠️ [Smartlead] Kampanya ${campaignId} durumu okunamadı ya da başlatılamadı (${detail})`);
    return 'error';
  }
}

export interface SmartleadLead {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  custom_fields: Record<string, string>;
}

export type AddLeadOutcome =
  | { outcome: 'accepted'; smartleadLeadId: number | null }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unknown'; reason: string };

// Tek lead: added_count (yeni API) ya da upload_count (eski API) 1 → kabul; 0 → Smartlead
// eklemedi (engel/çıkış/geri dönme listesi, geçersiz adres, kopya). Tanınmayan yanıt ya da
// ağ/sunucu hatası 'unknown' sayılır: lead kapıda bekletilir, körlemesine tekrar denenmez.
export async function addLeadToCampaign(campaignId: number, lead: SmartleadLead): Promise<AddLeadOutcome> {
  let result: any;
  try {
    result = await smartleadRequest('POST', `/campaigns/${campaignId}/leads`, {
      lead_list: [lead],
      settings: {
        ignore_global_block_list: false,
        ignore_unsubscribe_list: false,
        ignore_community_bounce_list: false,
        // Adım 2 ve 3, aynı adayı önceki adımın kampanyasından sonra ekler
        ignore_duplicate_leads_in_other_campaign: true,
        return_lead_ids: true
      }
    });
  } catch (error: any) {
    if (error instanceof SmartleadError && error.status >= 400 && error.status < 500 && error.status !== 429) {
      return { outcome: 'rejected', reason: `http_${error.status}` };
    }
    return { outcome: 'unknown', reason: error instanceof SmartleadError ? `http_${error.status}` : 'request_failed' };
  }
  const added = Number(result?.added_count ?? result?.upload_count);
  if (added === 1) {
    const id = Array.isArray(result?.lead_ids) ? Number(result.lead_ids[0]) : NaN;
    return { outcome: 'accepted', smartleadLeadId: Number.isSafeInteger(id) ? id : null };
  }
  if (added === 0) return { outcome: 'rejected', reason: 'not_added' };
  return { outcome: 'unknown', reason: 'unrecognized_response' };
}
