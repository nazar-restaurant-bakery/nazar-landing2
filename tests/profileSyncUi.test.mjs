import assert from 'node:assert/strict';
import test from 'node:test';
import {
  validProfileSyncQueue, validProfileSyncRun, readProfileSyncQueue, runProfileSync,
  profileSyncShortId, profileSyncStatusLabel, profileSyncDate,
} from '../src/lib/profileSyncUi.ts';

const queue = (overrides = {}) => ({ code: 'ok', mode: 'mock', jobs: [{
  id: '11111111-2222-4333-8444-555555555555', profileId: null, status: 'retry', attempts: 2,
  nextAttemptAt: '2026-10-20T14:00:00Z', updatedAt: '2026-10-19T14:00:00Z',
  lastErrorCode: 'RATE_LIMITED',
}], counts: { queued: 0, running: 0, retry: 1, failed: 0, blocked: 0, succeeded: 0 }, ...overrides });
const result = (overrides = {}) => ({ code: 'ok', mode: 'mock', processed: 3,
  succeeded: 1, blocked: 1, retry: 1, failed: 0, ...overrides });
const reply = data => async () => new Response(JSON.stringify(data), { status: 200 });

test('queue accepts an explicit disabled connection and an actual empty active queue', () => {
  assert.equal(validProfileSyncQueue(queue()), true);
  assert.equal(validProfileSyncQueue(queue({ mode: 'disabled', jobs: [], counts: {} })), true);
  assert.equal(validProfileSyncQueue(queue({ jobs: [], counts: { queued: 0 } })), true);
  assert.equal(validProfileSyncQueue({ code: 'ok', jobs: [], counts: {} }), false);
});

test('reject malformed job data and unsafe provider text instead of presenting zero', () => {
  for (const patch of [
    { attempts: -1 }, { attempts: 1.5 }, { attempts: '2' }, { id: 'customer@example.invalid' },
    { lastErrorCode: 'Provider returned customer@example.invalid' }, { updatedAt: 'invalid' },
    { nextAttemptAt: undefined }, { profileId: '<script>' }, { status: 'provider raw text' },
  ]) assert.equal(validProfileSyncQueue(queue({ jobs: [{ ...queue().jobs[0], ...patch }] })), false);
  for (const counts of [{ queued: -1 }, { queued: '0' }, { 'customer@example.invalid': 1 },
    Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`status_${index}`, 0]))]) {
    assert.equal(validProfileSyncQueue(queue({ counts })), false);
  }
});

test('read uses only the fixed same-origin endpoint and provided bearer session', async () => {
  const calls = [];
  const response = await readProfileSyncQueue(async (...args) => {
    calls.push(args); return new Response(JSON.stringify(queue()));
  }, 'synthetic-token');
  assert.deepEqual(response, { status: 'ok', data: queue() });
  assert.equal(calls.length, 1);
  const [path, options] = calls[0];
  assert.equal(path, '/api/staff/profile-sync');
  assert.equal(options.method, 'GET');
  assert.equal(options.cache, 'no-store');
  assert.deepEqual(options.headers, { Authorization: 'Bearer synthetic-token' });
  assert.equal(options.body, undefined);
  assert.ok(options.signal instanceof AbortSignal);
});

test('manual command has one request with no client business or provider parameters', async () => {
  const calls = [];
  const response = await runProfileSync(async (...args) => {
    calls.push(args); return new Response(JSON.stringify(result()));
  }, 'synthetic-token');
  assert.deepEqual(response, { status: 'ok', data: result() });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/staff/profile-sync');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(calls[0][1].headers, { Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(calls[0][1].body), { action: 'run' });
});

test('manual command deadline permits the bounded server path without lengthening read timeout', async () => {
  const original = AbortSignal.timeout;
  const deadlines = [];
  AbortSignal.timeout = milliseconds => { deadlines.push(milliseconds); return new AbortController().signal; };
  try {
    await readProfileSyncQueue(reply(queue()), 'token');
    await runProfileSync(reply(result()), 'token');
    assert.deepEqual(deadlines, [20000, 45000]);
  } finally { AbortSignal.timeout = original; }
});

test('missing session makes no request; 401 and 403 always mean denied', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return new Response(null, { status: 403 }); };
  assert.deepEqual(await readProfileSyncQueue(fetcher, ''), { status: 'denied' });
  assert.deepEqual(await runProfileSync(fetcher, ''), { status: 'denied' });
  assert.equal(calls, 0);
  for (const operation of [readProfileSyncQueue, runProfileSync]) {
    for (const status of [401, 403]) assert.deepEqual(await operation(async () => new Response(null, { status }), 'token'), { status: 'denied' });
  }
});

test('read failures and malformed data remain unavailable, never an invented empty queue', async () => {
  for (const fetcher of [async () => new Response(null, { status: 503 }),
    async () => new Response('invalid json'), reply({ code: 'ok', mode: 'mock', jobs: [] }),
    async () => { throw new Error('synthetic network failure'); }]) {
    assert.deepEqual(await readProfileSyncQueue(fetcher, 'token'), { status: 'unavailable' });
  }
});

test('uncertain command is not automatically repeated and does not invent a success', async () => {
  let calls = 0;
  assert.deepEqual(await runProfileSync(async () => {
    calls += 1; throw new Error('response lost');
  }, 'token'), { status: 'unavailable' });
  assert.equal(calls, 1);
  assert.deepEqual(await runProfileSync(reply(result({ processed: -1 })), 'token'), { status: 'unavailable' });
});

test('run counters must be numeric, nonnegative integers with an explicit server mode', () => {
  assert.equal(validProfileSyncRun(result()), true);
  assert.equal(validProfileSyncRun(result({ mode: 'disabled', processed: 0 })), true);
  for (const patch of [{ mode: 'enabled' }, { code: 'other' }, { retry: '0' },
    { succeeded: -1 }, { blocked: 0.5 }, { failed: NaN }]) assert.equal(validProfileSyncRun(result(patch)), false);
});

test('display helpers use safe short ids, explicit unknown status and New York dates', () => {
  assert.equal(profileSyncShortId('11111111-2222-4333-8444-555555555555'), '11111111');
  assert.equal(profileSyncShortId(null), '—');
  assert.equal(profileSyncStatusLabel('retry'), 'Tekrar bekliyor');
  assert.equal(profileSyncStatusLabel('future_status'), 'Bilinmeyen durum');
  assert.equal(profileSyncDate(null), '—');
  assert.equal(profileSyncDate('bad date'), 'Geçersiz tarih');
  assert.match(profileSyncDate('2026-10-19T14:05:00Z'), /19.*2026.*10:05/);
});
