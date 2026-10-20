import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshot, collectOrders, orderPullConfig, closedPullWindow, CloverRequestGate } from '../../functions/_lib/cloverOrderPull.ts';
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
const testDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() - 2 * 86400000));
const listResponse = url => {
  const value = order();
  const expand = new URL(url).searchParams.get('expand');
  return Response.json({ elements: [expand === 'refunds' ? { id: value.id, refunds: value.refunds }
    : expand === 'customers' ? { id: value.id, customers: value.customers }
    : { id: value.id, createdTime: value.createdTime }] });
};

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
    if (url.endsWith('/rpc/staff_business_authorized_v1')) {
      assert.deepEqual(JSON.parse(options.body), { p_business_id: env.TEST_BUSINESS_ID, p_operation: 'crm.write' });
      return Response.json(true);
    }
    if (url.endsWith('/rpc/clover_order_ingest_v1')) return Response.json({ orderId: 'test' });
    if (url.endsWith('/rpc/clover_pull_attempt_record_v1')) {
      assert.equal(JSON.parse(options.body).p_upserted_count, 1);
      return Response.json(true);
    }
    if (url.includes('/orders/ORDER123456')) {
      const expand = new URL(url).searchParams.get('expand').split(',');
      assert.ok(expand.length <= 3);
      const value = order();
      if (expand.includes('refunds')) return Response.json({ id: value.id, refunds: value.refunds });
      if (expand.includes('customers')) return Response.json({ id: value.id, customers: value.customers });
      return Response.json({ id: value.id, createdTime: value.createdTime, orderType: value.orderType,
        lineItems: value.lineItems, payments: value.payments, total: value.total });
    }
    if (url.includes('/orders?')) return listResponse(url);
    throw new Error('unexpected request');
  };
  const handler = cloverOrderPullHandler(fakeFetch);
  const request = new Request('https://preview.pages.dev/api/staff/clover-order-pull', {
    method: 'POST', headers: { Origin: 'https://preview.pages.dev', Authorization: `Bearer ${'a'.repeat(24)}`,
      'Content-Type': 'application/json' }, body: JSON.stringify({ day: testDay }) });
  const response = await handler({ request, env });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { code: 'ok', fetched: 1, upserted: 1, day: testDay, requestCount: 4, warnings: [] });
  assert.equal(calls.filter(x => x.endsWith('/rpc/clover_order_ingest_v1')).length, 1);
  assert.equal(calls.filter(x => x.includes('/orders/ORDER123456')).length, 1);
  assert.ok(calls[0].endsWith('/rpc/staff_business_authorized_v1'));
  assert.ok(calls[1].includes('apisandbox.dev.clover.com'));
});

test('Clover scope failure writes no snapshot', async () => {
  const calls = [];
  const fakeFetch = async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/rpc/staff_business_authorized_v1')) return Response.json(true);
    return new Response('', { status: 403 });
  };
  const config = orderPullConfig(env, 'preview.pages.dev');
  await assert.rejects(collectOrders(config, closedPullWindow(testDay), fakeFetch),
    error => error.code === 'clover_access_denied' && error.step === 'list' && error.providerStatus === 403);
  assert.equal(calls.length, 1);
});

test('a denied business write scope stops before Clover and ingest', async () => {
  const calls = [];
  const fakeFetch = async (input, options) => {
    calls.push(String(input));
    assert.ok(String(input).endsWith('/rpc/staff_business_authorized_v1'));
    assert.deepEqual(JSON.parse(options.body), { p_business_id: env.TEST_BUSINESS_ID, p_operation: 'crm.write' });
    return Response.json(false);
  };
  const originalWarn = console.warn; console.warn = () => {};
  try {
    const response = await cloverOrderPullHandler(fakeFetch)({ request: new Request('https://preview.pages.dev/api/staff/clover-order-pull', {
      method: 'POST', headers: { Origin: 'https://preview.pages.dev', Authorization: `Bearer ${'a'.repeat(24)}`,
        'Content-Type': 'application/json' }, body: '{"days":1}' }), env });
    assert.equal(response.status, 403);
    assert.equal(calls.length, 1);
  } finally { console.warn = originalWarn; }
});

test('fatal Clover denial keeps provider HTTP separate from site wrapper', async () => {
  const fakeFetch = async input => {
    const url = String(input);
    if (url.endsWith('/rpc/staff_business_authorized_v1')) return Response.json(true);
    if (url.includes('/orders/ORDER123456')) return new Response('', { status: 403 });
    if (url.includes('/orders?')) return listResponse(url);
    throw new Error('unexpected request');
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  let response;
  try {
    response = await cloverOrderPullHandler(fakeFetch)({ request: new Request('https://preview.pages.dev/api/staff/clover-order-pull', {
      method: 'POST', headers: { Origin: 'https://preview.pages.dev', Authorization: `Bearer ${'a'.repeat(24)}`,
        'Content-Type': 'application/json' }, body: JSON.stringify({ day: testDay }) }), env });
  } finally { console.warn = originalWarn; }
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'clover_access_denied', step: 'order_core', requestCount: 4, upserted: 0, providerStatus: 403 });
});

