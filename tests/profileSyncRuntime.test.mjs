import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  liveProfileProvider, mockProfileProvider, profileSyncConfig, profileSyncRpc, RpcUnavailable,
} from '../functions/_lib/profileSyncRuntime.ts';
import {KLAVIYO_REVISION} from '../functions/_lib/klaviyoProfileSync.ts';
import {
  PRODUCTION_SUPABASE_URL, PRODUCTION_BUSINESS_ID, TEST_TURNSTILE_SECRET_KEY,
} from '../src/lib/deploymentEnvironment.ts';

// Every credential, account, identity and HTTP response in this file is synthetic.
// No test calls global fetch: only the explicitly injected recorder is used.
const previewHost = 'synthetic-k5.nazar-restaurant-website.pages.dev';
const productionHost = 'www.nazarrestaurantandbakery.com';
const testUrl = 'https://abcdefghijklmnopqrst.supabase.co';
const testBusiness = '11111111-2222-3333-4444-555555555555';
const customerId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const email = 'synthetic@example.invalid';
const prodEnv = () => ({
  VITE_SUPABASE_ANON_KEY: 'sb_publishable_synthetic_prod',
  SUPABASE_SECRET_KEY: 'sb_secret_synthetic_prod',
  TURNSTILE_SECRET_KEY: 'synthetic_production_turnstile',
  KLAVIYO_PROFILE_SYNC_ACCOUNT_ID: 'synthetic_prod_account',
});
const previewEnv = () => ({
  ...prodEnv(), APP_ENV: 'isolated-test', TEST_SUPABASE_URL: testUrl,
  TEST_BUSINESS_ID: testBusiness, TEST_SUPABASE_SECRET_KEY: 'sb_secret_synthetic_test',
  VITE_TEST_SUPABASE_ANON_KEY: 'sb_publishable_synthetic_test',
  TEST_TURNSTILE_SECRET_KEY, TEST_TURNSTILE_EXPECTED_HOSTNAME: previewHost,
  TEST_KLAVIYO_PROFILE_SYNC_ACCOUNT_ID: 'synthetic_test_account',
});
const liveEnv = () => ({
  ...previewEnv(), TEST_KLAVIYO_PROFILE_SYNC_MODE: 'live',
  TEST_KLAVIYO_PROFILE_SYNC_KEY: 'pk_synthetic_test_private_key',
  TEST_KLAVIYO_PROFILE_SYNC_LIVE_APPROVAL_ID: 'synthetic-approval-01',
  TEST_KLAVIYO_PROFILE_SYNC_CUSTOMER_ID: customerId,
});
const liveConfig = () => profileSyncConfig(liveEnv(), previewHost);
const request = (method = 'GET') => {
  const url = new URL(method === 'GET' ? 'https://a.klaviyo.com/api/profiles' : 'https://a.klaviyo.com/api/profile-import');
  if (method === 'GET') {
    url.searchParams.set('filter', `equals(email,${JSON.stringify(email)})`);
    url.searchParams.set('additional-fields[profile]', 'subscriptions');
    url.searchParams.set('page[size]', '2');
  }
  return {
    accountId: 'synthetic_test_account', method, url: url.href,
    headers: {revision: KLAVIYO_REVISION, Accept: 'application/vnd.api+json',
      ...(method === 'POST' ? {'Content-Type': 'application/vnd.api+json'} : {})},
    ...(method === 'POST' ? {body: JSON.stringify({data: {type: 'profile', attributes: {
      email, properties: {crm_registered_at: '2026-10-19T10:00:00Z', crm_name: 'Synthetic'},
    }}})} : {}), signal: new AbortController().signal,
  };
};
function recorder(response = () => new Response(JSON.stringify({data: []}), {status: 200})) {
  const calls = [];
  return {calls, fetch: async (url, init) => {calls.push({url: String(url), init}); return response();}};
}
async function rejectedWithoutFetch(mutator) {
  const fake = recorder();
  const req = request();
  mutator(req);
  await assert.rejects(liveProfileProvider(liveConfig(), fake.fetch).request(req));
  assert.equal(fake.calls.length, 0);
}

