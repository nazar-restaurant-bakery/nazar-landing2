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

test('an absent refund collection means no refund; a populated refund is preserved', () => {
  const noRefund = order();
  delete noRefund.refunds;
  assert.deepEqual(snapshot(noRefund, 'MERCHANT123', ['ONLINE12345']).refunds, []);
  const refunded = order();
  refunded.refunds = { elements: [{ id: 'REFUND12345', amount: 900 }] };
  assert.equal(snapshot(refunded, 'MERCHANT123', ['ONLINE12345']).refunds[0].amount, 900);
});

test('missing payment collection still fails', () => {
  const incomplete = order();
  delete incomplete.payments;
  assert.throws(() => snapshot(incomplete, 'MERCHANT123', ['ONLINE12345']),
    error => error.code === 'clover_collection_missing' && error.step === 'order_core');
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
    if (url.includes('/orders/ORDER123456')) {
      const expand = new URL(url).searchParams.get('expand').split(',');
      assert.ok(expand.length <= 3);
      const value = order();
      if (expand.includes('refunds')) return Response.json({ id: value.id, refunds: value.refunds });
      if (expand.includes('customers')) return Response.json({ id: value.id, customers: value.customers });
      return Response.json({ id: value.id, createdTime: value.createdTime, orderType: value.orderType,
        lineItems: value.lineItems, payments: value.payments, total: value.total });
    }
    if (url.includes('/orders?')) return Response.json({ elements: [{ id: 'ORDER123456', createdTime: Date.now() }] });
    throw new Error('unexpected request');
  };
  const handler = cloverOrderPullHandler(fakeFetch);
  const request = new Request('https://preview.pages.dev/api/staff/clover-order-pull', {
    method: 'POST', headers: { Origin: 'https://preview.pages.dev', Authorization: `Bearer ${'a'.repeat(24)}`,
      'Content-Type': 'application/json' }, body: '{"days":1}' });
  const response = await handler({ request, env });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { code: 'ok', fetched: 1, upserted: 1, periodDays: 1, warnings: [] });
  assert.equal(calls.filter(x => x.endsWith('/rpc/clover_order_ingest_v1')).length, 1);
  assert.equal(calls.filter(x => x.includes('/orders/ORDER123456')).length, 3);
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
  await assert.rejects(collectOrders(config, 1, fakeFetch),
    error => error.code === 'clover_access_denied' && error.step === 'list' && error.providerStatus === 403);
  assert.equal(calls.length, 1);
});

test('fatal Clover denial keeps provider HTTP separate from site wrapper', async () => {
  const fakeFetch = async input => {
    const url = String(input);
    if (url.endsWith('/rpc/crm_staff_authorized_v1')) return Response.json(true);
    if (url.includes('/orders/ORDER123456')) return new Response('', { status: 403 });
    if (url.includes('/orders?')) return Response.json({ elements: [{ id: 'ORDER123456', createdTime: Date.now() }] });
    throw new Error('unexpected request');
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  let response;
  try {
    response = await cloverOrderPullHandler(fakeFetch)({ request: new Request('https://preview.pages.dev/api/staff/clover-order-pull', {
      method: 'POST', headers: { Origin: 'https://preview.pages.dev', Authorization: `Bearer ${'a'.repeat(24)}`,
        'Content-Type': 'application/json' }, body: '{"days":1}' }), env });
  } finally { console.warn = originalWarn; }
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'clover_access_denied', step: 'order_core', providerStatus: 403 });
});

test('refunded order is ingested after three limited expansions', async () => {
  let ingested;
  const fakeFetch = async (input, options) => {
    const url = String(input);
    if (url.endsWith('/rpc/crm_staff_authorized_v1')) return Response.json(true);
    if (url.endsWith('/rpc/clover_order_ingest_v1')) {
      ingested = JSON.parse(options.body).p_snapshot;
      return Response.json({ orderId: 'test' });
    }
    if (url.includes('/orders/ORDER123456')) {
      const value = order();
      if (new URL(url).searchParams.get('expand') === 'refunds')
        return Response.json({ id: value.id, refunds: { elements: [{ id: 'REFUND12345', amount: 900 }] } });
      if (new URL(url).searchParams.get('expand') === 'customers')
        return Response.json({ id: value.id, customers: value.customers });
      return Response.json({ id: value.id, createdTime: value.createdTime, orderType: value.orderType,
        lineItems: value.lineItems, payments: value.payments });
    }
    if (url.includes('/orders?')) return Response.json({ elements: [{ id: 'ORDER123456', createdTime: Date.now() }] });
    throw new Error('unexpected request');
  };
  const response = await cloverOrderPullHandler(fakeFetch)({ request: new Request('https://preview.pages.dev/api/staff/clover-order-pull', {
    method: 'POST', headers: { Origin: 'https://preview.pages.dev', Authorization: `Bearer ${'a'.repeat(24)}`,
      'Content-Type': 'application/json' }, body: '{"days":1}' }), env });
  assert.equal(response.status, 200);
  assert.equal(ingested.refunds[0].amount, 900);
  assert.equal(ingested.refundsVerified, true);
});

