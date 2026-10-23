import { resolveBrowserEnvironment } from '../../src/lib/deploymentEnvironment.ts';

const config = resolveBrowserEnvironment(process.env, 'nazar-catering-sandbox.pages.dev');
if (!config.configured || config.url !== 'https://uxiseddbeszklkrvysxf.supabase.co'
    || config.turnstileSiteKey !== '1x00000000000000000000AA') {
  throw new Error('K16_SANDBOX_BROWSER_CONFIG_INVALID: izole VITE girdilerini kontrol edin.');
}
console.log('K16 SANDBOX STAFF CONFIG: PASSED (yalnız Sandbox; anahtar yazdırılmadı)');
