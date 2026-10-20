import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { staffCopy as c } from '../src/lib/staffCopy.ts';

// Exercise the actual browser helper source without loading Vite/Supabase.
// Node does not resolve Vite's extensionless imports, so only its copy import
// is replaced; TypeScript's type-only import disappears when stripped.
const source = (await readFile(new URL('../src/lib/staffUi.ts', import.meta.url), 'utf8'))
  .replace('import { staffCopy as c } from "./staffCopy";', `const c = ${JSON.stringify(c)};`);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const { staffDateInput, staffInputIso, staffDisplayDate, staffTaskError, staffRequestError, customerName, activityTime, mergeOverview, staffDateGroup } = await import(moduleUrl);

test('New York wall-time conversion round-trips winter and summer independent of process timezone', () => {
  const cases = [
    ['2026-01-18T10:05', '2026-01-18T15:05:00.000Z'],
    ['2026-07-18T10:05', '2026-07-18T14:05:00.000Z'],
  ];
  for (const [wall, utc] of cases) {
    assert.equal(staffInputIso(wall), utc);
    assert.equal(staffDateInput(utc), wall);
  }
  const probe = `const h = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify([h.staffInputIso('2026-01-18T10:05'), h.staffInputIso('2026-07-18T10:05'), h.staffDateInput('2026-10-18T03:30:00Z')]));`;
  for (const timezone of ['Asia/Tokyo', 'Europe/Istanbul', 'UTC']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', env: { ...process.env, TZ: timezone } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [cases[0][1], cases[1][1], '2026-10-17T23:30']);
  }
});

test('nonexistent DST wall time and malformed input are rejected without moving a deadline', () => {
  assert.equal(staffInputIso('2026-03-08T02:30'), null);
  for (const input of ['', 'broken', '2026-02-30T10:00', '2026-13-01T10:00', '2026-10-18T24:00', '2026-10-18T10:60', '2026-10-18', '2026-10-18T10:00:00', '2026-10-18T10:00Z']) {
    assert.equal(staffInputIso(input), null, input);
  }
  // A repeated fall-back hour must retain its requested local date/time.
  const fold = staffInputIso('2026-11-01T01:30');
  assert.ok(fold);
  assert.equal(staffDateInput(fold), '2026-11-01T01:30');
  assert.equal(staffDateInput('broken'), '');
  assert.equal(staffDateInput(null), '');
});

test('calendar-only event dates never shift to the prior day and invalid dates remain visible', () => {
  assert.equal(staffDisplayDate('2026-10-18'), '18 Eki 2026');
  assert.equal(staffDisplayDate('2026-01-01'), '1 Oca 2026');
  assert.equal(staffDisplayDate('2026-10-18T03:30:00Z'), '17 Eki 2026 23:30');
  for (const value of ['broken', '2026-02-30', '2026-13-01']) assert.equal(staffDisplayDate(value), c.invalidDate);
  assert.equal(staffDisplayDate(null), '—');
  assert.equal(staffDisplayDate(undefined), '—');
});

test('field validation preserves existing past-date and closed-request rules', () => {
  assert.equal(staffTaskError('Call back', 'Talip', '2020-01-01T10:00'), null);
  assert.equal(staffRequestError('closed', 'Yücel', ''), null);
  assert.equal(staffRequestError('new', 'Talip', '2020-01-01T10:00'), null);
  assert.equal(staffTaskError(' ', 'Talip', '2026-10-18T10:00'), c.titleError);
  assert.equal(staffTaskError('x'.repeat(301), 'Talip', '2026-10-18T10:00'), c.titleError);
  assert.equal(staffTaskError('Task', ' ', '2026-10-18T10:00'), c.ownerError);
  assert.equal(staffTaskError('Task', 'x'.repeat(101), '2026-10-18T10:00'), c.ownerError);
  assert.equal(staffTaskError('Task', 'Other', '2026-03-08T02:30'), c.dueError);
  assert.equal(staffRequestError('new', 'Talip', ''), c.followupRequired);
  assert.equal(staffRequestError('new', ' ', '2026-10-18T10:00'), c.ownerError);
  assert.equal(staffRequestError('invented', 'Talip', ''), c.statusError);
  assert.equal(staffRequestError('closed', 'Talip', 'not a date'), c.dueError);
});

const customer = (id, overrides = {}) => ({ id, name: null, email: null, phone: null, email_status: 'not_subscribed', created_at: '2026-10-01T12:00:00Z', signup_count: 1, vip_signup_count: 0, kevin_signup_count: 0, last_signup_at: '2026-10-01T12:00:00Z', last_source: 'website', recent_signups: [], notes: [], ...overrides });
const request = (id, customer_id, overrides = {}) => ({ id, customer_id, name: null, email: null, phone: null, event_date: null, guests: null, message: null, status: 'new', assigned_to: null, follow_up_at: null, created_at: '2026-10-02T12:00:00Z', ...overrides });