test('provider sync is disabled by default, including otherwise configured Production and Preview', () => {
  for (const [env, host] of [[{}, productionHost], [prodEnv(), productionHost], [previewEnv(), previewHost]]) {
    assert.equal(profileSyncConfig(env, host).mode, 'disabled');
  }
  const production = profileSyncConfig(prodEnv(), productionHost);
  assert.equal(production.url, PRODUCTION_SUPABASE_URL);
  assert.equal(production.businessId, PRODUCTION_BUSINESS_ID);
  assert.equal(production.readable, true);
});

test('Preview uses only TEST targets and never falls back to complete Production configuration', () => {
  const good = profileSyncConfig({...previewEnv(), TEST_KLAVIYO_PROFILE_SYNC_MODE: 'mock'}, previewHost);
  assert.equal(good.mode, 'mock'); assert.equal(good.isolated, true);
  assert.equal(good.url, testUrl); assert.equal(good.businessId, testBusiness);
  assert.equal(good.publicKey, 'sb_publishable_synthetic_test');
  assert.equal(good.serviceKey, 'sb_secret_synthetic_test');
  for (const key of ['APP_ENV', 'TEST_SUPABASE_URL', 'TEST_BUSINESS_ID', 'TEST_SUPABASE_SECRET_KEY',
    'VITE_TEST_SUPABASE_ANON_KEY', 'TEST_TURNSTILE_SECRET_KEY', 'TEST_TURNSTILE_EXPECTED_HOSTNAME']) {
    const env = {...previewEnv(), TEST_KLAVIYO_PROFILE_SYNC_MODE: 'mock'}; delete env[key];
    const config = profileSyncConfig(env, previewHost);
    assert.equal(config.readable, false, key); assert.equal(config.mode, 'disabled', key);
    const privateTarget = [config.url, config.serviceKey];
    assert.ok(!privateTarget.includes(PRODUCTION_SUPABASE_URL), key);
    assert.ok(!privateTarget.includes(env.SUPABASE_SECRET_KEY), key);
  }
});

test('Preview rejects reused Production URLs, public keys, service keys and provider keys', () => {
  for (const override of [
    {TEST_SUPABASE_URL: PRODUCTION_SUPABASE_URL},
    {VITE_TEST_SUPABASE_ANON_KEY: prodEnv().VITE_SUPABASE_ANON_KEY},
    {TEST_SUPABASE_SECRET_KEY: prodEnv().SUPABASE_SECRET_KEY},
    {KLAVIYO_PROFILE_SYNC_KEY: 'pk_synthetic_test_private_key'},
  ]) assert.equal(profileSyncConfig({...liveEnv(), ...override}, previewHost).mode, 'disabled');
});

test('unknown modes, invalid account/service key and nonisolated mock cannot enable execution', () => {
  for (const override of [
    {TEST_KLAVIYO_PROFILE_SYNC_MODE: 'LIVE'}, {TEST_KLAVIYO_PROFILE_SYNC_MODE: 'enabled'},
    {TEST_KLAVIYO_PROFILE_SYNC_ACCOUNT_ID: '../other'}, {TEST_KLAVIYO_PROFILE_SYNC_ACCOUNT_ID: 'ab'},
    {TEST_SUPABASE_SECRET_KEY: 'wrong-key'},
  ]) assert.equal(profileSyncConfig({...liveEnv(), ...override}, previewHost).mode, 'disabled');
  assert.equal(profileSyncConfig({...prodEnv(), KLAVIYO_PROFILE_SYNC_MODE: 'mock'}, productionHost).mode, 'disabled');
});