test('missing payment expansion returns a safe stage and never ingests', async () => {
  const calls = [];
  const auditPoints = [];
  const auditedEnv = { ...env, CLOVER_PULL_AUDIT: { writeDataPoint: point => auditPoints.push(point) } };
  const fakeFetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/rpc/crm_staff_authorized_v1')) return Response.json(true);
    if (url.includes('/orders/ORDER123456')) {
      const value = order();
      return Response.json({ id: value.id, createdTime: value.createdTime, orderType: value.orderType,
        lineItems: value.lineItems });
    }
    if (url.includes('/orders?')) return Response.json({ elements: [{ id: 'ORDER123456', createdTime: Date.now() }] });
    throw new Error('unexpected request');
  };
  const originalWarn = console.warn;
  const logs = [];
  console.warn = (...args) => logs.push(args);
  let response;
  try {
    response = await cloverOrderPullHandler(fakeFetch)({ request: new Request('https://preview.pages.dev/api/staff/clover-order-pull', {
      method: 'POST', headers: { Origin: 'https://preview.pages.dev', Authorization: `Bearer ${'a'.repeat(24)}`,
        'Content-Type': 'application/json' }, body: '{"days":1}' }), env: auditedEnv });
  } finally { console.warn = originalWarn; }
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'clover_collection_missing', step: 'order_core' });
  assert.equal(calls.filter(x => x.endsWith('/rpc/clover_order_ingest_v1')).length, 0);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0][1], { code: 'clover_collection_missing', step: 'order_core', status: 503 });
  assert.deepEqual(auditPoints, [{ blobs: ['clover_collection_missing', 'order_core'], doubles: [503, 0] }]);
});

for (const denied of ['refunds', 'customers', 'none']) {
  test(`separate optional Clover reads: ${denied}`, async () => {
    const snapshots = [];
    const auditPoints = [];
    const auditedEnv = { ...env, CLOVER_PULL_AUDIT: { writeDataPoint: point => auditPoints.push(point) } };
    const fakeFetch = async (input, options) => {
      const url = String(input);
      if (url.endsWith('/rpc/crm_staff_authorized_v1')) return Response.json(true);
      if (url.endsWith('/rpc/clover_order_ingest_v1')) {
        snapshots.push(JSON.parse(options.body).p_snapshot);
        return Response.json({ orderId: 'test' });
      }
      if (url.includes('/orders/ORDER123456')) {
        const value = order();
        const expand = new URL(url).searchParams.get('expand');
        if (expand === denied) return new Response('', { status: 403 });
        if (expand === 'refunds') return Response.json({ id: value.id, refunds: value.refunds });
        if (expand === 'customers') return Response.json({ id: value.id, customers: value.customers });
        return Response.json({ id: value.id, createdTime: value.createdTime, orderType: value.orderType,
          lineItems: value.lineItems, payments: value.payments, total: value.total });
      }
      if (url.includes('/orders?')) return Response.json({ elements: [{ id: 'ORDER123456', createdTime: Date.now() }] });
      throw new Error('unexpected request');
    };
    const originalWarn = console.warn;
    console.warn = () => {};
    let response;
    try {
      response = await cloverOrderPullHandler(fakeFetch)({ request: new Request('https://preview.pages.dev/api/staff/clover-order-pull', {
        method: 'POST', headers: { Origin: 'https://preview.pages.dev', Authorization: `Bearer ${'a'.repeat(24)}`,
          'Content-Type': 'application/json' }, body: '{"days":1}' }), env: auditedEnv });
    } finally { console.warn = originalWarn; }
    assert.equal(response.status, 200);
    assert.equal(snapshots.length, 1);
    const result = await response.json();
    assert.equal(result.code, 'ok');
    if (denied === 'refunds') {
      assert.equal(snapshots[0].refundsVerified, false);
      assert.deepEqual(snapshots[0].refunds, []);
      assert.equal(snapshots[0].customerEmail, 'Buyer@Example.invalid');
      assert.deepEqual(result.warnings, [{ code: 'clover_refunds_access_denied', step: 'order_refunds', httpStatus: 403 }]);
      assert.deepEqual(auditPoints, [{ blobs: ['clover_refunds_access_denied', 'order_refunds'], doubles: [200, 403] }]);
    } else if (denied === 'customers') {
      assert.equal(snapshots[0].refundsVerified, true);
      assert.equal(snapshots[0].customerAccess, 'denied');
      assert.equal(snapshots[0].customerEmail, null);
      assert.deepEqual(result.warnings, [{ code: 'clover_customers_access_denied', step: 'order_customers', httpStatus: 403 }]);
      assert.deepEqual(auditPoints, [{ blobs: ['clover_customers_access_denied', 'order_customers'], doubles: [200, 403] }]);
    } else {
      assert.equal(snapshots[0].refundsVerified, true);
      assert.equal(snapshots[0].customerAccess, 'verified');
      assert.equal(snapshots[0].customerEmail, 'Buyer@Example.invalid');
      assert.deepEqual(result.warnings, []);
      assert.deepEqual(auditPoints, []);
    }
  });
}
