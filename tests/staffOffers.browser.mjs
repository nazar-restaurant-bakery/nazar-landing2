// Local-only browser acceptance with synthetic Auth/RPC responses. No account,
// production/test database, email, provider route or external setting is used.
// PLAYWRIGHT_MODULE may point at the bundled runtime; no package is installed.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const base = new URL(process.env.STAFF_OFFERS_TEST_ORIGIN || 'http://127.0.0.1:4179');
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Browser test requires a loopback server.');
const runtime = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const syntheticRef = 'abcdefghijklmnopqrst';
const syntheticOrigin = `https://${syntheticRef}.supabase.co`;
const syntheticUser = { id: '11111111-2222-4333-8444-555555555555', aud: 'authenticated', role: 'authenticated', email: 'staff@example.invalid' };
const exp = Math.floor(Date.now() / 1000) + 3600;
const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: syntheticUser.id, aud: 'authenticated', role: 'authenticated', exp })).toString('base64url'), 'synthetic-signature'].join('.');
const session = { access_token: token, token_type: 'bearer', refresh_token: 'synthetic-refresh-token', expires_in: 3600, expires_at: exp, user: syntheticUser };
const rows = ['live', 'scheduled', 'ended', 'inactive'].map((status, index) => ({
  id: `synthetic-${index}`, name: `INTERNAL TEST ${status}`, description: `Synthetic ${status} offer`,
  code: `TEST${index}`, channel_target: 'clover',
  starts_at: status === 'scheduled' ? '2026-11-01' : status === 'ended' ? '2026-09-01' : '2026-10-01',
  ends_at: status === 'scheduled' ? '2026-11-30' : status === 'ended' ? '2026-09-30' : '2026-10-31',
  active: status !== 'inactive', offer_status: status,
}));
const scenarios = [];

async function harness({ signedIn = true, authorized = true, offers = rows, routePath = '/staff/offers', sessionValue = session } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (signedIn) await context.addInitScript(({ storageKey, session }) => { localStorage.setItem(storageKey, JSON.stringify(session)); }, { storageKey: `sb-${syntheticRef}-auth-token`, session: sessionValue });
  const calls = [];
  let catalogue = offers;
  let deny = !authorized;
  let fail = false;
  let deferred;
  let release;
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === base.origin || url.protocol === 'ws:' || url.protocol === 'wss:') { await route.continue(); return; }
    if (url.origin !== syntheticOrigin) { await route.abort(); return; }
    const name = url.pathname.split('/').at(-1);
    calls.push(name);
    if (url.pathname === '/rest/v1/rpc/crm_staff_authorized_v1') return route.fulfill({ json: !deny });
    if (url.pathname === '/rest/v1/rpc/list_offers') {
      assert.deepEqual(route.request().postDataJSON(), { p_business_id: '11111111-1111-4111-8111-111111111111' });
      if (deferred) await deferred;
      return fail ? route.fulfill({ status: 503, json: { code: 'NETWORK_ERROR' } }) : route.fulfill({ json: catalogue });
    }
    if (url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204 });
    if (url.pathname === '/auth/v1/user') return route.fulfill({ json: syntheticUser });
    throw new Error(`Unexpected sandbox request ${url.pathname}`);
  });
  const page = await context.newPage();
  await page.goto(new URL(routePath, base).href);
  return { context, page, calls,
    fail(value) { fail = value; }, deny(value) { deny = value; }, rows(value) { catalogue = value; },
    defer() { deferred = new Promise(resolve => { release = resolve; }); }, release() { release?.(); },
  };
}