test('live Preview requires explicit valid key, approval and exact customer; invalid nonempty IDs cannot widen scope', () => {
  const valid = liveConfig(); assert.equal(valid.mode, 'live'); assert.equal(valid.onlyCustomerId, customerId);
  for (const override of [
    {TEST_KLAVIYO_PROFILE_SYNC_KEY: ''}, {TEST_KLAVIYO_PROFILE_SYNC_KEY: 'pk_short'},
    {TEST_KLAVIYO_PROFILE_SYNC_LIVE_APPROVAL_ID: ''}, {TEST_KLAVIYO_PROFILE_SYNC_LIVE_APPROVAL_ID: 'bad approval'},
    {TEST_KLAVIYO_PROFILE_SYNC_CUSTOMER_ID: ''}, {TEST_KLAVIYO_PROFILE_SYNC_CUSTOMER_ID: 'not-a-uuid'},
    {TEST_KLAVIYO_PROFILE_SYNC_CUSTOMER_ID: ` ${customerId}`},
  ]) assert.equal(profileSyncConfig({...liveEnv(), ...override}, previewHost).mode, 'disabled');
  const prod = {...prodEnv(), KLAVIYO_PROFILE_SYNC_MODE: 'live',
    KLAVIYO_PROFILE_SYNC_KEY: 'pk_synthetic_production_key', KLAVIYO_PROFILE_SYNC_LIVE_APPROVAL_ID: 'synthetic-approval-02'};
  assert.equal(profileSyncConfig({...prod, KLAVIYO_PROFILE_SYNC_CUSTOMER_ID: 'not-a-uuid'}, productionHost).mode, 'disabled');
});

test('mock rate-limit injection is test scoped and does not select Production keys', async () => {
  const config = profileSyncConfig({...previewEnv(), TEST_KLAVIYO_PROFILE_SYNC_MODE: 'mock',
    TEST_KLAVIYO_PROFILE_SYNC_MOCK_FAILURE: 'rate_limit'}, previewHost);
  assert.equal(config.mockFailure, true); assert.equal(config.providerKey, '');
  assert.equal(profileSyncConfig({...prodEnv(), TEST_KLAVIYO_PROFILE_SYNC_MOCK_FAILURE: 'rate_limit'}, productionHost).mockFailure, false);
  assert.deepEqual(await mockProfileProvider(config.mockFailure).request(request()),
    {status: 429, body: null, headers: {'retry-after': '60'}});
});

test('RPC transport uses exact allowlisted target, staff bearer/public key and manual redirects', async () => {
  const fake = recorder(() => new Response('true', {status: 200}));
  const config = profileSyncConfig(previewEnv(), previewHost);
  const bearer = 'Bearer synthetic_staff_token';
  const scope = { p_business_id: testBusiness, p_operation: 'crm.read' };
  assert.equal(await profileSyncRpc(config, 'staff_business_authorized_v1', scope, bearer, fake.fetch), true);
  const sent = fake.calls[0];
  assert.equal(sent.url, `${testUrl}/rest/v1/rpc/staff_business_authorized_v1`);
  assert.equal(sent.init.method, 'POST'); assert.equal(sent.init.redirect, 'manual');
  assert.equal(sent.init.body, JSON.stringify(scope)); assert.ok(sent.init.signal instanceof AbortSignal);
  assert.deepEqual(sent.init.headers, {apikey: config.publicKey, Authorization: bearer, 'Content-Type': 'application/json'});
  assert.doesNotMatch(JSON.stringify(sent), /sb_secret_/);
});

