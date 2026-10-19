import assert from 'node:assert/strict';
import test from 'node:test';
import { profileSyncHandler } from '../functions/api/staff/profile-sync.ts';

// Injected fetch only: these tests never connect to a hosted DB or provider.
const origin = 'https://k5-synthetic.nazar-restaurant-website.pages.dev';
const database = 'https://abcdefghijklmnopqrst.supabase.co';
const businessId = '11111111-1111-4111-8111-111111111111';
const customerId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333';
const leaseId = '44444444-4444-4444-8444-444444444444';
const bearer = 'Bearer synthetic_staff_token_for_local_only';
const environment = () => ({
  APP_ENV: 'isolated-test', TEST_SUPABASE_URL: database, TEST_BUSINESS_ID: businessId,
  TEST_SUPABASE_SECRET_KEY: 'sb_secret_synthetic_test_only',
  SUPABASE_SECRET_KEY: 'sb_secret_synthetic_distinct_production_only',
  VITE_TEST_SUPABASE_ANON_KEY: 'sb_publishable_synthetic_test_only',
  VITE_SUPABASE_ANON_KEY: 'sb_publishable_synthetic_distinct_production_only',
  TEST_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  TEST_TURNSTILE_EXPECTED_HOSTNAME: new URL(origin).hostname,
  TEST_KLAVIYO_PROFILE_SYNC_MODE: 'mock', TEST_KLAVIYO_PROFILE_SYNC_ACCOUNT_ID: 'account_synthetic',
});
const queue = () => ({ items: [{ jobId, customerId, account: 'account_synthetic',
  status: 'retry', attempts: 2, updatedAt: '2026-10-19T14:05:00Z',
  nextAttemptAt: '2026-10-20T14:00:00Z', lastErrorCode: 'provider_rate_limited' }],
  counts: { queued: 0, running: 0, retry: 1, succeeded: 0, failed: 0, blocked: 0 } });
const context = () => ({ eligible: true, jobId, businessId, customerId, account: 'account_synthetic',
  profile: { email: 'synthetic@example.invalid', name: 'INTERNAL SYNTHETIC', source: 'website_vip_page',
    createdAt: '2026-10-18T12:00:00Z', utm: { utm_source: 'synthetic' }, tags: ['synthetic'] },
  eligibility: { emailStatus: 'subscribed', isTest: false, suppressedAt: null } });

