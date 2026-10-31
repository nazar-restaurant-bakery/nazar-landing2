// Kullanım: npx tsx scripts/revoke-api-key.ts --prefix <ilk 8 karakter>
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { goRpc } from '../src/lib/supabase-client.js';

async function main() {
  const { values } = parseArgs({ options: { prefix: { type: 'string' } } });
  const prefix = values.prefix?.trim();
  if (!prefix) {
    console.error('Kullanım: npx tsx scripts/revoke-api-key.ts --prefix <ilk 8 karakter>');
    process.exitCode = 1;
    return;
  }

  // Tek etkin anahtar eşleşirse iptal edilir; hiç ya da birden çok eşleşmede işlem yapılmaz
  const result = await goRpc<{ status: string; name?: string; count?: number }>('go_api_key_revoke_v1', { p_key_prefix: prefix });
  if (result.status === 'not_found') {
    console.error(`❌ Etkin anahtar bulunamadı: ${prefix}`);
    process.exitCode = 1;
    return;
  }
  if (result.status === 'ambiguous') {
    console.error(`❌ Bu prefix birden çok etkin anahtarla eşleşiyor (${result.count}); işlem yapılmadı.`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ İptal edildi: "${result.name}" (prefix ${prefix})`);
}

main().catch((error) => {
  console.error('❌', error?.message ?? error);
  process.exitCode = 1;
});
