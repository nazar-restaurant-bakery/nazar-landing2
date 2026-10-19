import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { staffCopy as c } from '../../src/lib/staffCopy.ts';
import { opsCopy as o } from '../../src/lib/opsCopy.ts';
import { runOpsScenarios } from './opsScenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const require = createRequire(path.join(repo, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
const bundled = path.resolve(path.dirname(process.execPath), '..', 'node_modules/playwright/index.mjs');
let playwright;
try { playwright = await import('playwright'); }
catch { playwright = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || bundled).href); }
const { chromium } = playwright;
const candidates = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
const executablePath = candidates.find(existsSync);
if (!executablePath) throw new Error('No existing Chromium/Chrome/Edge found. This test never downloads a browser. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE.');
const outputFlag = process.argv.indexOf('--output');
const output = outputFlag >= 0 ? path.resolve(process.argv[outputFlag + 1]) : path.join(here, 'artifacts');
const grepFlag = process.argv.indexOf('--grep');
const grep = grepFlag >= 0 ? new RegExp(process.argv[grepFlag + 1], 'i') : null;
await fs.mkdir(output, { recursive: true });
const server = await createServer({ configFile: false, root: here, envDir: here, appType: 'spa', plugins: [react()],
  define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://mock-only.invalid'), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('mock-only'), 'import.meta.env.VITE_NAZAR_BUSINESS_ID': JSON.stringify('a358eba4-b197-4309-805b-46f43a718454') },
  resolve: { alias: { '@supabase/supabase-js': path.join(here, 'mockSdk.js') } },
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, fs: { allow: [repo] } },
  css: { postcss: repo },
});
await server.listen();
const base = 'http://127.0.0.1:' + server.httpServer.address().port;
const browser = await chromium.launch({ executablePath, headless: true,
  args: ['--disable-background-networking', '--disable-component-update', '--no-default-browser-check', '--disable-sync'] })
  .catch(async error => { await server.close(); throw error; });