test('refunded order is ingested after three limited expansions', async () => {
  let ingested;
  const fakeFetch = async (input, options) => {
    const url = String(input);
    if (url.endsWith('/rpc/staff_business_authorized_v1')) return Response.json(true);
    if (url.endsWith('/rpc/clover_order_ingest_v1')) {
      ingested = JSON.parse(options.body).p_snapshot;
      return Response.json({ orderId: 'test' });
    }
    if (url.endsWith('/rpc/clover_pull_attempt_record_v1')) return Response.json(true);
    if (url.includes('/orders/ORDER123456')) {
      const value = order();
      if (new URL(url).searchParams.get('expand') === 'refunds')
        return Response.json({ id: value.id, refunds: { elements: [{ id: 'REFUND12345', amount: 900 }] } });
      if (new URL(url).searchParams.get('expand') === 'customers')
        return Response.json({ id: value.id, customers: value.customers });
      return Response.json({ id: value.id, createdTime: value.createdTime, orderType: value.orderType,
        lineItems: value.lineItems, payments: value.payments });
    }
    if (url.includes('/orders?')) {
      if (new URL(url).searchParams.get('expand') === 'refunds')
        return Response.json({ elements: [{ id: 'ORDER123456', refunds: { elements: [{ id: 'REFUND12345', amount: 900 }] } }] });
      return listResponse(url);
    }
    throw new Error('unexpected request');
  };
  const response = await cloverOrderPullHandler(fakeFetch)({ request: new Request('https://preview.pages.dev/api/staff/clover-order-pull', {
    method: 'POST', headers: { Origin: 'https://preview.pages.dev', Authorization: `Bearer ${'a'.repeat(24)}`,
      'Content-Type': 'application/json' }, body: JSON.stringify({ day: testDay }) }), env });
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
    if (url.endsWith('/rpc/staff_business_authorized_v1')) return Response.json(true);
    if (url.endsWith('/rpc/clover_pull_attempt_record_v1')) return Response.json(true);
    if (url.includes('/orders/ORDER123456')) {
      const value = order();
      return Response.json({ id: value.id, createdTime: value.createdTime, orderType: value.orderType,
        lineItems: value.lineItems });
    }
    if (url.includes('/orders?')) return listResponse(url);
    throw new Error('unexpected request');
  };
  const originalWarn = console.warn;
  const logs = [];
  console.warn = (...args) => logs.push(args);
  let response;
  try {
    response = await cloverOrderPullHandler(fakeFetch)({ request: new Request('https://preview.pages.dev/api/staff/clover-order-pull', {
      method: 'POST', headers: { Origin: 'https://preview.pages.dev', Authorization: `Bearer ${'a'.repeat(24)}`,
        'Content-Type': 'application/json' }, body: JSON.stringify({ day: testDay }) }), env: auditedEnv });
  } finally { console.warn = originalWarn; }
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { code: 'clover_collection_missing', step: 'order_core', requestCount: 4, upserted: 0 });
  assert.equal(calls.filter(x => x.endsWith('/rpc/clover_order_ingest_v1')).length, 0);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0][1], { code: 'clover_collection_missing', step: 'order_core', status: 503, requestCount: 4 });
  assert.deepEqual(auditPoints, [{ blobs: ['clover_collection_missing', 'order_core'], doubles: [503, 0, 4] }]);
});

for (const denied of ['refunds', 'customers', 'none']) {
  test(`separate optional Clover reads: ${denied}`, async () => {
    const snapshots = [];
    const auditPoints = [];
    const auditedEnv = { ...env, CLOVER_PULL_AUDIT: { writeDataPoint: point => auditPoints.push(point) } };
    const fakeFetch = async (input, options) => {
      const url = String(input);
      if (url.endsWith('/rpc/staff_business_authorized_v1')) return Response.json(true);
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
      if (url.includes('/orders?')) {
        if (new URL(url).searchParams.get('expand') === denied) return new Response('', { status: 403 });
        return listResponse(url);
      }
      throw new Error('unexpected request');
    };
    const originalWarn = console.warn;
    console.warn = () => {};
    let response;
    try {
      response = await cloverOrderPullHandler(fakeFetch)({ request: new Request('https://preview.pages.dev/api/staff/clover-order-pull', {
        method: 'POST', headers: { Origin: 'https://preview.pages.dev', Authorization: `Bearer ${'a'.repeat(24)}`,
          'Content-Type': 'application/json' }, body: JSON.stringify({ day: testDay }) }), env: auditedEnv });
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
      assert.deepEqual(auditPoints, [{ blobs: ['clover_refunds_access_denied', 'order_refunds'], doubles: [200, 403, 4] },
        { blobs: ['pull_completed', 'ingest'], doubles: [200, 0, 4] }]);
    } else if (denied === 'customers') {
      assert.equal(snapshots[0].refundsVerified, true);
      assert.equal(snapshots[0].customerAccess, 'denied');
      assert.equal(snapshots[0].customerEmail, null);
      assert.deepEqual(result.warnings, [{ code: 'clover_customers_access_denied', step: 'order_customers', httpStatus: 403 }]);
      assert.deepEqual(auditPoints, [{ blobs: ['clover_customers_access_denied', 'order_customers'], doubles: [200, 403, 4] },
        { blobs: ['pull_completed', 'ingest'], doubles: [200, 0, 4] }]);
    } else {
      assert.equal(snapshots[0].refundsVerified, true);
      assert.equal(snapshots[0].customerAccess, 'verified');
      assert.equal(snapshots[0].customerEmail, 'Buyer@Example.invalid');
      assert.deepEqual(result.warnings, []);
      assert.deepEqual(auditPoints, [{ blobs: ['pull_completed', 'ingest'], doubles: [200, 0, 4] }]);
    }
  });
}