test('service RPCs use the TEST service key only and cannot reach arbitrary names or an unconfigured target', async () => {
  const fake = recorder(() => new Response('{"eligible":false}', {status: 200}));
  const config = profileSyncConfig(previewEnv(), previewHost);
  await profileSyncRpc(config, 'klaviyo_profile_sync_context_v1', {p_job_id: customerId}, null, fake.fetch);
  assert.deepEqual(fake.calls[0].init.headers, {apikey: 'sb_secret_synthetic_test', 'Content-Type': 'application/json'});
  for (const [candidate, name] of [
    [config, 'submit_signup_once'], [config, 'crm_staff_authorized_v1'], [config, '../auth/v1/admin/users'],
    [{...config, readable: false}, 'klaviyo_profile_sync_context_v1'],
    [{...config, serviceKey: ''}, 'klaviyo_profile_sync_context_v1'],
  ]) await assert.rejects(profileSyncRpc(candidate, name, {}, null, fake.fetch), RpcUnavailable);
  assert.equal(fake.calls.length, 1);
});

test('RPC error bodies and malformed successes are never returned or echoed', async () => {
  for (const status of [301, 302, 303, 307, 308, 401, 403, 429, 503]) {
    let bodyReads = 0;
    const fake = recorder(() => ({ok: false, status, json: async () => {bodyReads++; return {private: email};}}));
    await assert.rejects(profileSyncRpc(profileSyncConfig(previewEnv(), previewHost), 'staff_business_authorized_v1', {}, 'Bearer synthetic', fake.fetch),
      error => error instanceof RpcUnavailable && error.status === status && error.message === 'database_unavailable');
    assert.equal(bodyReads, 0);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].init.redirect, 'manual');
  }
  const malformed = recorder(() => new Response('raw private data', {status: 200}));
  await assert.rejects(profileSyncRpc(profileSyncConfig(previewEnv(), previewHost), 'staff_business_authorized_v1', {}, 'Bearer synthetic', malformed.fetch),
    error => error instanceof RpcUnavailable && error.message === 'database_unavailable');
});

test('live transport attaches its configured key only after all checks, preserving revision, body and abort signal', async () => {
  for (const method of ['GET', 'POST']) {
    const fake = recorder(); const req = request(method); const config = liveConfig();
    await liveProfileProvider(config, fake.fetch).request(req);
    const sent = fake.calls[0];
    assert.equal(sent.url, req.url); assert.equal(sent.init.method, method);
    assert.equal(sent.init.redirect, 'manual'); assert.equal(sent.init.signal, req.signal);
    assert.equal(sent.init.body, req.body);
    assert.equal(sent.init.headers.Authorization, `Klaviyo-API-Key ${config.providerKey}`);
    assert.equal(sent.init.headers.revision, KLAVIYO_REVISION);
    assert.equal(req.headers.Authorization, undefined);
    assert.deepEqual(Object.keys(sent.init.headers).sort(), [...Object.keys(req.headers), 'Authorization'].sort());
  }
});

test('disabled/mock/missing approval/invalid key and account switches cause zero provider HTTP calls', async () => {
  for (const override of [{mode: 'disabled'}, {mode: 'mock'}, {approvalId: ''}, {providerKey: 'invalid'}]) {
    const fake = recorder();
    await assert.rejects(liveProfileProvider({...liveConfig(), ...override}, fake.fetch).request(request()));
    assert.equal(fake.calls.length, 0);
  }
  await rejectedWithoutFetch(req => {req.accountId = 'other_synthetic_account';});
});

test('host, credentials, fragment, path, method, write query and pagination cannot bypass the endpoint allowlist', async () => {
  for (const url of [
    'https://a.klaviyo.com.evil.invalid/api/profiles', 'http://a.klaviyo.com/api/profiles',
    'https://synthetic@a.klaviyo.com/api/profiles', 'https://a.klaviyo.com/api/profiles#other',
    'https://a.klaviyo.com/api/profiles/other', 'https://a.klaviyo.com/api/lists',
    'https://a.klaviyo.com/api/events', 'https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs',
    'https://a.klaviyo.com/api/profile-suppression-bulk-delete-jobs',
  ]) await rejectedWithoutFetch(req => {req.url = url;});
  await rejectedWithoutFetch(req => {req.method = 'PATCH';});
  await rejectedWithoutFetch(req => {const url = new URL(req.url); url.searchParams.set('page[cursor]', 'unexpected'); req.url = url.href;});
  await rejectedWithoutFetch(req => {Object.assign(req, request('POST')); req.url += '?unexpected=true';});
});

