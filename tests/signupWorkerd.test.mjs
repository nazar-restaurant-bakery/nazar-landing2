/** Runs the real Pages handler in workerd. All outbound requests terminate in
 * the synthetic interceptor below; no live API, credentials or customer data.
 * Uses already-installed tooling (NODE_PATH may point to Wrangler's modules).
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
  const runtimeRequire = createRequire(require.resolve('miniflare/package.json'));
  versions.miniflare = require('miniflare/package.json').version;
  versions.workerd = runtimeRequire('workerd/package.json').version;
  let esbuild;
  try { esbuild = require('esbuild'); }
  catch { esbuild = createRequire(require.resolve('wrangler/package.json'))('esbuild'); }
  build = esbuild.build;
  versions.esbuild = esbuild.version;
  if (!versions.miniflare.startsWith('5.') || !versions.workerd.startsWith('1.')
    || typeof convertV4MiniflareOptions !== 'function') toolingReason = 'Requires Miniflare 5/workerd 1 converter API';
} catch { toolingReason = 'Optional Miniflare 5/workerd 1/esbuild unavailable; runtime suite not executed'; }

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const production = 'https://www.nazarrestaurantandbakery.com';
const sandbox = 'https://synthetic-signup.nazar-restaurant-website.pages.dev';
const testDatabase = 'https://abcdefghijklmnopqrst.supabase.co';
let temp, mf;
let calls = [];
let scenario = {kind: 'success'};
const wrapper = `
import {onRequestPost} from './functions/api/signup.ts';
export default {async fetch(request,bindings){
  if(new URL(request.url).pathname==='/__constructor_probe'){
    try {new Request('https://synthetic.invalid/',{redirect:'error'});return Response.json({rejected:false});}
    catch(error){return Response.json({rejected:true,name:error.name,message:error.message});}
  }
  const isolated=new URL(request.url).hostname.endsWith('.pages.dev');
  const env={...bindings}; if(isolated)env.APP_ENV='isolated-test';
  const pending=[],logs=[];const saved=console.error;console.error=value=>logs.push(JSON.parse(value));
  try {
    const response=await onRequestPost({request,env,waitUntil:p=>pending.push(p)});
    await Promise.all(pending);
    return Response.json({body:await response.json(),logs},{status:response.status});
  } finally {console.error=saved;}
}};
`;

async function outbound(request) {
  const url = new URL(request.url);
  const record = {url: request.url, body: await request.text(), apikey: request.headers.get('apikey')};
  calls.push(record);
  if (url.href === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
    if (scenario.kind === 'redirect') return new WorkerResponse('{"success":true,"hostname":"example.com"}', {
      status: scenario.status, headers: {Location: 'https://never-follow.invalid/secret-trap'},
    });
    if (scenario.kind === 'malformed') return new WorkerResponse('PRIVATE_PROVIDER_BODY', {status: 200});
    if (scenario.kind === 'invalid-token') return WorkerResponse.json({success: false, 'error-codes': ['timeout-or-duplicate']});
    return WorkerResponse.json({success: true, hostname: scenario.kind === 'wrong-host' ? 'wrong.invalid' : scenario.hostname});
  }
  if ((url.origin === testDatabase || url.origin === 'https://khgczybubufouraqyrcj.supabase.co')
    && url.pathname === '/rest/v1/rpc/submit_signup_once') return new WorkerResponse(null, {status: 204});
  if (url.origin === 'https://khgczybubufouraqyrcj.supabase.co'
    && url.pathname === '/rest/v1/rpc/record_form_error_v1') return WorkerResponse.json(false);
  if (url.origin === 'https://khgczybubufouraqyrcj.supabase.co'
    && url.pathname === '/rest/v1/rpc/resolve_form_errors_v1') return WorkerResponse.json(null);
  // No fallback fetch/proxy: credential traps and every other host terminate here.
  return new WorkerResponse('DENIED_SYNTHETIC_OUTBOUND', {status: 418});
}

function submission(origin, kind) {
  return {
    method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'},
    body: JSON.stringify({kind, requestId: '22222222-2222-4222-8222-222222222222',
      name: 'PRIVATE_SYNTHETIC_NAME', email: 'synthetic-signup@example.invalid', phone: '',
      consentEmail: kind === 'vip', turnstileToken: 'PRIVATE_SYNTHETIC_TOKEN', extra: '', utm: null,
      ...(kind === 'catering' ? {eventDate: '2027-01-20', guests: '25', message: 'PRIVATE_SYNTHETIC_MESSAGE'} : {}),
    }),
  };
}

describe('signup native workerd redirect regression', {skip: toolingReason}, () => {
  before(async context => {
    context.diagnostic(`Local runtime ${JSON.stringify(versions)}; telemetry/cf metadata disabled; outbound intercepted`);
    temp = await mkdtemp(join(repo, '.signup-workerd-'));
    const bundle = await build({stdin: {contents: wrapper, sourcefile: 'synthetic-signup.ts', resolveDir: repo},
      bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent'});
    const scriptPath = join(temp, 'worker.mjs');
    await writeFile(scriptPath, bundle.outputFiles[0].contents);
    mf = new Miniflare(convertV4MiniflareOptions({cf: false, telemetry: {enabled: false}, modules: true,
      scriptPath, compatibilityDate: '2026-10-06', bindings: {
        SUPABASE_SECRET_KEY: 'sb_secret_PRIVATE_SYNTHETIC_GENERIC', TURNSTILE_SECRET_KEY: 'PRIVATE_SYNTHETIC_WIDGET_SECRET',
        TEST_SUPABASE_URL: testDatabase, TEST_BUSINESS_ID: '11111111-1111-4111-8111-111111111111',
        TEST_SUPABASE_SECRET_KEY: 'sb_secret_PRIVATE_SYNTHETIC_TEST',
        TEST_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
        TEST_TURNSTILE_EXPECTED_HOSTNAME: 'example.com',
      }, outboundService: outbound}));
    await mf.ready;
  });
  beforeEach(() => { calls = []; scenario = {kind: 'success'}; });
  after(async () => {
    await mf?.dispose();
    if (temp) {
      const target = await realpath(temp), child = relative(await realpath(repo), target);
      assert.ok(child.startsWith('.signup-workerd-') && !child.includes(sep));
      await rm(target, {recursive: true, force: true});
    }
  });

  test('runtime rejects redirect:error at Request construction before any outbound call', async () => {
    const response = await mf.dispatchFetch(sandbox + '/__constructor_probe');
    const result = await response.json();
    assert.equal(result.rejected, true);
    assert.equal(result.name, 'TypeError');
    assert.match(result.message, /Invalid redirect value/);
    assert.equal(calls.length, 0);
  });

  for (const origin of [sandbox, production]) for (const kind of ['vip', 'catering']) {
    const label = `${origin === sandbox ? 'isolated' : 'production'} ${kind}`;
    test(`${label}: valid verification reaches only the expected synthetic DB once`, async () => {
      scenario.hostname = origin === sandbox ? 'example.com' : new URL(origin).hostname;
      const response = await mf.dispatchFetch(origin + '/api/signup', submission(origin, kind));
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.body.code, 'accepted');
      assert.equal(calls.length, origin === sandbox ? 2 : 3); // existing production error-resolution RPC
      assert.equal(calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
      assert.equal(calls[1].url, (origin === sandbox ? testDatabase : 'https://khgczybubufouraqyrcj.supabase.co') + '/rest/v1/rpc/submit_signup_once');
      assert.equal(calls[1].apikey, origin === sandbox ? 'sb_secret_PRIVATE_SYNTHETIC_TEST' : 'sb_secret_PRIVATE_SYNTHETIC_GENERIC');
      if (origin === production) assert.ok(calls[2].url.endsWith('/resolve_form_errors_v1'));
      assert.deepEqual(result.logs, []);
    });

    for (const status of [301, 302, 303, 307, 308]) test(`${label}: ${status} never follows Location or saves signup`, async () => {
      scenario = {kind: 'redirect', status};
      const response = await mf.dispatchFetch(origin + '/api/signup', submission(origin, kind));
      const result = await response.json();
      assert.equal(response.status, 503);
      assert.equal(result.body.code, 'unavailable');
      assert.match(result.body.error_id, /^[0-9a-f-]{36}$/);
      assert.equal(calls.filter(call => call.url.endsWith('/siteverify')).length, 1);
      assert.ok(!calls.some(call => call.url.includes('never-follow.invalid') || call.url.endsWith('/submit_signup_once')));
      assert.equal(result.logs[0].stage, 'challenge');
      assert.equal(result.logs[0].error_code, 'challenge_unavailable');
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|secret-trap/);
    });
  }

  for (const [kind, status] of [['invalid-token', 403], ['wrong-host', 403], ['malformed', 503]]) {
    test(`isolated VIP: ${kind} still fails closed without DB or mail`, async () => {
      scenario = {kind};
      const response = await mf.dispatchFetch(sandbox + '/api/signup', submission(sandbox, 'vip'));
      assert.equal(response.status, status);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    });
  }
});
