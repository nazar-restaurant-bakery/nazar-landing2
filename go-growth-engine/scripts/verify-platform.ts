// Kullanım: npx tsx scripts/verify-platform.ts --business <uuid>
// SALT OKUNUR: public.go_platform_verify_v1 çağrılır; yazma, gönderim ya da harici çağrı yoktur.
// Platformdaki aday sayılarını (duruma göre), engel kaydı sayısını ve outreach_settings
// satırını yazdırır ve Görev 5 aktarımında beklenen sayılarla karşılaştırır.
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { goRpc } from '../src/lib/supabase-client.js';
import { isUuid } from '../src/lib/validation.js';

// 29 Ekim 2026 aktarımı (tools/go-transfer/02_import_into_platform.sql)
export const EXPECTED = {
  leads_by_status: { new: 38, contacted: 10, on_hold: 36, unsubscribed: 1 } as Record<string, number>,
  leads_total: 85,
  suppressions: 8,
  outreach_settings_rows: 1
};

export interface PlatformCounts {
  business_id: string;
  leads_total: number;
  leads_by_status: Record<string, number>;
  suppressions: number;
  outreach_settings_rows: number;
  outreach_settings: Record<string, unknown> | null;
}

// Farkları döndürür; boş liste = beklenenle aynı
export function compareWithExpected(actual: PlatformCounts): string[] {
  const issues: string[] = [];
  const statuses = new Set([...Object.keys(EXPECTED.leads_by_status), ...Object.keys(actual.leads_by_status)]);
  for (const status of statuses) {
    const want = EXPECTED.leads_by_status[status] ?? 0;
    const got = Number(actual.leads_by_status[status] ?? 0);
    if (want !== got) issues.push(`aday ${status}: beklenen ${want}, bulunan ${got}`);
  }
  if (Number(actual.leads_total) !== EXPECTED.leads_total) issues.push(`aday toplam: beklenen ${EXPECTED.leads_total}, bulunan ${actual.leads_total}`);
  if (Number(actual.suppressions) !== EXPECTED.suppressions) issues.push(`engel kaydı: beklenen ${EXPECTED.suppressions}, bulunan ${actual.suppressions}`);
  if (Number(actual.outreach_settings_rows) !== EXPECTED.outreach_settings_rows || !actual.outreach_settings) {
    issues.push(`outreach_settings satırı: beklenen ${EXPECTED.outreach_settings_rows}, bulunan ${actual.outreach_settings_rows}`);
  }
  return issues;
}

async function main() {
  const { values } = parseArgs({ options: { business: { type: 'string' } } });
  const businessId = values.business?.trim();
  if (!businessId || !isUuid(businessId)) {
    console.error('Kullanım: npx tsx scripts/verify-platform.ts --business <uuid>');
    process.exitCode = 1;
    return;
  }
  const counts = await goRpc<PlatformCounts>('go_platform_verify_v1', { p_business_id: businessId });
  console.log(JSON.stringify(counts, null, 2));
  const issues = compareWithExpected(counts);
  if (issues.length) {
    console.error('❌ Beklenenden farklı:\n- ' + issues.join('\n- '));
    process.exitCode = 1;
    return;
  }
  console.log('✅ Platform verisi beklenenle aynı: 85 aday (38 new, 10 contacted, 36 on_hold, 1 unsubscribed), 8 engel kaydı, 1 outreach_settings satırı.');
}

if (process.argv[1]?.endsWith('verify-platform.ts')) {
  main().catch((error) => {
    console.error('❌', error?.message ?? error);
    process.exitCode = 1;
  });
}
