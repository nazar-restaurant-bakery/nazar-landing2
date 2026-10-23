import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { resolveBrowserEnvironment, PRODUCTION_SUPABASE_URL, PRODUCTION_BUSINESS_ID } from '../src/lib/deploymentEnvironment.ts';

const source = readFileSync(new URL('../src/lib/crmData.ts', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../src/lib/staffSupabase.ts', import.meta.url), 'utf8');
const browser = { VITE_APP_ENV: 'isolated-test', VITE_TEST_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  VITE_TEST_SUPABASE_ANON_KEY: 'sb_publishable_synthetic', VITE_TEST_BUSINESS_ID: '11111111-1111-4111-8111-111111111111' };
const production = { VITE_SUPABASE_URL: PRODUCTION_SUPABASE_URL, VITE_SUPABASE_ANON_KEY: 'sb_publishable_production_synthetic', VITE_NAZAR_BUSINESS_ID: PRODUCTION_BUSINESS_ID };
async function load(env, hostname) {
  const deployment = resolveBrowserEnvironment(env, hostname);
  // Execute both real modules, replacing only the Supabase SDK/network boundary.
  let js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  js = js.replace(/^import .* from [^;]+;\s*$/gm, '');
  const clientJs = ts.transpileModule(clientSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/^import .* from [^;]+;\s*$/gm, '').replace(/export /g, '').replace(/\bstaffClient\b/g, 'cachedStaffClient');
  const module = await import('data:text/javascript,' + encodeURIComponent(`
    const browserDeployment=${JSON.stringify(deployment)};
    const NAZAR_BUSINESS_ID=browserDeployment.businessId;
    const createClient=(url,key)=>{globalThis.__staffIsolationFixture.targets.push({url,key});return globalThis.__staffIsolationFixture.client;};
    ${clientJs}
    const safeCrmRequest=fn=>fn();
    ${js}
  `) + '#' + crypto.randomUUID());
  return { module, deployment };
}
test('configured Sandbox enables the real CRM data module on the isolated target', async () => {
  globalThis.__staffIsolationFixture = { targets: [], client: { rpc: async () => ({ data: true, error: null }) } };
  try {
    const result = await load(browser, 'nazar-catering-sandbox.pages.dev');
    assert.equal(result.deployment.configured, true);
    assert.equal(result.module.staffClient, globalThis.__staffIsolationFixture.client);
    assert.equal(result.deployment.url, browser.VITE_TEST_SUPABASE_URL);
    assert.deepEqual(globalThis.__staffIsolationFixture.targets, [{ url: browser.VITE_TEST_SUPABASE_URL, key: browser.VITE_TEST_SUPABASE_ANON_KEY }]);
  } finally { delete globalThis.__staffIsolationFixture; }
});
test('missing, Production or invalid target stays closed in Sandbox', async () => {
  for (const env of [{}, production, { ...browser, VITE_TEST_SUPABASE_URL: PRODUCTION_SUPABASE_URL }, { ...browser, VITE_TEST_BUSINESS_ID: '' }]) {
    assert.equal(resolveBrowserEnvironment(env, 'nazar-catering-sandbox.pages.dev').configured, false);
    globalThis.__staffIsolationFixture = { targets: [], client: {} };
    try { assert.equal((await load(env, 'nazar-catering-sandbox.pages.dev')).module.staffClient, null); }
    finally { delete globalThis.__staffIsolationFixture; }
  }
});
test('Production uses the same existing validated client', async () => {
  globalThis.__staffIsolationFixture = { targets: [], client: {} };
  try {
    const result = await load(production, 'www.nazarrestaurantandbakery.com');
    assert.equal(result.deployment.isolated, false); assert.equal(result.deployment.configured, true);
    assert.equal(result.module.staffClient, globalThis.__staffIsolationFixture.client);
  } finally { delete globalThis.__staffIsolationFixture; }
});
