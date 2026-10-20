/** Real workerd regression: actual Pages handler/transport, synthetic outbound service.
 * No real network, Supabase/Auth account, Klaviyo profile, key or data is used.
 * Dependencies are already installed with Wrangler; this test never installs any.
 */
import assert from 'node:assert/strict';
import {after, before, beforeEach, describe, test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
let Miniflare, WorkerResponse, convertV4MiniflareOptions, build;
let toolingReason = false;
const versions = {};
try {
  ({Miniflare, Response: WorkerResponse, convertV4MiniflareOptions} = require('miniflare'));
  const miniflareRequire = createRequire(require.resolve('miniflare/package.json'));
  versions.miniflare = require('miniflare/package.json').version;
  versions.workerd = miniflareRequire('workerd/package.json').version;
  let esbuild;
  try {esbuild = require('esbuild');}
  catch {
    const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
    esbuild = wranglerRequire('esbuild');
  }
  build = esbuild.build;
  versions.esbuild = esbuild.version;
  if (!versions.miniflare.startsWith('5.') || !versions.workerd.startsWith('1.')
      || typeof convertV4MiniflareOptions !== 'function' || typeof build !== 'function') {
    toolingReason = `Optional workerd tooling incompatible: requires Miniflare 5 converter API/workerd 1; found ${JSON.stringify(versions)}`;
  }
} catch {
  toolingReason = 'Optional workerd tooling unavailable: requires installed Miniflare 5/workerd 1 and esbuild (direct or Wrangler nested); suite not executed';
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostname = 'synthetic-k5.nazar-restaurant-website.pages.dev';
const origin = `https://${hostname}`;
const databaseOrigin = 'https://abcdefghijklmnopqrst.supabase.co';
const bearer = 'Bearer synthetic_staff_token_1234567890';
const publicKey = 'sb_publishable_synthetic_preview';
const serviceKey = 'sb_secret_synthetic_preview';
const counts = {queued: 0, running: 0, retry: 0, succeeded: 0, failed: 0, blocked: 0};
let temp;
let mf;
let calls = [];
let scenario = {kind: 'success'};

const wrapper = `
import {profileSyncHandler} from './functions/api/staff/profile-sync.ts';
import {liveProfileProvider,profileSyncConfig} from './functions/_lib/profileSyncRuntime.ts';
import {KLAVIYO_REVISION} from './functions/_lib/klaviyoProfileSync.ts';
const handler=profileSyncHandler();
export default {async fetch(request,env){
  const url=new URL(request.url);
  // Test-only route exercises the actual provider transport inside workerd.
  // Its outbound service is synthetic and denies every unrecognized request.
  if(url.pathname==='/__synthetic_provider_probe'){
    const method=url.searchParams.get('method')==='POST'?'POST':'GET';
    const config=profileSyncConfig({...env,TEST_KLAVIYO_PROFILE_SYNC_MODE:'live',
      TEST_KLAVIYO_PROFILE_SYNC_KEY:'pk_synthetic_provider_private_key',
      TEST_KLAVIYO_PROFILE_SYNC_LIVE_APPROVAL_ID:'synthetic-approval-only',
      TEST_KLAVIYO_PROFILE_SYNC_CUSTOMER_ID:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'},url.hostname);
    const endpoint=new URL(method==='GET'?'https://a.klaviyo.com/api/profiles':'https://a.klaviyo.com/api/profile-import');
    const email='synthetic-profile@example.invalid';
    if(method==='GET'){
      endpoint.searchParams.set('filter','equals(email,'+JSON.stringify(email)+')');
      endpoint.searchParams.set('additional-fields[profile]','subscriptions');endpoint.searchParams.set('page[size]','2');
    }
    try{
      const response=await liveProfileProvider(config,fetch).request({accountId:'synthetic_preview_account',method,url:endpoint.href,
        headers:{revision:KLAVIYO_REVISION,Accept:'application/vnd.api+json',...(method==='POST'?{'Content-Type':'application/vnd.api+json'}:{})},
        ...(method==='POST'?{body:JSON.stringify({data:{type:'profile',attributes:{email,properties:{crm_registered_at:'2026-10-19T10:00:00Z'}}}})}:{}),
        signal:AbortSignal.timeout(4000)});
      return Response.json(response);
    }catch{return Response.json({code:'synthetic_probe_failed'},{status:503});}
  }
  return handler({request,env});
}};
`;

function redirectResponse(status) {
  return new WorkerResponse('RAW_SYNTHETIC_PRIVATE_ERROR', {
    status, headers: {Location: 'https://never-follow.invalid/credential-trap'},
  });
}

async function outbound(request) {
  const url = new URL(request.url);
  const record = {url: request.url, method: request.method,
    apikey: request.headers.get('apikey'), authorization: request.headers.get('authorization'), body: null};
  calls.push(record);
  if (url.origin === databaseOrigin && url.pathname.startsWith('/rest/v1/rpc/')) {
    record.body = await request.json();
    assert.equal(request.method, 'POST');
    const name = url.pathname.slice('/rest/v1/rpc/'.length);
    if (scenario.kind === 'rpc-redirect') return redirectResponse(scenario.status);
    if (name === 'staff_business_authorized_v1') return WorkerResponse.json(true);
    if (name === 'crm_profile_sync_queue_v1') return WorkerResponse.json({items: [], counts});
    if (name === 'klaviyo_profile_sync_enqueue_v1') return WorkerResponse.json({enqueued: 0, unchanged: 0});
    if (name === 'klaviyo_profile_sync_claim_v1') return WorkerResponse.json(null);
    throw new Error('UNEXPECTED_SYNTHETIC_RPC');
  }
  if (url.origin === 'https://a.klaviyo.com'
      && ((request.method === 'GET' && url.pathname === '/api/profiles')
        || (request.method === 'POST' && url.pathname === '/api/profile-import'))) {
    if (request.method === 'POST') record.body = await request.json();
    if (scenario.kind === 'provider-redirect') return redirectResponse(scenario.status);
    return WorkerResponse.json({data: []});
  }
  // This is an interceptor, never an HTTP proxy. A redirect or unexpected host
  // cannot escape to Node/global fetch or the public internet.
  return new WorkerResponse('SYNTHETIC_OUTBOUND_DENIED', {status: 418});
}

// These tools are deliberately not package.json dependencies. A clean checkout
// must report this whole group SKIPPED, rather than crash or claim it passed.
describe('profile sync native workerd regression', {skip: toolingReason}, () => {
before(async context => {
  context.diagnostic(`Optional local runtime versions: ${JSON.stringify(versions)}; cf metadata and telemetry disabled`);
  temp = await mkdtemp(join(repo, '.k5-workerd-regression-'));
  const bundled = await build({stdin: {contents: wrapper, sourcefile: 'synthetic-k5-worker.ts', resolveDir: repo},
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent'});
  const scriptPath = join(temp, 'worker.mjs');
  await writeFile(scriptPath, bundled.outputFiles[0].contents);
  mf = new Miniflare(convertV4MiniflareOptions({cf: false, telemetry: {enabled: false},
    modules: true, scriptPath, compatibilityDate: '2026-10-06',
    bindings: {
      APP_ENV: 'isolated-test', TEST_SUPABASE_URL: databaseOrigin,
      TEST_BUSINESS_ID: '11111111-2222-3333-4444-555555555555', TEST_SUPABASE_SECRET_KEY: serviceKey,
      VITE_TEST_SUPABASE_ANON_KEY: publicKey,
      TEST_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      TEST_TURNSTILE_EXPECTED_HOSTNAME: hostname,
      TEST_KLAVIYO_PROFILE_SYNC_MODE: 'mock', TEST_KLAVIYO_PROFILE_SYNC_ACCOUNT_ID: 'synthetic_preview_account',
    }, outboundService: outbound}));
  await mf.ready;
});

beforeEach(() => {calls = []; scenario = {kind: 'success'};});

after(async () => {
  await mf?.dispose();
  if (temp) {
    const resolved = await realpath(temp);
    const child = relative(await realpath(repo), resolved);
    // Verify the recursive cleanup target remains our specific temporary child.
    assert.ok(child.startsWith('.k5-workerd-regression-') && !child.includes(sep));
    await rm(resolved, {recursive: true, force: true});
  }
});

function names() {return calls.map(call => new URL(call.url).pathname.split('/').at(-1));}
function assertStaffRequest(call) {
  assert.equal(call.apikey, publicKey); assert.equal(call.authorization, bearer);
}

test('actual GET queue reaches synthetic Supabase in workerd and returns an empty authenticated queue', async () => {
  const response = await mf.dispatchFetch(`${origin}/api/staff/profile-sync`, {headers: {Authorization: bearer}});
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body, {code: 'ok', mode: 'mock', jobs: [], counts});
  assert.deepEqual(names(), ['staff_business_authorized_v1', 'crm_profile_sync_queue_v1']);
  calls.forEach(assertStaffRequest);
});

test('actual POST run reaches only synthetic auth/enqueue/claim and processes no profile when claim is null', async () => {
  const response = await mf.dispatchFetch(`${origin}/api/staff/profile-sync`, {method: 'POST',
    headers: {Authorization: bearer, Origin: origin, 'Content-Type': 'application/json'}, body: '{"action":"run"}'});
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body, {code: 'ok', mode: 'mock', processed: 0, succeeded: 0, blocked: 0, retry: 0, failed: 0});
  assert.deepEqual(names(), ['staff_business_authorized_v1', 'klaviyo_profile_sync_enqueue_v1', 'klaviyo_profile_sync_claim_v1']);
  assertStaffRequest(calls[0]);
  for (const call of calls.slice(1)) {
    assert.equal(call.apikey, serviceKey); assert.equal(call.authorization, null);
    assert.equal(call.body.p_business_id, '11111111-2222-3333-4444-555555555555');
    assert.equal(call.body.p_account, 'synthetic_preview_account'); assert.equal(call.body.p_customer_id, null);
  }
});

for (const status of [302, 307, 308]) {
  test(`RPC ${status} redirect is rejected in workerd without forwarding staff token to its Location`, async () => {
    scenario = {kind: 'rpc-redirect', status};
    const response = await mf.dispatchFetch(`${origin}/api/staff/profile-sync`, {headers: {Authorization: bearer}});
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.deepEqual(body, {code: 'connection_unavailable'});
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0].url).origin, databaseOrigin);
    assertStaffRequest(calls[0]);
    assert.doesNotMatch(JSON.stringify(body), /RAW|PRIVATE|credential-trap|never-follow/);
  });
  for (const method of ['GET', 'POST']) {
    test(`provider ${method} ${status} redirect is surfaced without body or following its Location in workerd`, async () => {
      scenario = {kind: 'provider-redirect', status};
      const response = await mf.dispatchFetch(`${origin}/__synthetic_provider_probe?method=${method}`);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.deepEqual(body, {status, body: null, headers: {'retry-after': ''}});
      assert.equal(calls.length, 1);
      assert.equal(new URL(calls[0].url).origin, 'https://a.klaviyo.com');
      assert.equal(calls[0].method, method);
      assert.equal(calls[0].authorization, 'Klaviyo-API-Key pk_synthetic_provider_private_key');
      assert.doesNotMatch(JSON.stringify(body), /RAW|PRIVATE|credential-trap|never-follow/);
    });
  }
}
});
