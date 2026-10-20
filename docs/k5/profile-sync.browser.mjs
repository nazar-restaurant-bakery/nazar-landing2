// Offline UI acceptance: synthetic session + mocked same-origin API only.
// No login, account operation, database, email or provider request is performed.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const base = new URL(process.env.PROFILE_SYNC_TEST_ORIGIN || 'http://127.0.0.1:4181');
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Only loopback testing is allowed.');
const runtime = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const output = path.dirname(fileURLToPath(import.meta.url));
const syntheticRef = 'abcdefghijklmnopqrst';
const syntheticOrigin = `https://${syntheticRef}.supabase.co`;
const syntheticUser = { id: '11111111-2222-4333-8444-555555555555', aud: 'authenticated', role: 'authenticated', email: 'staff@example.invalid' };
const exp = Math.floor(Date.now() / 1000) + 3600;
const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: syntheticUser.id, aud: 'authenticated', role: 'authenticated', exp })).toString('base64url'), 'synthetic-signature'].join('.');
const session = { access_token: token, token_type: 'bearer', refresh_token: 'synthetic-refresh-token', expires_in: 3600, expires_at: exp, user: syntheticUser };
const jobs = ['queued', 'retry', 'blocked', 'failed', 'succeeded'].map((status, index) => ({
  id: `${index + 1}1111111-2222-4333-8444-555555555555`, profileId: null,
  status, attempts: index, nextAttemptAt: status === 'retry' ? '2026-10-20T14:00:00Z' : null,
  lastErrorCode: status === 'retry' ? 'RATE_LIMITED' : status === 'failed' ? 'RETRY_LIMIT' : null,
  updatedAt: '2026-10-19T14:05:00Z',
}));
const initial = { code: 'ok', mode: 'mock', jobs,
  counts: { queued: 1, running: 0, retry: 1, failed: 1, blocked: 1, succeeded: 1 } };
const runResult = { code: 'ok', mode: 'mock', processed: 3, succeeded: 1, blocked: 1, retry: 1, failed: 0 };
const scenarios = [];

async function waitUntil(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Synthetic UI condition timed out.');
}

async function harness({ signedIn = true, routePath = '/staff/profile-sync', data = initial, readStatus = 200 } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  if (signedIn) await context.addInitScript(({ storageKey, session }) => { localStorage.setItem(storageKey, JSON.stringify(session)); }, { storageKey: `sb-${syntheticRef}-auth-token`, session });
  const calls = [];
  let queueData = structuredClone(data);
  let getStatus = readStatus;
  let postStatus = 200;
  let postDeferred;
  let releasePost;
  let getDeferred;
  let releaseGet;
  let externalRequests = 0;
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === base.origin && url.pathname === '/api/staff/profile-sync') {
      const method = request.method();
      calls.push(method);
      assert.equal(request.headers().authorization, `Bearer ${token}`);
      if (method === 'GET') {
        if (getDeferred) await getDeferred;
        return route.fulfill({ status: getStatus, json: getStatus === 200 ? queueData : { code: 'unavailable' } });
      }
      assert.equal(method, 'POST');
      assert.deepEqual(request.postDataJSON(), { action: 'run' });
      if (postDeferred) await postDeferred;
      return route.fulfill({ status: postStatus, json: postStatus === 200 ? runResult : { code: 'unavailable' } });
    }
    if (url.origin === base.origin || url.protocol === 'ws:') return route.continue();
    if (url.origin === syntheticOrigin && url.pathname === '/auth/v1/logout') return route.fulfill({ status: 204 });
    if (url.origin === syntheticOrigin && url.pathname === '/auth/v1/user') return route.fulfill({ json: syntheticUser });
    externalRequests += 1;
    await route.abort();
  });
  const page = await context.newPage();
  await page.goto(new URL(routePath, base).href);
  return { context, page, calls,
    setData(value) { queueData = structuredClone(value); },
    setReadStatus(value) { getStatus = value; }, setPostStatus(value) { postStatus = value; },
    deferPost() { postDeferred = new Promise(resolve => { releasePost = resolve; }); },
    releasePost() { releasePost?.(); postDeferred = null; },
    deferGet() { getDeferred = new Promise(resolve => { releaseGet = resolve; }); },
    releaseGet() { releaseGet?.(); getDeferred = null; },
    assertNoExternal() { assert.equal(externalRequests, 0, 'An unexpected external request was blocked.'); },
  };
}

