import test from 'node:test';
import assert from 'node:assert/strict';
import { OpsStore } from '../supabase/functions/ops-collect/store.ts';
import { projectUrl, NAZAR_PROJECT } from '../supabase/functions/ops-collect/contracts.ts';

test('explicit isolated deployment uses only its Auth and database endpoints', async () => {
  const ref = 's'.repeat(20), origin = `https://${ref}.supabase.co`;
  const seen = [];
  const store = new OpsStore({ OPS_PROJECT_REF: ref, SUPABASE_URL: origin, SUPABASE_ANON_KEY: 'synthetic', SUPABASE_SERVICE_ROLE_KEY: 'synthetic' }, async (address) => {
    const url = new URL(address); seen.push(url.href); assert.equal(url.origin, origin);
    return Response.json(url.pathname === '/auth/v1/user' ? { id: '11111111-1111-4111-8111-111111111111' } : true);
  });
  await store.authenticate('Bearer synthetic'); await store.reserveExternal();
  assert.equal(seen.length, 3); assert.equal(seen.some(url => url.startsWith(NAZAR_PROJECT)), false);
});

test('wrong deployment target fails before any Auth, RPC or Storage network call', async () => {
  let calls = 0;
  const env = { SUPABASE_URL: `https://${'s'.repeat(20)}.supabase.co`, SUPABASE_ANON_KEY: 'synthetic' };
  const store = new OpsStore(env, async () => { calls++; throw new Error('must not run'); });
  await assert.rejects(() => store.authenticate('Bearer synthetic'), /wrong_project_configuration/);
  assert.equal(calls, 0);
  assert.throws(() => projectUrl({ OPS_PROJECT_REF: '../foreign' }), /wrong_project_configuration/);
});
