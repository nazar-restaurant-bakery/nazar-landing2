// Kullanım:
//   npx tsx scripts/smartlead-setup.ts --business <uuid> --campaigns <adım1>,<adım2>,<adım3> [--commit]
// Smartlead'e YAZMAZ: üç kampanyayı yalnız okur (GET /campaigns/{id}) ve adını/durumunu basar.
// --commit ile kampanya kimliklerini platforma yazar (go_smartlead_campaigns_set_v1):
// adım 1 = gün 1, adım 2 = gün 8, adım 3 = gün 15. Kampanyaların sırası (tek adım,
// {{go_subject}} / {{go_body}}), ayarları, posta kutuları, takvimi ve webhook'u Smartlead
// panelinde girilir (go-growth-engine/PLATFORM_DB.md). Gizli değerler ekrana yazılmaz.
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { goRpc } from '../src/lib/supabase-client.js';
import { smartleadRequest } from '../src/lib/smartlead.js';
import { isUuid } from '../src/lib/validation.js';

const USAGE = 'Kullanım: npx tsx scripts/smartlead-setup.ts --business <uuid> --campaigns <id1>,<id2>,<id3> [--commit]';

export function parseCampaigns(value: string | undefined): number[] | null {
  const ids = (value ?? '').split(',').map((v) => Number(v.trim()));
  return ids.length === 3 && ids.every((id) => Number.isSafeInteger(id) && id > 0) && new Set(ids).size === 3 ? ids : null;
}

async function main() {
  const { values } = parseArgs({ options: {
    business: { type: 'string' }, campaigns: { type: 'string' }, commit: { type: 'boolean', default: false }
  } });
  const businessId = values.business?.trim();
  const campaigns = parseCampaigns(values.campaigns);
  if (!businessId || !isUuid(businessId) || !campaigns) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  for (const [index, campaignId] of campaigns.entries()) {
    const campaign = await smartleadRequest<{ id?: number; name?: string; status?: string }>('GET', `/campaigns/${campaignId}`);
    if (Number(campaign?.id) !== campaignId) throw new Error(`Kampanya ${campaignId} okunamadı`);
    console.log(`Adım ${index + 1} (gün ${[1, 8, 15][index]}) → kampanya ${campaignId}: "${campaign.name ?? ''}" (${campaign.status ?? 'durum yok'})`);
  }
  if (!values.commit) {
    console.log('🔎 DENEME modu: platforma yazılmadı (yazmak için --commit).');
    return;
  }
  await goRpc<boolean>('go_smartlead_campaigns_set_v1', { p_business_id: businessId, p_campaign_ids: campaigns });
  console.log(`✅ Platform: adım kampanyaları ${campaigns.join(', ')} işletme ${businessId} için kaydedildi.`);
}

if (process.argv[1]?.endsWith('smartlead-setup.ts')) {
  main().catch((error) => {
    console.error('❌', error?.message ?? error);
    process.exitCode = 1;
  });
}
