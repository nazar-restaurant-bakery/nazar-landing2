import { coreDb } from './supabase-client.js';

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

export const BUSINESS_SETTINGS_COLUMNS =
  'business_id, outreach_sender_name, outreach_sender_email, outreach_reply_to, outreach_physical_address, ' +
  'outreach_link_base_url, outreach_timezone, outreach_send_days, outreach_send_start, outreach_send_end, ' +
  'outreach_daily_send_limit, enrichment_daily_credit_limit, enrichment_monthly_credit_limit';

export async function getBusinessSettings(businessId: string): Promise<BusinessSettings> {
  const { data, error } = await coreDb()
    .from('business_settings')
    .select(BUSINESS_SETTINGS_COLUMNS)
    .eq('business_id', businessId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    throw new Error(`business_settings kaydı yok: ${businessId}`);
  }
  return data as unknown as BusinessSettings;
}

export async function listBusinessSettings(): Promise<BusinessSettings[]> {
  const { data, error } = await coreDb()
    .from('business_settings')
    .select(BUSINESS_SETTINGS_COLUMNS)
    .order('business_id', { ascending: true });

  if (error) {
    throw error;
  }
  return (data || []) as unknown as BusinessSettings[];
}
