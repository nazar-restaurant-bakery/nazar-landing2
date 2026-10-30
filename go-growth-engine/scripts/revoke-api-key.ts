// Kullanım: npx tsx scripts/revoke-api-key.ts --prefix <ilk 8 karakter>
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { coreDb } from '../src/lib/supabase-client.js';

async function main() {
  const { values } = parseArgs({ options: { prefix: { type: 'string' } } });
  const prefix = values.prefix?.trim();
  if (!prefix) {
    console.error('Kullanım: npx tsx scripts/revoke-api-key.ts --prefix <ilk 8 karakter>');
    process.exitCode = 1;
    return;
  }

  const db = coreDb();
  const { data: keys, error } = await db
    .from('api_keys')
    .select('id, name')
    .eq('key_prefix', prefix)
    .is('revoked_at', null);
  if (error) {
    throw error;
  }
  if (!keys || keys.length === 0) {
    console.error(`❌ Etkin anahtar bulunamadı: ${prefix}`);
    process.exitCode = 1;
    return;
  }
  if (keys.length > 1) {
    console.error(`❌ Bu prefix birden çok etkin anahtarla eşleşiyor (${keys.map((k) => k.name).join(', ')}); işlem yapılmadı.`);
    process.exitCode = 1;
    return;
  }

  const { error: revokeError } = await db
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', keys[0].id)
    .is('revoked_at', null);
  if (revokeError) {
    throw revokeError;
  }
  console.log(`✅ İptal edildi: "${keys[0].name}" (prefix ${prefix})`);
}

main().catch((error) => {
  console.error('❌', error?.message ?? error);
  process.exitCode = 1;
});