function harness(overrides = {}) {
  const h = { env: environment(), auth: true, queue: queue(), claim: {
    jobId, leaseId, attempt: 1, leaseExpiresAt: '2099-01-01T00:00:00Z',
  }, context: context(), calls: [], contextReads: 0, finishReads: 0, ...overrides };
  const handler = profileSyncHandler(async (input, options) => {
    const url = new URL(String(input));
    const name = url.pathname.split('/').at(-1);
    const body = JSON.parse(options.body);
    h.calls.push({ url, name, body, options });
    if (name === 'crm_staff_authorized_v1') {
      if (h.authStatus) return new Response(JSON.stringify({ code: 'forbidden' }), { status: h.authStatus });
      return Response.json(h.auth);
    }
    if (name === 'crm_profile_sync_queue_v1') {
      if (h.queueThrow) throw Error('synthetic private queue detail');
      return h.queueStatus ? new Response(JSON.stringify({ code: 'private_error' }), { status: h.queueStatus }) : Response.json(h.queue);
    }
    if (name === 'klaviyo_profile_sync_enqueue_v1') return Response.json({ enqueued: 1 });
    if (name === 'klaviyo_profile_sync_claim_v1') return Response.json(h.claim);
    if (name === 'klaviyo_profile_sync_context_v1') {
      h.contextReads += 1;
      return Response.json(typeof h.context === 'function' ? h.context(h.contextReads) : h.context);
    }
    if (name === 'klaviyo_profile_sync_finish_v1') {
      h.finishReads += 1;
      if (h.finishThrow) throw Error('synthetic private lost receipt key_synthetic');
      if (h.finishBody !== undefined) return Response.json(h.finishBody);
      return Response.json({ status: body.p_outcome.status === 'provider_blocked' ? 'blocked' : body.p_outcome.status });
    }
    throw Error('Unexpected synthetic RPC');
  });
  h.run = async ({ method = 'GET', body, headers = {}, auth = bearer, originHeader = origin } = {}) => {
    const requestHeaders = { ...(auth === null ? {} : { Authorization: auth }),
      ...(originHeader === null ? {} : { Origin: originHeader }),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers };
    const requestBody = method === 'POST' ? typeof body === 'string' ? body : JSON.stringify(body ?? { action: 'run' }) : undefined;
    const response = await handler({ request: new Request(origin + '/api/staff/profile-sync', {
      method, headers: requestHeaders, ...(requestBody === undefined ? {} : { body: requestBody }),
    }), env: h.env });
    // An assertion thrown inside injected fetch could otherwise be sanitized by
    // the production handler; validate the complete request trace afterwards.
    for (const call of h.calls) {
      assert.equal(call.url.origin, database, 'No external/provider or Production request is allowed.');
      assert.ok(['crm_staff_authorized_v1', 'crm_profile_sync_queue_v1', 'klaviyo_profile_sync_enqueue_v1',
        'klaviyo_profile_sync_claim_v1', 'klaviyo_profile_sync_context_v1', 'klaviyo_profile_sync_finish_v1'].includes(call.name));
      assert.equal(call.options.method, 'POST');
      assert.equal(call.options.redirect, 'error');
      const staff = call.name.startsWith('crm_');
      assert.equal(call.options.headers.apikey, staff ? h.env.VITE_TEST_SUPABASE_ANON_KEY : h.env.TEST_SUPABASE_SECRET_KEY);
      assert.equal(call.options.headers.Authorization, staff ? auth : undefined);
    }
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    const result = await response.json();
    assert.doesNotMatch(JSON.stringify(result), /key_synthetic|synthetic@example|INTERNAL SYNTHETIC|sb_secret_|private queue detail/);
    return { response, body: result };
  };
  return h;
}

test('missing or malformed bearer and unsupported method stop before any RPC', async () => {
  for (const auth of [null, '', 'Bearer short', 'Basic synthetic_staff_token_for_local_only']) {
    const h = harness(); const { response } = await h.run({ auth });
    assert.equal(response.status, 401); assert.equal(h.calls.length, 0);
  }
  const h = harness(); assert.equal((await h.run({ method: 'DELETE' })).response.status, 405);
  assert.equal(h.calls.length, 0);
});

test('POST missing or foreign Origin, and foreign GET Origin, stop before authorization', async () => {
  for (const options of [{ method: 'POST', originHeader: null }, { method: 'POST', originHeader: 'https://foreign.invalid' },
    { method: 'GET', originHeader: 'https://foreign.invalid' }]) {
    const h = harness(); assert.equal((await h.run(options)).response.status, 403); assert.equal(h.calls.length, 0);
  }
  const h = harness(); assert.equal((await h.run({ originHeader: null })).response.status, 200);
});

test('unauthorized staff and rejected staff session never read queue or enqueue jobs', async () => {
  for (const method of ['GET', 'POST']) {
    const h = harness({ auth: false }); const result = await h.run({ method });
    assert.equal(result.response.status, 403); assert.deepEqual(h.calls.map(call => call.name), ['crm_staff_authorized_v1']);
  }
  for (const authStatus of [401, 403]) {
    const h = harness({ authStatus }); assert.equal((await h.run()).response.status, authStatus);
    assert.equal(h.calls.length, 1);
  }
});