test('combined real/test view retains one shared customer, deduplicates shared notes, and leaves both input payloads unchanged', () => {
  const sharedNote = { id: 'shared-note', body: 'Synthetic shared staff note', created_at: '2026-10-03T12:00:00Z' };
  const real = { customers: [customer('mixed', { name: 'Synthetic real contact', signup_count: 2, vip_signup_count: 1, notes: [sharedNote], recent_signups: [{ id: 'real-signup', source: 'vip', campaign: null, created_at: '2026-10-01T12:00:00Z' }] })], requests: [request('same-request', 'mixed')] };
  const internal = { customers: [customer('mixed', { name: 'Synthetic test alias', last_signup_at: '2026-10-05T12:00:00Z', last_source: 'internal', signup_count: 1, kevin_signup_count: 1, notes: [sharedNote, { id: 'test-note', body: 'Synthetic note', created_at: '2026-10-05T12:00:00Z' }], recent_signups: [{ id: 'test-signup', source: 'internal', campaign: null, created_at: '2026-10-05T12:00:00Z' }] }), customer('test-only')], requests: [request('same-request', 'mixed'), request('test-request', 'test-only')] };
  const before = structuredClone([real, internal]);
  const combined = mergeOverview(real, internal);
  assert.equal(combined.customers.length, 2);
  assert.equal(combined.requests.length, 2);
  const mixed = combined.customers.find(item => item.id === 'mixed');
  assert.equal(mixed.name, 'Synthetic real contact');
  assert.equal(mixed.last_source, 'internal');
  assert.equal(mixed.last_signup_at, '2026-10-05T12:00:00Z');
  assert.deepEqual([mixed.signup_count, mixed.vip_signup_count, mixed.kevin_signup_count], [3, 1, 1]);
  assert.deepEqual(mixed.notes.map(item => item.id), ['shared-note', 'test-note']);
  assert.deepEqual(mixed.recent_signups.map(item => item.id), ['real-signup', 'test-signup']);
  assert.deepEqual([real, internal], before);
  assert.deepEqual(mergeOverview(real, { customers: [], requests: [] }), real);
});

test('customer labels use available contact identity without inventing a person', () => {
  assert.equal(customerName(customer('one', { name: '  Synthetic Person  ', email: 'test@example.invalid' })), 'Synthetic Person');
  assert.equal(customerName(customer('one', { name: ' ', email: 'test@example.invalid' })), 'test@example.invalid');
  assert.equal(customerName(customer('one', { phone: 'TEST-PHONE' })), 'TEST-PHONE');
  assert.equal(customerName(customer('one')), c.noName);
});

test('last known activity ignores malformed dates and another customer’s request', () => {
  const profile = customer('one', { last_signup_at: 'broken', notes: [{ id: 'note', body: 'Test', created_at: '2026-10-04T12:00:00Z' }] });
  const overview = { customers: [profile], requests: [request('one-request', 'one', { created_at: '2026-10-05T12:00:00Z' }), request('other-request', 'other', { created_at: '2026-12-01T12:00:00Z' })] };
  assert.equal(activityTime(profile, overview), Date.parse('2026-10-05T12:00:00Z'));
  assert.equal(activityTime(customer('empty', { created_at: 'broken', last_signup_at: null }), { customers: [], requests: [] }), 0);
});

test('task groups use New York calendar boundaries and Sunday week end', () => {
  const monday = new Date('2026-10-19T12:00:00Z'); // Monday, 08:00 New York.
  assert.equal(staffDateGroup('2026-10-19T11:59:00Z', monday), 'overdue');
  assert.equal(staffDateGroup('2026-10-19T12:00:00Z', monday), 'today');
  assert.equal(staffDateGroup('2026-10-20T03:30:00Z', monday), 'today'); // 23:30 Monday.
  assert.equal(staffDateGroup('2026-10-26T03:59:00Z', monday), 'thisWeek'); // Sunday 23:59.
  assert.equal(staffDateGroup('2026-10-26T04:00:00Z', monday), 'later'); // Monday 00:00.
  assert.equal(staffDateGroup('2020-01-01T15:00:00Z', monday), 'overdue');
  for (const value of [null, '', 'broken']) assert.equal(staffDateGroup(value, monday), 'undated');
  const sunday = new Date('2026-10-18T18:00:00Z');
  assert.equal(staffDateGroup('2026-10-19T04:00:00Z', sunday), 'later');
});