try {
  await mkdir(output, { recursive: true });
  const anonymous = await harness({ signedIn: false });
  await anonymous.page.getByRole('heading', { name: 'Personel girişi' }).waitFor();
  assert.deepEqual(anonymous.calls, []);
  assert.equal(await anonymous.page.getByRole('button', { name: 'Şimdi senkronla' }).count(), 0);
  anonymous.assertNoExternal(); await anonymous.context.close();
  scenarios.push('Unsigned visitor makes no private queue or command request; no login is performed.');

  const legacy = await harness({ routePath: '/staff' });
  await legacy.page.getByText('Staff access is not configured.', { exact: true }).waitFor();
  assert.deepEqual(legacy.calls, []); legacy.assertNoExternal(); await legacy.context.close();
  scenarios.push('Existing isolated legacy staff provider block remains unchanged.');

  for (const status of [401, 403]) {
    const denied = await harness({ readStatus: status });
    await denied.page.getByRole('alert').filter({ hasText: 'Erişim yok.' }).waitFor();
    assert.equal(await denied.page.getByRole('list', { name: 'Profil senkron kuyruğu' }).count(), 0);
    assert.equal(await denied.page.getByRole('button', { name: 'Şimdi senkronla' }).isDisabled(), true);
    denied.assertNoExternal(); await denied.context.close();
  }
  scenarios.push('401 and 403 deny queue visibility and manual commands.');

  const disabled = await harness({ data: { code: 'ok', mode: 'disabled', jobs: [], counts: {} } });
  await disabled.page.getByText('Bağlantı bekliyor. Profil senkronu etkin değil.', { exact: true }).waitFor();
  assert.equal(await disabled.page.getByRole('button', { name: 'Şimdi senkronla' }).isDisabled(), true);
  assert.equal(await disabled.page.getByText('Henüz senkron kaydı yok.', { exact: true }).count(), 0);
  assert.equal(await disabled.page.getByRole('list', { name: 'Profil senkron kuyruğu' }).count(), 0);
  disabled.assertNoExternal(); await disabled.context.close();
  scenarios.push('Disabled mode shows connection waiting rather than an invented healthy zero.');

  const full = await harness();
  await full.page.getByRole('list', { name: 'Profil senkron kuyruğu' }).waitFor();
  assert.equal(await full.page.getByRole('listitem').count(), 5);
  assert.equal(await full.page.getByText('İş 11111111', { exact: true }).count(), 1);
  assert.equal(await full.page.getByText('RATE_LIMITED', { exact: true }).count(), 1);
  assert.equal(await full.page.getByText(/20 Eki 2026.*10:00/).count(), 1);
  assert.equal(await full.page.getByText('Deneme modu — dış sisteme kayıt gönderilmez.', { exact: true }).count(), 1);
  await full.page.screenshot({ path: path.join(output, 'profile-sync-desktop-synthetic.png'), fullPage: true });
  await full.page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await full.page.getByRole('listitem').count(), 5);
  assert.ok(await full.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await full.page.screenshot({ path: path.join(output, 'profile-sync-mobile-synthetic.png'), fullPage: true });
  scenarios.push('Synthetic queue shows short IDs, safe error, attempts and New York retry time; 375px has no horizontal overflow.');

  full.deferPost();
  await full.page.getByRole('button', { name: 'Şimdi senkronla', exact: true }).click();
  await waitUntil(() => full.calls.includes('POST'));
  assert.equal(await full.page.getByRole('button', { name: 'Senkron bekleniyor…', exact: true }).isDisabled(), true);
  assert.equal(await full.page.getByRole('button', { name: 'Yenile', exact: true }).isDisabled(), true);
  assert.equal(full.calls.filter(method => method === 'POST').length, 1);
  full.releasePost();
  await full.page.getByText('Son işlem: 3 işlendi · 1 tamamlandı · 1 engellendi · 1 tekrar bekliyor · 0 başarısız.', { exact: true }).waitFor();
  await waitUntil(async () => !await full.page.getByRole('button', { name: 'Şimdi senkronla', exact: true }).isDisabled());
  assert.equal(full.calls.filter(method => method === 'POST').length, 1);
  assert.ok(full.calls.filter(method => method === 'GET').length >= 2);
  scenarios.push('One explicit command is locked while pending and followed only by a read, never another write.');

  full.setPostStatus(503);
  await full.page.getByRole('button', { name: 'Şimdi senkronla', exact: true }).click();
  await full.page.getByRole('alert').filter({ hasText: 'İşlem sonucu doğrulanamadı.' }).waitFor();
  assert.equal(await full.page.getByRole('button', { name: 'Şimdi senkronla', exact: true }).isDisabled(), true);
  assert.equal(full.calls.filter(method => method === 'POST').length, 2);
  full.setReadStatus(503);
  await full.page.getByRole('button', { name: 'Yenile', exact: true }).click();
  await full.page.getByRole('alert').filter({ hasText: 'kayıt sayısı doğrulanmadı.' }).waitFor();
  assert.equal(await full.page.getByRole('button', { name: 'Şimdi senkronla', exact: true }).isDisabled(), true);
  assert.equal(await full.page.getByRole('listitem').count(), 0);
  assert.equal(await full.page.getByText('Henüz senkron kaydı yok.', { exact: true }).count(), 0);
  assert.equal(full.calls.filter(method => method === 'POST').length, 2);
  full.setReadStatus(200);
  await full.page.getByRole('button', { name: 'Yenile', exact: true }).click();
  await waitUntil(async () => !await full.page.getByRole('button', { name: 'Şimdi senkronla', exact: true }).isDisabled());
  assert.equal(await full.page.getByRole('alert').filter({ hasText: 'İşlem sonucu doğrulanamadı.' }).count(), 0);
  assert.equal(full.calls.filter(method => method === 'POST').length, 2);
  scenarios.push('Unknown command outcome stays locked through a failed read; only a successful manual refresh unlocks it, with no automatic write retry.');

  full.setData({ ...initial, jobs: [], counts: { queued: 0, retry: 0 } });
  await full.page.getByRole('button', { name: 'Yenile', exact: true }).click();
  await full.page.getByText('Henüz senkron kaydı yok.', { exact: true }).waitFor();
  scenarios.push('An actual authorized empty active queue has a separate empty state.');
  full.setData(initial);
  await full.page.getByRole('button', { name: 'Yenile', exact: true }).click();
  await full.page.getByRole('list', { name: 'Profil senkron kuyruğu' }).waitFor();
  full.setReadStatus(403);
  await full.page.getByRole('button', { name: 'Yenile', exact: true }).click();
  await full.page.getByRole('alert').filter({ hasText: 'Erişim yok.' }).waitFor();
  assert.equal(await full.page.getByRole('listitem').count(), 0);
  assert.equal(await full.page.getByText(/Son işlem:/).count(), 0);
  scenarios.push('Revoked authorization clears previously visible private queue and command result.');
  full.assertNoExternal(); await full.context.close();

  const malformed = await harness({ data: { ...initial, jobs: [{ ...jobs[0], lastErrorCode: 'provider raw text staff@example.invalid' }] } });
  await malformed.page.getByRole('alert').filter({ hasText: 'kayıt sayısı doğrulanmadı.' }).waitFor();
  assert.equal(await malformed.page.getByText('provider raw text staff@example.invalid', { exact: true }).count(), 0);
  malformed.assertNoExternal(); await malformed.context.close();
  scenarios.push('Malformed provider text is rejected without exposing it or inventing an empty queue.');

  const late = await harness();
  await late.page.getByRole('list', { name: 'Profil senkron kuyruğu' }).waitFor();
  late.deferPost();
  await late.page.getByRole('button', { name: 'Şimdi senkronla', exact: true }).click();
  await waitUntil(() => late.calls.includes('POST'));
  await late.page.getByRole('button', { name: 'Çıkış', exact: true }).click();
  await late.page.getByRole('heading', { name: 'Personel girişi' }).waitFor();
  late.releasePost();
  await late.page.waitForTimeout(100);
  assert.equal(await late.page.getByRole('listitem').count(), 0);
  assert.equal(await late.page.getByText(/Son işlem:/).count(), 0);
  assert.equal(late.calls.filter(method => method === 'POST').length, 1);
  late.assertNoExternal(); await late.context.close();
  scenarios.push('Logout clears private data immediately and a late command response cannot restore it.');

  const report = { passed: scenarios.length, failed: 0, syntheticOnly: true,
    actualAccountActions: 0, externalNetworkRequests: 0, scenarios };
  await writeFile(path.join(output, 'profile-sync-browser-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
