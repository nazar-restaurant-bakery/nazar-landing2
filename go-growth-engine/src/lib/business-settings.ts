import { goRpc } from './supabase-client.js';

export interface BusinessSettings {
  business_id: string;
  outreach_sender_name: string;
  outreach_sender_email: string;
  outreach_reply_to: string;
  outreach_physical_address: string;
  outreach_link_base_url: string;
  outreach_timezone: string;
  outreach_send_days: number[];
  outreach_send_start: string;
  outreach_send_end: string;
  outreach_daily_send_limit: number;
  enrichment_daily_credit_limit: number;
  enrichment_monthly_credit_limit: number;
}

// Platformda core.outreach_settings; fonksiyon alanları GO'nun bu adlarıyla döndürür
export async function getBusinessSettings(businessId: string): Promise<BusinessSettings> {
  const data = await goRpc<BusinessSettings | null>('go_outreach_settings_get_v1', { p_business_id: businessId });
  if (!data) {
    throw new Error(`outreach_settings kaydı yok: ${businessId}`);
  }
  return data;
}

export async function listBusinessSettings(): Promise<BusinessSettings[]> {
  const ids = await goRpc<string[]>('go_outreach_business_ids_v1');
  const settings: BusinessSettings[] = [];
  for (const id of ids) settings.push(await getBusinessSettings(id));
  return settings;
}
