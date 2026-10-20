// Actual order-row component, synthetic responses only, every nonlocal request blocked.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(repo, 'tests/campaignEligibilityBrowser');
const require = createRequire(path.join(repo, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
const runtime = path.resolve(path.dirname(process.execPath), '../node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || runtime).href);
const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(value => value && existsSync(value));
assert.ok(executablePath, 'Existing Chromium/Chrome/Edge is required; this test installs nothing.');
const outputFlag = process.argv.indexOf('--output');
const output = outputFlag >= 0 ? path.resolve(process.argv[outputFlag + 1]) : path.join(repo, 'tests/browser/artifacts/k10');
await fs.mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: fixture, appType: 'spa', plugins: [react()],
  cacheDir: path.join(output, '.vite'),
  resolve: { alias: [
    { find: /.*\/lib\/staffSupabase$/, replacement: path.join(fixture, 'sdk.js') },
    { find: /.*\/lib\/supabase$/, replacement: path.join(fixture, 'config.js') },
  ] },
  server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [repo] } }, css: { postcss: repo },
});
await server.listen();
const base = 'http://127.0.0.1:' + server.httpServer.address().port;
const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const checks = [];
const requests = [];
const external = [];
let orders = Array.from({ length: 8 }, (_, i) => ({ id: `SYNTHETICORDER${i}`, cloverUrl: 'https://www.clover.com/orders/SYNTHETICORDER' + i,
  createdAt: '2026-10-20T19:45:00Z', orderType: i === 2 ? 'delivery' : 'pickup', totalCents: i === 1 ? 2900 : 4200 }));
let failProvider = false;
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== base) { external.push(url.origin); return route.abort(); }
  if (url.pathname.startsWith('/api/')) {
    requests.push({ path: url.pathname, method: route.request().method() });
    assert.equal(url.pathname, '/api/staff/clover-orders'); assert.equal(route.request().method(), 'GET');
    assert.match(route.request().headers().authorization, /^Bearer synthetic-session-[ab]$/);
    return route.fulfill({ status: failProvider ? 503 : 200, json: failProvider ? { code: 'provider_unavailable' } : { code: 'ok', checkedAt: '2026-10-20T20:00:00Z', orders } });
  }
  return route.continue();
});
const check = (changes = {}) => ({ known: true, eligible: true, reason: 'eligible',
  campaign: { id: 'synthetic', name: 'INTERNAL TEST pickup simit', benefitType: 'item', targetItemId: 'SYNTHETICITEM' },
  remaining: { person: 1, total: 10, perOrder: 1 }, checkedAt: '2026-10-20T20:00:00Z', snapshotAt: '2026-10-20T19:55:00Z', candidates: [], ...changes });
