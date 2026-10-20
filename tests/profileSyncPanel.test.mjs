import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The actual React panel runs only on localhost with a synthetic injected fetcher.
// No Supabase client, production app, analytics or provider is imported.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(repo, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
let playwright;
let toolingReason;
try { playwright = await import('playwright'); }
catch {
  const bundled = path.resolve(path.dirname(process.execPath), '..', 'node_modules/playwright/index.mjs');
  try { playwright = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || bundled).href); }
  catch { toolingReason = 'Optional browser tests need an installed Playwright runtime; no browser or dependency is downloaded.'; }
}
const chromium = playwright?.chromium;
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, chromium?.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .filter(Boolean).find(existsSync);
if (!executablePath) toolingReason = 'Optional browser tests need an existing local browser; none is downloaded.';

const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ProfileSyncPanel from '/src/components/staff/ProfileSyncPanel.tsx';
const mode = new URLSearchParams(location.search).get('mode') || 'live';
const h = window.__profileSyncTest = {
  calls: [], mode, token: 'synthetic-session-one', holdCheck: false, pendingChecks: [],
  checkStatus: 200, checkData: { code:'connection_verified', readOnly:true,
    checkedAt:'2026-10-20T06:00:00.123Z', providerHttpStatus:200 },
};
const fetcher = async (input, options) => {
  const action = options.body ? JSON.parse(options.body).action : null;
  h.calls.push({ input, method: options.method, action, authorization: options.headers.Authorization });
  if (options.method === 'GET') return new Response(JSON.stringify({code:'ok',mode:h.mode,jobs:[],
    counts:{queued:0,running:0,retry:0,failed:0,blocked:0,succeeded:0}}));
  if (action === 'run') return new Response(JSON.stringify({code:'ok',mode:h.mode,
    processed:0,succeeded:0,blocked:0,retry:0,failed:0}));
  if (action !== 'check') throw new Error('Unexpected synthetic action');
  const body = JSON.stringify(h.checkData), status = h.checkStatus;
  if (h.holdCheck) return new Promise(resolve => h.pendingChecks.push(() => resolve(new Response(body,{status}))));
  return new Response(body,{status});
};
const root = createRoot(document.getElementById('root'));
const render = () => root.render(React.createElement(React.StrictMode,null,
  React.createElement(ProfileSyncPanel,{accessToken:h.token,fetcher})));