test('the selected New York day is exact, including the DST change', () => {
  const march = closedPullWindow('2026-03-08', Date.parse('2026-03-10T00:00:00Z'));
  const november = closedPullWindow('2026-11-01', Date.parse('2026-11-03T00:00:00Z'));
  assert.equal(march.end - march.start, 23 * 3600000);
  assert.equal(november.end - november.start, 25 * 3600000);
});

test('429 honors Retry-After, retries within three attempts and counts each attempt', async () => {
  const gate = new CloverRequestGate();
  let calls = 0;
  const started = Date.now();
  const response = await gate.get(new URL('https://api.clover.com/test'), 'test', async () => {
    calls++;
    return calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '1' } }) : Response.json({ ok: true });
  }, 'list');
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(gate.attempts, 2);
  assert.ok(Date.now() - started >= 950);
  const exhausted = new CloverRequestGate();
  await assert.rejects(exhausted.get(new URL('https://api.clover.com/test'), 'test', async () =>
    new Response('', { status: 429, headers: { 'Retry-After': '60' } }), 'order_core'),
  error => error.code === 'clover_rate_limited' && error.providerStatus === 429 && error.step === 'order_core');
  assert.equal(exhausted.attempts, 1);
});

test('batch expansion avoids core detail calls and an ingest retry upserts by Clover ID', async () => {
  const rows = [order('ORDER123456'), order('ORDER654321')];
  const stored = new Map();
  const attempts = [];
  let failOnce = true;
  let cloverCalls = 0;
  const fakeFetch = async (input, options) => {
    const url = String(input);
    if (url.endsWith('/rpc/staff_business_authorized_v1')) return Response.json(true);
    if (url.endsWith('/rpc/clover_pull_attempt_record_v1')) {
      attempts.push(JSON.parse(options.body));
      return Response.json(true);
    }
    if (url.endsWith('/rpc/clover_order_ingest_v1')) {
      const record = JSON.parse(options.body).p_snapshot;
      if (record.id === rows[1].id && failOnce) { failOnce = false; return new Response('', { status: 500 }); }
      stored.set(record.id, record);
      return Response.json({ orderId: record.id });
    }
    cloverCalls++;
    if (url.includes('/orders?')) {
      const query = new URL(url).searchParams;
      assert.equal(query.getAll('filter').length, 2);
      const expand = query.get('expand');
      assert.ok(['orderType,lineItems,payments', 'refunds', 'customers'].includes(expand));
      return Response.json({ elements: rows.map(row => expand === 'refunds' ? { id: row.id, refunds: row.refunds }
        : expand === 'customers' ? { id: row.id, customers: row.customers }
          : { id: row.id, createdTime: row.createdTime, orderType: row.orderType, lineItems: row.lineItems,
              payments: row.payments, total: row.total }) });
    }
    const record = rows.find(row => url.includes(row.id));
    assert.ok(record);
    const expand = new URL(url).searchParams.get('expand');
    assert.notEqual(expand, 'lineItems,payments,orderType');
    return Response.json({ id: record.id, [expand]: record[expand] });
  };
  const handler = cloverOrderPullHandler(fakeFetch);
  const request = () => new Request('https://preview.pages.dev/api/staff/clover-order-pull', {
    method: 'POST', headers: { Origin: 'https://preview.pages.dev', Authorization: `Bearer ${'a'.repeat(24)}`,
      'Content-Type': 'application/json' }, body: JSON.stringify({ day: testDay }) });
  const originalWarn = console.warn; console.warn = () => {};
  try {
    const first = await handler({ request: request(), env });
    assert.equal(first.status, 503);
    assert.deepEqual(await first.json(), { code: 'database_http_error', step: 'ingest', requestCount: 3, upserted: 1, providerStatus: 500 });
    assert.equal(stored.size, 1);
    const second = await handler({ request: request(), env });
    assert.equal(second.status, 200);
    assert.equal((await second.json()).requestCount, 3);
    assert.equal(stored.size, 2);
    assert.equal(cloverCalls, 6);
    assert.deepEqual(attempts.map(attempt => [attempt.p_error_code, attempt.p_fetched_count, attempt.p_upserted_count]),
      [['database_http_error', 2, 1], [null, 2, 2]]);
  } finally { console.warn = originalWarn; }
});
