// Kullanım: npx tsx scripts/create-api-key.ts --name "<ad>" --business <uuid> [--business <uuid> ...]
// Anahtar ekrana YALNIZ BİR KEZ yazılır; veritabanında yalnız SHA-256 özeti ve ilk 8 karakteri tutulur.
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { goRpc } from '../src/lib/supabase-client.js';
import { generateApiKey, hashApiKey } from '../src/lib/api-key.js';
import { isUuid } from '../src/lib/validation.js';

async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' },
      business: { type: 'string', multiple: true }
    }
  });

  const name = values.name?.trim();
  const businessIds = [...new Set(values.business ?? [])];
  if (!name || businessIds.length === 0 || !businessIds.every(isUuid)) {
    console.error('Kullanım: npx tsx scripts/create-api-key.ts --name "<ad>" --business <uuid> [--business <uuid> ...]');
    process.exitCode = 1;
    return;
  }

  const key = generateApiKey();
  const prefix = key.slice(0, 8);

  // Anahtar ve işletme bağları tek işlemde yazılır; yarım kalan anahtar oluşmaz
  await goRpc<string>('go_api_key_create_v1', {
    p_name: name, p_key_prefix: prefix, p_key_hash: hashApiKey(key), p_business_ids: businessIds
  });

  console.log(`✅ API anahtarı oluşturuldu: "${name}" (prefix ${prefix}), işletmeler: ${businessIds.join(', ')}`);
  console.log('Anahtar (yalnız bu kez gösterilir, güvenli bir yere kaydedin):');
  console.log(key);
}

main().catch((error) => {
  console.error('❌', error?.message ?? error);
  process.exitCode = 1;
});