try {
  const blockedLegacy = await harness({ routePath: '/staff', sessionValue: { ...session, expires_at: 1 } });
  await blockedLegacy.page.getByText('Staff access is not configured.', { exact: true }).waitFor();
  assert.deepEqual(blockedLegacy.calls, []);
  scenarios.push('Legacy CRM stays blocked in isolated mode, including an expired stored session.');
  await blockedLegacy.context.close();

  const anonymous = await harness({ signedIn: false });
  await anonymous.page.getByRole('heading', { name: 'Personel girişi' }).waitFor();
  assert.deepEqual(anonymous.calls, []);
  assert.equal(await anonymous.page.getByRole('list', { name: 'Tüm teklifler' }).count(), 0);
  scenarios.push('Unsigned visitor sees sign-in and makes no private RPC request.');
  await anonymous.context.close();

  const denied = await harness({ authorized: false });
  await denied.page.getByRole('alert').filter({ hasText: 'Erişim yok.' }).waitFor();
  assert.ok(denied.calls.length > 0 && denied.calls.every(call => call === 'crm_staff_authorized_v1'));
  scenarios.push('Unauthorized session is denied before list_offers.');
  await denied.context.close();

  const full = await harness();
  await full.page.getByRole('list', { name: 'Tüm teklifler' }).waitFor();
  assert.equal(await full.page.getByRole('listitem').count(), 4);
  for (const status of ['Yayında', 'Planlandı', 'Sona erdi', 'Pasif']) assert.equal(await full.page.getByText(status, { exact: true }).count(), 1);
  assert.equal(await full.page.getByRole('button', { name: /düzenle|yayınla|kaydet/i }).count(), 0);
  assert.ok(full.calls.includes('list_offers') && full.calls.every(call => ['crm_staff_authorized_v1', 'list_offers'].includes(call)));
  scenarios.push('All four statuses appear together with no edit or publish action.');
  if (process.env.STAFF_OFFERS_SCREENSHOTS) {
    await mkdir(process.env.STAFF_OFFERS_SCREENSHOTS, { recursive: true });
    await full.page.screenshot({ path: path.join(process.env.STAFF_OFFERS_SCREENSHOTS, 'offers-desktop-synthetic.png'), fullPage: true });
  }
  await full.page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await full.page.getByRole('listitem').count(), 4);
  assert.ok(await full.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  if (process.env.STAFF_OFFERS_SCREENSHOTS) await full.page.screenshot({ path: path.join(process.env.STAFF_OFFERS_SCREENSHOTS, 'offers-mobile-synthetic.png'), fullPage: true });
  scenarios.push('375px mobile keeps every offer and has no horizontal overflow.');

  full.fail(true);
  await full.page.getByRole('button', { name: 'Yenile', exact: true }).click();
  await full.page.getByRole('alert').filter({ hasText: 'Teklifler yüklenemedi.' }).waitFor();
  assert.equal(await full.page.getByRole('listitem').count(), 0);
  assert.equal(await full.page.getByText('0 teklif', { exact: true }).count(), 0);
  scenarios.push('Failed refresh clears stale rows and never reports zero offers.');
  full.fail(false); full.rows([]);
  await full.page.getByRole('button', { name: 'Yenile', exact: true }).click();
  await full.page.getByText('Henüz teklif yok.', { exact: true }).waitFor();
  scenarios.push('An actual empty authorized result has its own empty state.');

  full.rows(rows); full.defer();
  await full.page.getByRole('button', { name: 'Yenile', exact: true }).click();
  await full.page.getByRole('button', { name: 'Çıkış', exact: true }).click();
  await full.page.getByRole('heading', { name: 'Personel girişi' }).waitFor();
  full.release();
  await full.page.waitForTimeout(100);
  assert.equal(await full.page.getByRole('list', { name: 'Tüm teklifler' }).count(), 0);
  assert.equal(await full.page.getByText('INTERNAL TEST live', { exact: true }).count(), 0);
  scenarios.push('Logout unmounts data and a late RPC response cannot restore it.');
  assert.ok(full.calls.every(call => ['crm_staff_authorized_v1', 'list_offers', 'logout', 'user'].includes(call)));
  scenarios.push('Only Auth and the two read-only RPCs were requested; no provider route.');
  await full.context.close();
  console.log(JSON.stringify({ passed: scenarios.length, failed: 0, syntheticOnly: true, scenarios }, null, 2));
} finally { await browser.close(); }