const checks = [];
const screenshots = [];
const suiteStartedAt = new Date().toISOString();
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = value => ({ name: value, exact: true });
const snapshot = page => page.evaluate(() => window.__staffMock.snapshot());
const calls = async (page, name) => (await snapshot(page)).calls.filter(call => call.name === name);
const writeCount = async page => (await snapshot(page)).calls.filter(call => /^(crm_add_note|crm_create_task_v1|crm_complete_task_v1|crm_update_catering|crm_request_catering_decision_v1|crm_resolve_form_error_v1)$/.test(call.name)).length;
async function waitCall(page, name, count = 1) {
  await page.waitForFunction(({ name, count }) => window.__staffMock.snapshot().calls.filter(call => call.name === name).length >= count, { name, count });
}
async function visible(page, text) { await page.getByText(text, { exact: true }).first().waitFor(); }
async function tab(page, label) {
  await page.getByRole('link', exact(label)).or(page.getByRole('button', exact(label))).first().click();
}
async function selectCustomer(page, name = 'Örnek Müşteri') {
  await tab(page, c.customers);
  if (page.viewportSize().width < 1024) await page.getByRole('button', exact('← ' + c.list)).click();
  const button = page.getByRole('button', { name: new RegExp(escaped(name)) }).first();
  if ((await button.count()) && !(await button.isVisible())) {
    await page.getByRole('button', { name: new RegExp(escaped(c.list)) }).first().click();
  }
  await button.click();
  await waitCall(page, 'crm_customer_tasks_v1');
}
const noteBox = page => page.getByRole('textbox', { name: new RegExp('^' + escaped(c.note) + '$|^' + escaped(c.addNote) + '$') }).first();
async function addNote(page, text) {
  await noteBox(page).fill(text);
  await page.getByRole('button', exact(c.addNote)).click();
}
async function openTaskForm(page) {
  if (!(await page.getByRole('textbox', exact(c.taskTitle)).count())) await page.getByRole('button', exact(c.createTask)).first().click();
  await page.getByRole('textbox', exact(c.taskTitle)).waitFor();
}
async function fillTask(page, title = 'Örnek yeni takip', owner = 'Talip', due = '2026-10-20T10:00') {
  await openTaskForm(page);
  const titleBox = page.getByRole('textbox', exact(c.taskTitle));
  await titleBox.fill(title);
  const form = titleBox.locator('xpath=ancestor::form');
  await form.getByRole('combobox', exact(c.owner)).selectOption(owner);
  await form.getByLabel(c.due, { exact: true }).fill(due);
  return form;
}
async function submitTask(page, title, owner, due) {
  const form = await fillTask(page, title, owner, due);
  await form.getByRole('button', exact(c.createTask)).click();
}
async function selectRequest(page) {
  await tab(page, c.catering);
  const cards = page.locator('[draggable="true"]');
  await cards.first().waitFor();
  await cards.first().getByRole('button').first().click();
}
async function requestForm(page) {
  const status = page.getByRole('combobox', exact(c.status));
  await status.waitFor();
  return status.locator('xpath=ancestor::form');
}
async function refresh(page) { await page.getByRole('button', exact(c.refresh)).first().click(); }
async function signIn(page) {
  await page.getByRole('textbox', exact(c.email)).fill('staff@example.invalid');
  await page.getByLabel(c.password, { exact: true }).fill('not-a-real-password');
  await page.getByRole('button', exact(c.login)).click();
}
async function setMode(page, mode) { await page.evaluate(mode => window.__staffMock.setMode(mode), mode); }
async function screenshot(page, name) {
  const target = path.join(output, name + '.png');
  await page.screenshot({ path: target, fullPage: true }); screenshots.push(target);
}
async function run(name, mode, fn, initialPath = '/staff/customers', options = {}) {
  if (grep && !grep.test(name)) return;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', timezoneId: 'Europe/Istanbul',
    serviceWorkers: 'block', acceptDownloads: false, ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const external = [];
  const runtimeErrors = [];
  await context.route('**/*', async route => {
    const url = route.request().url();
    if ((url.startsWith(base + '/') && !new URL(url).pathname.startsWith('/api/')) || url.startsWith('data:')) await route.continue();
    else { external.push(url); await route.abort('blockedbyclient'); }
  });
  page.on('pageerror', error => runtimeErrors.push(error.message));
  try {
    await page.goto(base + initialPath + '?mode=' + encodeURIComponent(mode), { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__staffMock);
    await fn(page);
    assert.deepEqual((await snapshot(page)).unexpected, [], 'Unknown SDK/API calls must never be silently accepted');
    assert.deepEqual(external, [], 'No request may leave the local harness');
    assert.deepEqual(runtimeErrors, [], 'No uncaught render/runtime errors');
    checks.push({ case: name, passed: true });
    process.stdout.write('PASS ' + name + '\n');
  } catch (error) {
    checks.push({ case: name, passed: false, error: error.stack || String(error), external, runtimeErrors });
    await page.screenshot({ path: path.join(output, 'failure-' + String(checks.length).padStart(2, '0') + '.png'), fullPage: true }).catch(() => {});
    process.stdout.write('FAIL ' + name + ': ' + error.message.split('\n')[0] + '\n');
  } finally { await context.close(); }
}

try {
  // The first 22 cases preserve the historical acceptance scenarios individually.
  await run('01 Whitespace note blocked without write', 'normal', async page => {
    await selectCustomer(page); await noteBox(page).fill('   ');
    const button = page.getByRole('button', exact(c.addNote));
    if (!(await button.isDisabled())) { await button.click(); await visible(page, c.noteError); }
    assert.equal(await writeCount(page), 0);
  });
  await run('02 Whitespace task blocked without write', 'normal', async page => {
    await selectCustomer(page); await submitTask(page, '   '); await visible(page, c.titleError); assert.equal(await writeCount(page), 0);
  });
  await run('03 Task saves with exact params and reloads', 'normal', async page => {
    await selectCustomer(page); await submitTask(page); await visible(page, c.taskSaved); await refresh(page);
    const saved = await calls(page, 'crm_create_task_v1'); assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].params, { p_customer_id: (await snapshot(page)).customers[0].id, p_title: 'Örnek yeni takip', p_assigned_to: 'Talip', p_due_at: '2026-10-20T14:00:00.000Z' });
    await page.getByText('Örnek yeni takip', { exact: true }).first().waitFor();
  });
  await run('04 Note saves and survives refresh', 'normal', async page => {
    await selectCustomer(page); await addNote(page, 'SYNTHETIC — kalıcı not'); await visible(page, c.noteSaved); await refresh(page);
    await visible(page, 'SYNTHETIC — kalıcı not'); assert.equal((await calls(page, 'crm_add_note')).length, 1);
  });
  await run('05 Empty response is a real empty state', 'empty', async page => { await visible(page, c.noCustomers); });
  await run('06 Malformed response is unavailable rather than zero records', 'malformed', async page => {
    await visible(page, c.unavailable); assert.equal(await page.getByText(c.noCustomers, { exact: true }).count(), 0);
  });
  await run('07 Denied response reveals no private records', 'denied', async page => {
    await visible(page, c.accessDenied); assert.equal(await page.getByText('Örnek Müşteri', { exact: true }).count(), 0);
    await refresh(page); await visible(page, c.accessDenied);
  });
  await run('08 Network rejection stays recoverable', 'throws', async page => {
    await visible(page, c.unavailable); await setMode(page, 'normal'); await refresh(page); await selectCustomer(page);
  });
  await run('09 Unavailable tasks are not shown as zero', 'task-error', async page => {
    await selectCustomer(page); await visible(page, c.taskUnavailable); assert.equal(await page.getByText(c.noTasks, { exact: true }).count(), 0);
  });
  await run('10 Malformed stored date does not crash rendering', 'bad-date', async page => {
    await selectCustomer(page); await page.getByText(c.invalidDate, { exact: true }).first().waitFor();
  });
  await run('11 Missing or whitespace request owner is blocked', 'null-owner', async page => {
    await selectRequest(page); const form = await requestForm(page); await form.getByRole('button', exact(c.save)).click();
    assert.equal((await calls(page, 'crm_update_catering')).length, 0);
    await form.getByRole('combobox', exact(c.owner)).selectOption('other'); await form.getByLabel(c.otherOwner, { exact: true }).fill('   ');
    await form.getByRole('button', exact(c.save)).click(); await visible(page, c.ownerError); assert.equal(await writeCount(page), 0);
  }, '/staff/catering');
  await run('12 Open request missing follow-up blocked before write', 'normal', async page => {
    await selectRequest(page); const form = await requestForm(page); await form.getByLabel(c.due, { exact: true }).fill('');
    await form.getByRole('button', exact(c.save)).click(); await visible(page, c.followupRequired); assert.equal(await writeCount(page), 0);
  }, '/staff/catering');
  await run('13 Closed request accepts no follow-up per existing rule', 'closed', async page => {
    await selectRequest(page); const form = await requestForm(page); await form.getByRole('button', exact(c.save)).click(); await visible(page, c.requestSaved);
    assert.equal((await calls(page, 'crm_update_catering'))[0].params.p_follow_up_at, null);
  }, '/staff/catering');
  await run('14 Failed save preserves draft and releases busy state', 'save-error', async page => {
    await selectCustomer(page); await addNote(page, 'SYNTHETIC — hata taslağı'); await visible(page, c.unknownSave);
    assert.equal(await noteBox(page).inputValue(), 'SYNTHETIC — hata taslağı'); assert.equal((await calls(page, 'crm_add_note')).length, 1);
  });
  await run('15 Pending save prevents duplicate submission', 'slow', async page => {
    await selectCustomer(page); await addNote(page, 'SYNTHETIC — tek kayıt'); await waitCall(page, 'crm_add_note');
    assert.equal(await noteBox(page).locator('xpath=ancestor::form').locator('button[type="submit"]').isDisabled(), true); assert.equal((await calls(page, 'crm_add_note')).length, 1);
    await page.evaluate(() => window.__staffMock.release()); await visible(page, c.noteSaved);
  });
  await run('16 Released pending save produces exactly one note', 'slow', async page => {
    await selectCustomer(page); await addNote(page, 'SYNTHETIC — tek sonuç'); await waitCall(page, 'crm_add_note');
    await page.evaluate(() => window.__staffMock.release()); await visible(page, c.noteSaved);
    assert.equal((await snapshot(page)).customers[0].notes.length, 1);
  });
  await run('17 Sign-out clears private view', 'normal', async page => {
    await selectCustomer(page); await page.getByRole('button', exact(c.logout)).click(); await visible(page, c.loginTitle);
    assert.equal(await page.getByText('Örnek Müşteri', { exact: true }).count(), 0);
  });
  await run('18 Sign-in network error is recoverable', 'signin-network', async page => {
    await page.getByRole('textbox', exact(c.email)).fill('staff@example.invalid'); await page.getByLabel(c.password, { exact: true }).fill('not-a-real-password');
    await page.getByRole('button', exact(c.login)).click(); await visible(page, c.loginNetwork);
    assert.equal(await page.getByRole('button', exact(c.login)).isDisabled(), false);
  });
  await run('19 Refresh retries tasks after connection recovery', 'task-error', async page => {
    await selectCustomer(page); await visible(page, c.taskUnavailable); await setMode(page, 'normal'); await refresh(page);
    await visible(page, 'Örnek takip görevi'); assert.ok((await calls(page, 'crm_customer_tasks_v1')).length >= 2);
  });
  await run('20 Retry after refresh saves only one note', 'save-error', async page => {
    await selectCustomer(page); await addNote(page, 'SYNTHETIC — güvenli tekrar'); await visible(page, c.unknownSave);
    await setMode(page, 'normal'); await refresh(page); await page.getByRole('button', exact(c.addNote)).click(); await visible(page, c.noteSaved);
    assert.equal((await snapshot(page)).customers[0].notes.length, 1); assert.equal((await calls(page, 'crm_add_note')).length, 2);
  });
  await run('21 Lost write response refreshes committed note without automatic retry', 'lost-save-response', async page => {
    await selectCustomer(page); await addNote(page, 'SYNTHETIC — yanıt kayboldu'); await visible(page, c.unknownSave); await setMode(page, 'normal'); await refresh(page);
    await visible(page, 'SYNTHETIC — yanıt kayboldu'); assert.equal((await calls(page, 'crm_add_note')).length, 1);
  });
  await run('22 Logout clears drafts before next session', 'normal', async page => {
    await selectCustomer(page); await noteBox(page).fill('SYNTHETIC PRIVATE UNSAVED'); await page.getByRole('button', exact(c.logout)).click(); await visible(page, c.loginTitle);
    await signIn(page); await selectCustomer(page); assert.equal(await noteBox(page).inputValue(), '');
  });

  await run('23 Default staff route opens Tasks', 'normal', async page => {
    await page.waitForURL('**/staff/tasks*'); await page.getByRole('heading', exact(c.tasks)).waitFor();
  }, '/staff');
  for (const route of ['customers', 'crm', 'catering', 'tasks', 'offers', 'system', 'ops']) {
    await run('24 Denied direct route /staff/' + route, 'auth-denied', async page => {
      await visible(page, c.accessDenied); const s = await snapshot(page);
      assert.equal(s.calls.filter(call => call.name !== 'auth.getSession' && call.name !== 'crm_staff_authorized_v1').length, 0);
    }, '/staff/' + route);
  }
  await run('25 Internal tests hidden across all five tabs; can be deliberately included', 'normal', async page => {
    for (const label of [c.customers, c.catering, c.tasks, c.offers, c.system]) {
      await tab(page, label); assert.equal(await page.getByText(/INTERNAL TEST — Örnek|INTERNAL TEST — Takip görevi/).count(), 0);
    }
    await page.getByRole('checkbox', { name: new RegExp(escaped(c.tests)) }).check(); await tab(page, c.customers);
    await page.getByRole('button', { name: /INTERNAL TEST — Örnek/ }).waitFor();
    await page.getByRole('checkbox', { name: new RegExp(escaped(c.tests)) }).uncheck();
    await page.getByRole('button', { name: /INTERNAL TEST — Örnek/ }).waitFor({ state: 'hidden' });
  });
  await run('26 Kanban drag writes exact existing RPC params', 'normal', async page => {
    const card = page.locator('[draggable="true"]').first(); await card.waitFor();
    const original = (await snapshot(page)).requests[0];
    const target = page.locator('[data-status="contacted"]'); await target.waitFor(); await card.dragTo(target);
    await waitCall(page, 'crm_update_catering'); const call = (await calls(page, 'crm_update_catering'))[0];
    assert.deepEqual(call.params, { p_request_id: original.id, p_status: 'contacted', p_assigned_to: original.assigned_to, p_follow_up_at: original.follow_up_at });
  }, '/staff/catering');
  await run('27 Invalid kanban move does not write and asks for missing fields', 'null-owner', async page => {
    const card = page.locator('[draggable="true"]').first(); await card.waitFor(); await card.dragTo(page.locator('[data-status="contacted"]'));
    await requestForm(page); assert.equal(await writeCount(page), 0);
  }, '/staff/catering');
  await run('28 Late read after sign-out cannot restore private data', 'normal', async page => {
    await selectCustomer(page); await page.evaluate(() => window.__staffMock.hold('crm_overview_v2')); await refresh(page);
    await page.waitForFunction(() => window.__staffMock.snapshot().held.length > 0); await page.evaluate(() => window.__staffMock.signOut());
    await visible(page, c.loginTitle); await page.evaluate(() => window.__staffMock.release()); await page.waitForTimeout(100);
    assert.equal(await page.getByText('Örnek Müşteri', { exact: true }).count(), 0);
  });
  await run('29 Late write after sign-out cannot restore draft/private data', 'slow', async page => {
    await selectCustomer(page); await addNote(page, 'SYNTHETIC — delayed private write'); await waitCall(page, 'crm_add_note');
    await page.evaluate(() => window.__staffMock.signOut()); await visible(page, c.loginTitle); await page.evaluate(() => window.__staffMock.release());
    await page.waitForTimeout(100); assert.equal(await page.getByText('SYNTHETIC — delayed private write', { exact: true }).count(), 0);
  });
  await run('30 New York display and saved due time are independent of device timezone', 'normal', async page => {
    await selectCustomer(page); await page.getByText(/18 Eki 2026.*14:05/).first().waitFor();
    await submitTask(page, 'SYNTHETIC — NY timezone', 'Yücel', '2026-11-02T10:00'); await visible(page, c.taskSaved);
    assert.equal((await calls(page, 'crm_create_task_v1'))[0].params.p_due_at, '2026-11-02T15:00:00.000Z');
  });
  await run('31 Decision question is validated and only one pending question is offered', 'normal', async page => {
    await selectRequest(page); const question = page.getByRole('textbox', exact(c.decisionQuestion)); await question.fill('   ');
    const button = page.getByRole('button', exact(c.askDecision));
    if (!(await button.isDisabled())) { await button.click(); await visible(page, c.questionError); }
    assert.equal(await writeCount(page), 0);
    await question.fill('SYNTHETIC — menu kararı'); await page.getByRole('button', exact(c.askDecision)).click(); await visible(page, c.questionSaved);
    await visible(page, c.pendingDecision); assert.equal((await calls(page, 'crm_request_catering_decision_v1')).length, 1);
  }, '/staff/catering');
  await run('32 System resolves mocked form error without any email action', 'normal', async page => {
    await page.getByText(o.existingSystem, { exact: true }).click();
    await page.getByRole('button', exact(c.resolve)).first().click(); await visible(page, c.resolved);
    assert.deepEqual((await calls(page, 'crm_resolve_form_error_v1'))[0].params, { p_id: (await snapshot(page)).ids?.error || '99999999-9999-4999-8999-999999999999' });
    assert.equal((await snapshot(page)).calls.filter(call => /setup-test|send|email-draft/.test(call.name)).length, 0);
  }, '/staff/system');
  await run('33 Desktop synthetic three-column screenshot', 'normal', async page => {
    await selectCustomer(page); await screenshot(page, 'staff-customers-desktop');
    assert.ok(await page.locator('main').count());
  });
  await run('34 Mobile 375px is usable without whole-page overflow', 'normal', async page => {
    await tab(page, c.customers); await screenshot(page, 'staff-customers-mobile-list');
    await selectCustomer(page); await screenshot(page, 'staff-customers-mobile-record');
    const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(dimensions.scroll <= dimensions.viewport + 1, JSON.stringify(dimensions));
  }, '/staff/customers', { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  await run('35 Unsaved note, task and catering drafts survive tab changes', 'normal', async page => {
    await selectCustomer(page); await noteBox(page).fill('SYNTHETIC — not taslağı');
    await fillTask(page, 'SYNTHETIC — görev taslağı', 'Yücel', '2026-10-21T11:00');
    await tab(page, c.tasks); await tab(page, c.customers);
    assert.equal(await noteBox(page).inputValue(), 'SYNTHETIC — not taslağı');
    assert.equal(await page.getByRole('textbox', exact(c.taskTitle)).inputValue(), 'SYNTHETIC — görev taslağı');
    await selectRequest(page); const form = await requestForm(page);
    await form.getByRole('combobox', exact(c.status)).selectOption('contacted');
    await form.getByLabel(c.due, { exact: true }).fill('2026-10-21T11:00');
    await page.getByRole('textbox', exact(c.decisionQuestion)).fill('SYNTHETIC — karar taslağı');
    await tab(page, c.offers); await tab(page, c.catering);
    assert.equal(await form.getByRole('combobox', exact(c.status)).inputValue(), 'contacted');
    assert.equal(await form.getByLabel(c.due, { exact: true }).inputValue(), '2026-10-21T11:00');
    assert.equal(await page.getByRole('textbox', exact(c.decisionQuestion)).inputValue(), 'SYNTHETIC — karar taslağı');
    assert.equal(await writeCount(page), 0);
  });
  await run('36 Unknown task write stays blocked until the task source itself reads successfully', 'lost-save-response', async page => {
    await selectCustomer(page); await submitTask(page, 'SYNTHETIC — belirsiz görev'); await visible(page, c.unknownSave);
    const form = page.getByRole('textbox', exact(c.taskTitle)).locator('xpath=ancestor::form');
    assert.equal((await calls(page, 'crm_create_task_v1')).length, 1);
    await setMode(page, 'task-error'); await refresh(page);
    await page.waitForFunction(label => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === label && !button.disabled), c.refresh);
    assert.equal(await form.getByRole('button', exact(c.createTask)).isDisabled(), true);
    assert.equal(await page.getByRole('textbox', exact(c.taskTitle)).inputValue(), 'SYNTHETIC — belirsiz görev');
    assert.equal((await calls(page, 'crm_create_task_v1')).length, 1);
    await setMode(page, 'normal'); await refresh(page);
    await page.waitForFunction(label => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === label && !button.disabled), c.refresh);
    assert.equal(await form.getByRole('button', exact(c.createTask)).isDisabled(), false);
    await visible(page, 'SYNTHETIC — belirsiz görev');
    assert.equal((await calls(page, 'crm_create_task_v1')).length, 1);
  });
  await runOpsScenarios({ run, visible, screenshot, exact, snapshot, calls, setMode, c });
} finally {
  await browser.close(); await server.close();
  const report = { scope: 'Actual StaffPage with BrowserRouter; strict synthetic SDK/API and localhost-only browser. No live services or accounts.',
    startedAt: suiteStartedAt, finishedAt: new Date().toISOString(), browserExecutable: executablePath,
    passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length, checks, screenshots };
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write('RESULT ' + report.passed + '/' + checks.length + ' passed; report ' + path.join(output, 'results.json') + '\n');
  if (report.failed) process.exitCode = 1;
}