test('Preview with incomplete test config cannot fall back to Production variables', async () => {
  const h = harness(); delete h.env.TEST_SUPABASE_URL;
  Object.assign(h.env, { KLAVIYO_PROFILE_SYNC_MODE: 'live', KLAVIYO_PROFILE_SYNC_ACCOUNT_ID: 'production_account',
    KLAVIYO_PROFILE_SYNC_KEY: 'pk_synthetic_production_only', KLAVIYO_PROFILE_SYNC_LIVE_APPROVAL_ID: 'production_approval' });
  assert.equal((await h.run()).response.status, 503); assert.equal(h.calls.length, 0);
});

test('disabled is an explicit connection state and refuses commands without acquiring a job', async () => {
  const h = harness(); delete h.env.TEST_KLAVIYO_PROFILE_SYNC_MODE;
  const read = await h.run(); assert.equal(read.response.status, 200); assert.equal(read.body.mode, 'disabled');
  const result = await h.run({ method: 'POST' }); assert.equal(result.response.status, 503);
  assert.equal(h.calls.filter(call => call.name.startsWith('klaviyo_')).length, 0);
});

test('queue returns safe uppercase error code and short UI contract without customer/account fields', async () => {
  const h = harness(); const { response, body } = await h.run();
  assert.equal(response.status, 200); assert.equal(body.mode, 'mock'); assert.equal(body.jobs.length, 1);
  assert.deepEqual(body.jobs[0], { id: jobId, status: 'retry', attempts: 2,
    updatedAt: '2026-10-19T14:05:00Z', nextAttemptAt: '2026-10-20T14:00:00Z',
    lastErrorCode: 'PROVIDER_RATE_LIMITED', profileId: null });
  assert.equal(body.jobs[0].customerId, undefined); assert.equal(body.jobs[0].account, undefined);
  assert.deepEqual(h.calls.map(call => call.name), ['crm_staff_authorized_v1', 'crm_profile_sync_queue_v1']);
  assert.deepEqual(h.calls[1].body, { p_business_id: businessId });
});

test('GET fetch failure, malformed queue and unsafe raw error never become an empty success', async () => {
  const malformed = [null, { items: [], counts: { queued: -1 } }, { items: [{ ...queue().items[0], lastErrorCode: 'raw provider text' }], counts: {} }];
  for (const overrides of [{ queueThrow: true }, { queueStatus: 503 }, ...malformed.map(value => ({ queue: value }))]) {
    const h = harness(overrides); const result = await h.run();
    assert.equal(result.response.status, 503); assert.equal(result.body.jobs, undefined); assert.equal(result.body.counts, undefined);
  }
});

test('POST accepts only action run; browser cannot choose account, customer or business', async () => {
  for (const body of [{ action: 'run', accountId: 'other' }, { action: 'run', customerId },
    { action: 'run', businessId }, { action: 'retry' }, {}, [], 'not JSON']) {
    const h = harness(); const result = await h.run({ method: 'POST', body });
    assert.equal(result.response.status, 400); assert.deepEqual(h.calls.map(call => call.name), ['crm_staff_authorized_v1']);
  }
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Length': '257' }]) {
    const h = harness(); const result = await h.run({ method: 'POST', headers });
    assert.ok([413, 415].includes(result.response.status)); assert.equal(h.calls.length, 1);
  }
});

test('one explicit mock command acquires one job and maps durable success to summary', async () => {
  const h = harness(); const result = await h.run({ method: 'POST' });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, { code: 'ok', mode: 'mock', processed: 1, succeeded: 1, blocked: 0, retry: 0, failed: 0 });
  assert.equal(h.calls.filter(call => call.name === 'klaviyo_profile_sync_claim_v1').length, 1);
  assert.equal(h.contextReads, 3, 'Initial snapshot and immediately before both mocked provider requests.');
  assert.equal(h.finishReads, 1);
  const parameters = { p_business_id: businessId, p_account: 'account_synthetic', p_customer_id: null };
  assert.deepEqual(h.calls.find(call => call.name === 'klaviyo_profile_sync_enqueue_v1').body, { ...parameters, p_limit: 100 });
  assert.deepEqual(h.calls.find(call => call.name === 'klaviyo_profile_sync_claim_v1').body, parameters);
  assert.deepEqual(h.calls.find(call => call.name === 'klaviyo_profile_sync_finish_v1').body,
    { p_job_id: jobId, p_lease_id: leaseId, p_outcome: { status: 'succeeded' } });
});

