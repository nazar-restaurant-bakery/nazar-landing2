// Kullanım: npx tsx scripts/create-api-key.ts --name "<ad>" --business <uuid> [--business <uuid> ...]
// Anahtar ekrana YALNIZ BİR KEZ yazılır; veritabanında yalnız SHA-256 özeti ve ilk 8 karakteri tutulur.
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { coreDb } from '../src/lib/supabase-client.js';
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
  const db = coreDb();

  const { data: created, error: keyError } = await db
    .from('api_keys')
    .insert([{ name, key_prefix: key.slice(0, 8), key_hash: hashApiKey(key) }])
    .select('id, key_prefix')
    .single();
  if (keyError) {
    throw keyError;
  }

  const { error: linkError } = await db
    .from('api_key_businesses')
    .insert(businessIds.map((business_id) => ({ api_key_id: created.id, business_id })));
  if (linkError) {
    // Yarım kalan anahtar bırakılmaz (bağlar CASCADE ile silinir)
    await db.from('api_keys').delete().eq('id', created.id);
    throw linkError;
  }

  console.log(`✅ API anahtarı oluşturuldu: "${name}" (prefix ${created.key_prefix}), işletmeler: ${businessIds.join(', ')}`);
  console.log('Anahtar (yalnız bu kez gösterilir, güvenli bir yere kaydedin):');
  console.log(key);
}

main().catch((error) => {
  console.error('❌', error?.message ?? error);
  process.exitCode = 1;
});