test('extra headers, forwarded credentials and alternate revisions are rejected before HTTP', async () => {
  for (const headers of [
    {Authorization: 'Bearer should_not_forward'}, {Cookie: 'private=synthetic'}, {'X-Account': 'other'},
    {revision: '2026-10-15'}, {revision: ''}, {Accept: 'text/plain'}, {'Content-Type': 'application/vnd.api+json'},
  ]) await rejectedWithoutFetch(req => {Object.assign(req.headers, headers);});
  await rejectedWithoutFetch(req => {Object.assign(req, request('POST')); req.headers['Content-Type'] = 'application/json';});
});

test('provider GET requires exact email filter, subscriptions read and bounded page size', async () => {
  for (const [name, value] of [['filter', 'equals(phone_number,"synthetic")'],
    ['additional-fields[profile]', 'predictive_analytics'], ['page[size]', '100']]) {
    await rejectedWithoutFetch(req => {const url = new URL(req.url); url.searchParams.set(name, value); req.url = url.href;});
  }
  await rejectedWithoutFetch(req => {req.body = '{}';});
});

test('write transport rejects subscription, suppression, contact expansion and nested property escapes', async () => {
  for (const change of [
    body => {body.data.attributes.subscriptions = {};},
    body => {body.data.attributes.suppression = [];},
    body => {body.data.attributes.phone_number = '+15555555555';},
    body => {body.data.attributes.properties.native_tags = ['unsafe'];},
    body => {body.data.attributes.properties.crm_tags = {subscriptions: 'unsafe'};},
    body => {body.data.attributes.properties.crm_utm = {suppression: 'unsafe'};},
    body => {body.extra = {};},
  ]) await rejectedWithoutFetch(req => {
    Object.assign(req, request('POST')); const body = JSON.parse(req.body); change(body); req.body = JSON.stringify(body);
  });
});

test('provider error bodies are never read or returned; only status and retry-after survive', async () => {
  for (const status of [301, 302, 303, 307, 308, 400, 401, 403, 409, 429, 503]) {
    let bodyReads = 0;
    const fake = recorder(() => ({ok: false, status, headers: new Headers({'retry-after': '60', location: 'https://evil.invalid'}),
      json: async () => {bodyReads++; return {errors: [`RAW key_private ${email}`]};}}));
    const result = await liveProfileProvider(liveConfig(), fake.fetch).request(request());
    assert.deepEqual(result, {status, body: null, headers: {'retry-after': '60'}});
    assert.equal(bodyReads, 0); assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].init.redirect, 'manual');
    assert.doesNotMatch(JSON.stringify(result), /RAW|key_private|synthetic@example|evil/);
  }
});

test('successful malformed provider JSON is reduced to null and cannot become raw text', async () => {
  const fake = recorder(() => new Response(`RAW key_private ${email}`, {status: 200}));
  const result = await liveProfileProvider(liveConfig(), fake.fetch).request(request());
  assert.deepEqual(result, {status: 200, body: null, headers: {'retry-after': ''}});
});

test('synthetic mock upsert is deterministic, idempotent by email and leaves consent NEVER_SUBSCRIBED', async () => {
  const provider = mockProfileProvider();
  const first = await provider.request(request('POST'));
  const again = await provider.request(request('POST'));
  const found = await provider.request(request());
  assert.equal(first.status, 201); assert.equal(again.status, 200);
  assert.equal(first.body.data.id, again.body.data.id);
  assert.deepEqual(found.body.data.map(profile => profile.id), [first.body.data.id]);
  const marketing = found.body.data[0].attributes.subscriptions.email.marketing;
  assert.equal(marketing.consent, 'NEVER_SUBSCRIBED'); assert.equal(marketing.can_receive_email_marketing, false);
});
