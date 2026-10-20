import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshot, collectOrders, orderPullConfig } from '../../functions/_lib/cloverOrderPull.ts';
import { cloverOrderPullHandler } from '../../functions/api/staff/clover-order-pull.ts';

const order = (id = 'ORDER123456') => ({ id, createdTime: Date.now(), orderType: { id: 'ONLINE12345' },
  total: 4500, lineItems: { elements: [{ id: 'ITEM123456', name: 'Meal', price: 4500, quantity: 1 }] },
  payments: { elements: [{ id: 'PAY1234567', amount: 4500, result: 'SUCCESS' }] },
  refunds: { elements: [] }, customers: { elements: [{ emailAddress: 'Buyer@Example.invalid', phoneNumber: '2035550111' }] } });
const env = { APP_ENV: 'isolated-test', TEST_SUPABASE_URL: 'https://uxiseddbeszklkrvysxf.supabase.co',
  TEST_BUSINESS_ID: '11111111-1111-4111-8111-111111111111', TEST_SUPABASE_SECRET_KEY: 'sb_secret_test_only',
  TEST_TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA', TEST_TURNSTILE_EXPECTED_HOSTNAME: 'preview.pages.dev',
  VITE_TEST_SUPABASE_ANON_KEY: 'sb_publishable_test_only', TEST_CLOVER_MERCHANT_ID: 'MERCHANT123',
  TEST_CLOVER_ORDERS_ACCESS_TOKEN: 'testtokenonly123', TEST_CLOVER_ONLINE_ORDER_TYPE_IDS: 'ONLINE12345' };

test('online contact is preserved for matching; store order stays unlinked', () => {
  const online = snapshot(order(), 'MERCHANT123', ['ONLINE12345']);
  assert.equal(online.customerEmail, 'Buyer@Example.invalid');
  assert.equal(online.online, true);
  const walkIn = snapshot(order(), 'MERCHANT123', ['DIFFERENT123']);
  assert.equal(walkIn.online, false);
  assert.equal(walkIn.customerEmail, null);
  assert.equal(walkIn.customerPhone, null);
});

test('missing financial expansion fails before any write', () => {
  const incomplete = order();
  delete incomplete.refunds;
  assert.throws(() => snapshot(incomplete, 'MERCHANT123', ['ONLINE12345']), /incomplete_collection/);
});

test('preview rejects production fallback', () => {
  const bad = orderPullConfig({ ...env, TEST_CLOVER_ORDERS_ACCESS_TOKEN: undefined,
    CLOVER_ORDERS_ACCESS_TOKEN: 'productiononly123' }, 'preview.pages.dev');
  assert.equal(bad.ready, false);
  const good = orderPullConfig(env, 'preview.pages.dev');
  assert.equal(good.ready, true);
  assert.match(good.cloverBase, /apisandbox/);
});

test('manual pull checks staff before Clover and writes once', async () => {
  const calls = [];
  const fakeFetch = async (input, options) => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/rpc/crm_staff_authorized_v1')) return Response.json(true);
    if (url.endsWith('/rpc/clover_order_ingest_v1')) return Response.json({ orderId: 'test' });
    if (url.includes('/orders/ORDER123456')) return Response.json(order());
    if (url.includes('/orders?')) return Response.json({ elements: [{ id: 'ORDER123456', createdTime: Date.now() }] });
    throw new Error('unexpected request');
  };
  const handler = cloverOrderPullHandler(fakeFetch);
  const request = new Request('https://preview.pages.dev/api/staff/clover-order-pull', {
    method: 'POST', headers: { Origin: 'https://preview.pages.dev', Authorization: `Bearer ${'a'.repeat(24)}`,
      'Content-Type': 'application/json' }, body: '{"days":1}' });
  const response = await handler({ request, env });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { code: 'ok', fetched: 1, upserted: 1, periodDays: 1 });
  assert.equal(calls.filter(x => x.endsWith('/rpc/clover_order_ingest_v1')).length, 1);
  assert.ok(calls[0].endsWith('/rpc/crm_staff_authorized_v1'));
  assert.ok(calls[1].includes('apisandbox.dev.clover.com'));
});

test('Clover scope failure writes no snapshot', async () => {
  const calls = [];
  const fakeFetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/rpc/crm_staff_authorized_v1')) return Response.json(true);
    return new Response('', { status: 403 });
  };
  const config = orderPullConfig(env, 'preview.pages.dev');
  await assert.rejects(collectOrders(config, 1, fakeFetch), /clover_scope_or_auth/);
  assert.equal(calls.length, 1);
});