test('no claimed job is a verified zero command result without provider or context work', async () => {
  const h = harness({ claim: null }); const result = await h.run({ method: 'POST' });
  assert.equal(result.response.status, 200); assert.equal(result.body.processed, 0);
  assert.equal(h.contextReads, 0); assert.equal(h.finishReads, 0);
});

test('malformed lease never reaches context or finish and is unconfirmed', async () => {
  const h = harness({ claim: { jobId, leaseId, attempt: 7, leaseExpiresAt: '2099-01-01T00:00:00Z' } });
  const result = await h.run({ method: 'POST' }); assert.equal(result.response.status, 503);
  assert.equal(result.body.code, 'run_unconfirmed'); assert.equal(h.contextReads, 0); assert.equal(h.finishReads, 0);
});

test('atomically invalidated SQL context skips a second finish and maps blocked or queued outcome', async () => {
  for (const [reason, status, field] of [['customer_ineligible', 'blocked', 'blocked'], ['payload_changed', 'queued', 'retry']]) {
    const h = harness({ context: { eligible: false, reason, status } }); const result = await h.run({ method: 'POST' });
    assert.equal(result.response.status, 200); assert.equal(result.body[field], 1);
    assert.equal(h.contextReads, 1); assert.equal(h.finishReads, 0);
  }
  const h = harness({ context: { eligible: false, reason: 'unverified', status: 'blocked' } });
  assert.equal((await h.run({ method: 'POST' })).response.status, 503); assert.equal(h.finishReads, 0);
});

test('context becoming ineligible before provider POST stops and does not finish SQL twice', async () => {
  const h = harness({ context: read => read === 3 ? { eligible: false, reason: 'customer_ineligible', status: 'blocked' } : context() });
  const result = await h.run({ method: 'POST' }); assert.equal(result.response.status, 200);
  assert.equal(result.body.blocked, 1); assert.equal(h.contextReads, 3); assert.equal(h.finishReads, 0);
});

test('rate-limit and invalid local payload are persisted with allowlisted safe error mapping', async () => {
  const limited = harness(); limited.env.TEST_KLAVIYO_PROFILE_SYNC_MOCK_FAILURE = 'rate_limit';
  const retry = await limited.run({ method: 'POST' }); assert.equal(retry.response.status, 200); assert.equal(retry.body.retry, 1);
  const limitedOutcome = limited.calls.find(call => call.name === 'klaviyo_profile_sync_finish_v1').body.p_outcome;
  assert.equal(limitedOutcome.errorCode, 'provider_rate_limited'); assert.equal(limitedOutcome.retryAfterSeconds, 60);
  const invalid = context(); invalid.profile.email = 'invalid'; const bad = harness({ context: invalid });
  const failed = await bad.run({ method: 'POST' }); assert.equal(failed.body.failed, 1); assert.equal(bad.contextReads, 1);
  assert.equal(bad.calls.find(call => call.name === 'klaviyo_profile_sync_finish_v1').body.p_outcome.errorCode, 'customer_ineligible');
});

test('lost or malformed durable finish acknowledgement is 503, with no automatic second command', async () => {
  for (const overrides of [{ finishThrow: true }, { finishBody: { status: 'unknown' } }]) {
    const h = harness(overrides); const result = await h.run({ method: 'POST' });
    assert.equal(result.response.status, 503); assert.deepEqual(result.body, { code: 'run_unconfirmed' });
    assert.equal(h.finishReads, 1); assert.equal(h.contextReads, 3);
    assert.equal(h.calls.filter(call => call.name === 'klaviyo_profile_sync_claim_v1').length, 1);
  }
});