const response = data => ({ data, error: null });
const rows = {
  SYNTHETICORDER0: response(check()),
  SYNTHETICORDER1: response(check({ eligible: false, reason: 'below_minimum' })),
  SYNTHETICORDER2: response(check({ eligible: false, reason: 'channel_mismatch' })),
  SYNTHETICORDER3: response(check({ eligible: false, reason: 'customer_ineligible' })),
  SYNTHETICORDER4: response(check({ eligible: false, reason: 'period_limit' })),
  SYNTHETICORDER5: { data: null, error: { code: '42501', status: 403 } },
  SYNTHETICORDER6: response(check({ known: false, eligible: null, reason: 'order_not_synced', campaign: null, remaining: null, snapshotAt: null })),
  SYNTHETICORDER7: { data: null, error: { code: 'PGRST202' } },
};
const load = () => page.getByRole('button', { name: 'Load last 7 days', exact: true }).click();
const row = i => page.locator('div.flex.flex-wrap.justify-between').filter({ hasText: `Order SYNTHETICORDER${i} ·` });
try {
  await page.goto(base);
  await page.evaluate(value => window.__eligibilityMock.responses(value), rows);
  assert.equal(requests.length, 0); checks.push('No automatic provider request, form submission, ingest, or RPC on mount.');
  await page.evaluate(() => window.__eligibilityMock.hold());
  await load();
  await row(0).getByText('Simit hakkı: Kontrol ediliyor…', { exact: true }).waitFor();
  assert.equal(await row(0).getByText('Simit hakkı: Yok', { exact: true }).count(), 0);
  checks.push('Pending read is explicitly checking, never no benefit.');
  await page.evaluate(() => window.__eligibilityMock.release());
  await row(0).getByText('Simit hakkı: Var', { exact: true }).waitFor();
  for (const [i, text] of [[1, 'Tutar eşiğin altında'], [2, 'Sipariş kanalı uygun değil'], [3, 'Abonelik/uygunluk koşulu sağlanmıyor'], [4, 'Kişi sınırı doldu']]) {
    await row(i).getByText(`Simit hakkı: Yok — ${text}`, { exact: true }).waitFor();
  }
  checks.push('Eligible, below threshold, delivery, missing consent and customer quota render the server decision.');
  await row(5).getByText('Simit hakkı: Doğrulanamadı — Bu işletme için erişim yok', { exact: true }).waitFor();
  await row(6).getByText('Simit hakkı: Doğrulanamadı — Sipariş henüz CRM’ye alınmamış', { exact: true }).waitFor();
  await row(7).getByText('Simit hakkı: Doğrulanamadı — Bağlantı veya veri doğrulanamadı', { exact: true }).waitFor();
  checks.push('Wrong business 403, missing local import and RPC failure are unknown, never ineligible.');
  await row(0).getByText(/Sipariş aktarımı · New York: 20 Eki 15:55/).waitFor();
  await row(0).getByText(/Kişi kalan kullanım: 1 · Toplam kalan adet: 10/).waitFor();
  checks.push('Database snapshot and check times are separated; quota counts are not mixed with item units.');
  await page.screenshot({ path: path.join(output, 'orders-eligibility-desktop-synthetic.png'), fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await page.getByRole('link', { name: 'View order in Clover', exact: true }).count(), 8);
  await page.screenshot({ path: path.join(output, 'orders-eligibility-mobile-synthetic.png'), fullPage: true });
  checks.push('375px mobile has no page overflow; every order and its existing Clover link remains visible.');
  orders = [orders[0]];
  await page.evaluate(value => window.__eligibilityMock.responses({ SYNTHETICORDER0: value }), response(check({ campaign: { ...check().campaign, name: 'INTERNAL TEST kahve' } })));
  await load(); await row(0).getByText('İkram hakkı: Var', { exact: true }).waitFor();
  checks.push('Another item campaign is not labelled as a simit entitlement.');
  await page.evaluate(() => window.__eligibilityMock.hold());
  await load(); await row(0).getByText('Simit hakkı: Kontrol ediliyor…', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Synthetic new session' }).click();
  assert.equal(await page.getByText(/Order SYNTHETICORDER/).count(), 0);
  await page.evaluate(() => window.__eligibilityMock.release());
  await page.waitForTimeout(100);
  assert.equal(await page.getByText(/Order SYNTHETICORDER/).count(), 0);
  checks.push('Changing the session clears prior rows; late RPC success cannot restore private data.');
  failProvider = true;
  await load(); await page.getByText('Clover orders could not be loaded. Try again later.', { exact: true }).waitFor();
  assert.equal(await page.getByText('0 orders shown', { exact: false }).count(), 0);
  checks.push('Provider failure clears the old list without reporting zero orders.');
  failProvider = false;
  await page.evaluate(value => window.__eligibilityMock.responses({ SYNTHETICORDER0: value }), rows.SYNTHETICORDER0);
  await page.evaluate(() => window.__eligibilityMock.hold());
  await load(); await row(0).getByText('Simit hakkı: Kontrol ediliyor…', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Synthetic logout' }).click();
  await page.evaluate(() => window.__eligibilityMock.release());
  await page.waitForTimeout(100);
  assert.equal(await page.getByText(/Order SYNTHETICORDER/).count(), 0);
  checks.push('Logout unmounts pending reads and late responses cannot restore data.');
  const snapshot = await page.evaluate(() => window.__eligibilityMock.snapshot());
  assert.deepEqual(snapshot.failures, []); assert.deepEqual(external, []);
  assert.ok(snapshot.calls.every(call => call.name === 'campaign_eligibility_check_v1'));
  assert.ok(requests.every(request => request.method === 'GET'));
  checks.push('Every call is a read-only eligibility RPC or order-list GET; no reservation, redemption, send, payment, or outside network.');
  const result = { passed: checks.length, failed: 0, syntheticOnly: true, checks, requests, rpcCalls: snapshot.calls.length };
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); await server.close(); }