h.setToken = token => {h.token=token;render();};
h.unmount = () => root.render(null);
h.remount = () => render();
h.release = () => {const next=h.pendingChecks.shift();if(next)next();};
render();
`;

test('actual React panel keeps manual read-only checks isolated and discards stale responses', { skip: toolingReason || false }, async t => {
  const virtual = '\0virtual:profile-sync-panel-test';
  const server = await createServer({ configFile: false, root: repo, envDir: false,
    plugins: [{ name: 'profile-sync-panel-fixture',
      resolveId(id) { if (id === 'virtual:profile-sync-panel-test') return virtual; },
      load(id) { if (id === virtual) return entry; },
      configureServer(vite) { vite.middlewares.use((req, res, next) => {
        if (req.url === '/' || req.url?.startsWith('/?')) {
          res.setHeader('Content-Type', 'text/html');
          res.end('<div id="root"></div><script type="module" src="/@id/virtual:profile-sync-panel-test"></script>');
        } else next();
      }); },
    }], server: { host: '127.0.0.1', port: 0, hmr: false },
  });
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true,
      args: ['--disable-background-networking', '--disable-component-update', '--no-default-browser-check', '--disable-sync'] });
    const page = await browser.newPage();
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const button = name => page.getByRole('button', { name, exact: true });
    const calls = () => page.evaluate(() => window.__profileSyncTest.calls);
    const open = async (query = '') => {
      await page.goto(base + '/' + query);
      await page.getByText('Henüz senkron kaydı yok.', { exact: true }).waitFor();
    };
    const success = () => page.getByText('Klaviyo bağlantısı doğrulandı (HTTP 200). Profil veya e-posta oluşturulmadı.', { exact: false });

    await t.test('mount/refresh never auto-check and live mode alone enables the check', async () => {
      await open();
      assert.equal(await button('Bağlantıyı doğrula').isEnabled(), true);
      assert.equal((await calls()).filter(c => c.method === 'POST').length, 0);
      await button('Yenile').click();
      await page.getByText('Henüz senkron kaydı yok.', { exact: true }).waitFor();
      assert.equal((await calls()).filter(c => c.method === 'POST').length, 0);
      await page.getByText('Bağlantıyı doğrula yalnız bağlantıyı kontrol eder; profil veya e-posta oluşturmaz.', { exact: true }).waitFor();
    });

    await t.test('mock and disabled modes cannot invoke the connection check', async () => {
      await open('?mode=mock');
      assert.equal(await button('Bağlantıyı doğrula').isDisabled(), true);
      await page.goto(base + '/?mode=disabled');
      await page.getByText('Bağlantı bekliyor. Profil senkronu etkin değil.', { exact: true }).waitFor();
      assert.equal(await button('Bağlantıyı doğrula').isDisabled(), true);
      assert.equal((await calls()).filter(c => c.method === 'POST').length, 0);
    });

    await t.test('one click dispatches check only; synchronous double-click and other commands are blocked', async () => {
      await open();
      await page.evaluate(() => {
        window.__profileSyncTest.holdCheck = true;
        const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'Bağlantıyı doğrula');
        button.click(); button.click();
      });
      await button('Bağlantı kontrol ediliyor…').waitFor();
      assert.equal(await button('Bağlantı kontrol ediliyor…').isDisabled(), true);
      assert.equal(await button('Şimdi senkronla').isDisabled(), true);
      assert.equal(await button('Yenile').isDisabled(), true);
      const posts = (await calls()).filter(c => c.method === 'POST');
      assert.deepEqual(posts.map(c => c.action), ['check']);
      await page.evaluate(() => window.__profileSyncTest.release());
      await success().waitFor();
      assert.equal(await button('Şimdi senkronla').isEnabled(), true);
      assert.equal((await calls()).filter(c => c.method === 'GET').length, 1);
      await page.getByText(/Kontrol:.*20.*2026/).waitFor();
    });

    await t.test('malformed success and unknown provider text produce only safe copy without retry', async () => {
      await open();
      await page.evaluate(() => {
        const h = window.__profileSyncTest;
        h.checkData = { code:'connection_verified',readOnly:false,checkedAt:'bad time',providerHttpStatus:200,
          detail:'SYNTHETIC_PRIVATE_PROVIDER_DETAIL' };
      });
      await button('Bağlantıyı doğrula').click();
      await page.getByRole('alert').waitFor();
      assert.equal(await success().count(), 0);
      assert.equal((await page.locator('body').innerText()).includes('SYNTHETIC_PRIVATE_PROVIDER_DETAIL'), false);
      assert.equal((await calls()).filter(c => c.action === 'check').length, 1);
    });

    await t.test('rate limit has safe fixed text and does not automatically repeat', async () => {
      await open();
      await page.evaluate(() => {
        const h = window.__profileSyncTest;
        h.checkStatus = 429; h.checkData = {code:'connection_rate_limited',detail:'SYNTHETIC_PRIVATE_DETAIL'};
      });
      await button('Bağlantıyı doğrula').click();
      await page.getByText(/Klaviyo istek sınırına ulaşıldı/).waitFor();
      assert.equal((await calls()).filter(c => c.action === 'check').length, 1);
      assert.equal((await page.locator('body').innerText()).includes('SYNTHETIC_PRIVATE_DETAIL'), false);
    });

    await t.test('session change rejects the old result without releasing a new pending check', async () => {
      await open();
      await page.evaluate(() => {window.__profileSyncTest.holdCheck = true;});
      await button('Bağlantıyı doğrula').click();
      await button('Bağlantı kontrol ediliyor…').waitFor();
      await page.evaluate(() => window.__profileSyncTest.setToken('synthetic-session-two'));
      await button('Bağlantıyı doğrula').waitFor();
      await button('Bağlantıyı doğrula').click();
      await page.waitForFunction(() => window.__profileSyncTest.pendingChecks.length === 2);
      await page.evaluate(() => window.__profileSyncTest.release());
      await page.waitForTimeout(30);
      assert.equal(await success().count(), 0);
      assert.equal(await button('Bağlantı kontrol ediliyor…').isDisabled(), true);
      await page.evaluate(() => window.__profileSyncTest.release());
      await success().waitFor();
      assert.deepEqual((await calls()).filter(c => c.action === 'check').map(c => c.authorization),
        ['Bearer synthetic-session-one', 'Bearer synthetic-session-two']);
    });

    await t.test('unmount/remount discards a previous pending response', async () => {
      await open();
      await page.evaluate(() => {window.__profileSyncTest.holdCheck = true;});
      await button('Bağlantıyı doğrula').click();
      await button('Bağlantı kontrol ediliyor…').waitFor();
      await page.evaluate(() => window.__profileSyncTest.unmount());
      await page.getByRole('heading', { name:'Profil senkronu', exact:true }).waitFor({state:'detached'});
      await page.evaluate(() => window.__profileSyncTest.remount());
      await page.getByText('Henüz senkron kaydı yok.', { exact:true }).waitFor();
      await page.evaluate(() => window.__profileSyncTest.release());
      await page.waitForTimeout(30);
      assert.equal(await success().count(), 0);
      assert.equal(await button('Bağlantıyı doğrula').isEnabled(), true);
    });

    await t.test('normal sync remains a run action and refreshes its queue', async () => {
      await open();
      await button('Şimdi senkronla').click();
      await page.getByText(/Son işlem: 0 işlendi/).waitFor();
      assert.deepEqual((await calls()).filter(c => c.method === 'POST').map(c => c.action), ['run']);
      assert.equal((await calls()).filter(c => c.method === 'GET').length, 2);
      assert.equal(await success().count(), 0);
    });
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
});
