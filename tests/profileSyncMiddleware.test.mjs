import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest as middleware } from '../functions/api/_middleware.ts';
import { profileSyncHandler } from '../functions/api/staff/profile-sync.ts';

const origin = 'https://k5-synthetic.nazar-restaurant-website.pages.dev';
const database = 'https://abcdefghijklmnopqrst.supabase.co';
const bearer = 'Bearer synthetic_staff_token_for_local_only';
const environment = () => ({
  APP_ENV: 'isolated-test', TEST_SUPABASE_URL: database,
  TEST_BUSINESS_ID: '11111111-1111-4111-8111-111111111111',
  TEST_SUPABASE_SECRET_KEY: 'sb_secret_synthetic_test_only',
  SUPABASE_SECRET_KEY: 'sb_secret_synthetic_distinct_production_only',
  VITE_TEST_SUPABASE_ANON_KEY: 'sb_publishable_synthetic_test_only',
  VITE_SUPABASE_ANON_KEY: 'sb_publishable_synthetic_distinct_production_only',
  TEST_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  TEST_TURNSTILE_EXPECTED_HOSTNAME: new URL(origin).hostname,
  TEST_KLAVIYO_PROFILE_SYNC_MODE: 'mock', TEST_KLAVIYO_PROFILE_SYNC_ACCOUNT_ID: 'account_synthetic',
});

async function dispatch({ path = '/api/staff/profile-sync', method = 'GET', env = environment(), auth = true } = {}) {
  const calls = [];
  const handler = profileSyncHandler(async (input, options) => {
    const url = new URL(String(input));
    const name = url.pathname.split('/').at(-1);
    calls.push({ url, name });
    if (name === 'staff_business_authorized_v1') return Response.json(true);
    if (name === 'crm_profile_sync_queue_v1') return Response.json({ items: [], counts: { total: 0, queued: 0 } });
    if (name === 'klaviyo_profile_sync_enqueue_v1') return Response.json({ enqueued: 0 });
    if (name === 'klaviyo_profile_sync_claim_v1') return Response.json(null);
    throw Error('Unexpected synthetic RPC/provider path');
  });
  const request = new Request(origin + path, { method,
    headers: { Origin: origin, ...(auth ? { Authorization: bearer } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify({ action: 'run' }) } : {}),
  });
  let nextCalls = 0;
  const response = await middleware({ request, env, next: () => { nextCalls += 1; return handler({ request, env }); } });
  assert.ok(calls.every(call => call.url.origin === database), 'No Production/provider request is permitted.');
  return { response, body: await response.json(), calls, nextCalls };
}

test('exact configured mock route passes actual middleware into authorized read and manual handler', async () => {
  const read = await dispatch();
  assert.equal(read.nextCalls, 1); assert.equal(read.response.status, 200); assert.equal(read.body.mode, 'mock');
  assert.deepEqual(read.calls.map(call => call.name), ['staff_business_authorized_v1', 'crm_profile_sync_queue_v1']);
  const run = await dispatch({ method: 'POST' });
  assert.equal(run.response.status, 200); assert.equal(run.body.mode, 'mock'); assert.equal(run.body.processed, 0);
  assert.deepEqual(run.calls.map(call => call.name), ['staff_business_authorized_v1', 'klaviyo_profile_sync_enqueue_v1', 'klaviyo_profile_sync_claim_v1']);
});

test('exact route still requires staff bearer and complete isolated target configuration', async () => {
  const anonymous = await dispatch({ auth: false });
  assert.equal(anonymous.response.status, 401); assert.equal(anonymous.calls.length, 0);
  const env = environment(); delete env.TEST_SUPABASE_URL;
  const missing = await dispatch({ env });
  assert.equal(missing.response.status, 503); assert.equal(missing.calls.length, 0);
});

test('default disabled mode is readable but cannot enqueue, claim or call a provider', async () => {
  const env = environment(); delete env.TEST_KLAVIYO_PROFILE_SYNC_MODE;
  const read = await dispatch({ env });
  assert.equal(read.response.status, 200); assert.equal(read.body.mode, 'disabled');
  const run = await dispatch({ method: 'POST', env });
  assert.equal(run.response.status, 503);
  assert.deepEqual(run.calls.map(call => call.name), ['staff_business_authorized_v1']);
});

test('unknown, trailing and existing provider routes remain blocked before any handler', async () => {
  for (const path of ['/api/staff/profile-sync/', '/api/staff/profile-sync-extra', '/api/staff/unknown',
    '/api/staff/klaviyo-status', '/api/staff/clover-orders', '/api/staff/decision-email-draft', '/api/staff/form-error-setup-test']) {
    const result = await dispatch({ path });
    assert.equal(result.response.status, 503); assert.equal(result.body.code, 'isolated_provider_route_disabled');
    assert.equal(result.nextCalls, 0); assert.equal(result.calls.length, 0);
  }
});

test('Production middleware forwarding remains unchanged for K5 and existing routes', async () => {
  for (const path of ['/api/staff/profile-sync', '/api/staff/klaviyo-status', '/api/staff/clover-orders']) {
    let nextCalls = 0;
    const response = await middleware({ request: new Request('https://www.nazarrestaurantandbakery.com' + path),
      env: {}, next: async () => { nextCalls += 1; return new Response('synthetic unchanged downstream'); } });
    assert.equal(nextCalls, 1); assert.equal(response.status, 200); assert.equal(await response.text(), 'synthetic unchanged downstream');
  }
});
