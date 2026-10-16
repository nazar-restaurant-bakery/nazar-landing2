import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { onRequestGet } from '../functions/api/staff/clover-orders.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const env = {
  VITE_SUPABASE_ANON_KEY: 'sb_publishable_test',
  CLOVER_ORDERS_ACCESS_TOKEN: 'test-private-token',
  CLOVER_MERCHANT_ID: 'F8Q154GMDKFD1',
  CLOVER_ONLINE_ORDER_TYPE_IDS: 'DELIVERY12345',
};
const bearer = `Bearer ${'a'.repeat(40)}`;
const request = (headers = {}) => new Request('https://www.nazarrestaurantandbakery.com/api/staff/clover-orders', {
  headers: { Authorization: bearer, ...headers },
});

test('only an allowlisted staff session can reach Clover', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json(false); };
  const response = await onRequestGet({ request: request(), env });
  assert.equal(response.status, 403);
  assert.equal(calls, 1);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
});

test('cross-origin and missing session are rejected without network access', async () => {
  globalThis.fetch = () => { throw Error('unexpected network call'); };
  assert.equal((await onRequestGet({ request: request({ Origin: 'https://bad.invalid' }), env })).status, 403);
  const missing = new Request('https://www.nazarrestaurantandbakery.com/api/staff/clover-orders');
  assert.equal((await onRequestGet({ request: missing, env })).status, 401);
});

test('no Clover credentials produces an unavailable state after staff authorization', async () => {
  globalThis.fetch = async () => Response.json(true);
  const response = await onRequestGet({ request: request(), env: { VITE_SUPABASE_ANON_KEY: env.VITE_SUPABASE_ANON_KEY } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'connection_unavailable');
});

test('returns only the configured online type and minimal order fields', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('supabase.co')) return Response.json(true);
    assert.equal(options.headers.Authorization, `Bearer ${env.CLOVER_ORDERS_ACCESS_TOKEN}`);
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.clover.com');
    assert.ok(parsed.searchParams.getAll('filter').includes('orderType=DELIVERY12345'));
    assert.equal(parsed.searchParams.get('expand'), 'orderType');
    return Response.json({ elements: [{
      id: 'ORDER1234567', createdTime: Date.now() - 1000,
      orderType: { id: 'DELIVERY12345', name: 'Delivery' },
      total: 1610, state: 'locked', paymentState: 'PAID',
      customers: { elements: [{ email: 'private@example.invalid' }] },
    }] });
  };
  const response = await onRequestGet({ request: request(), env });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.orders.length, 1);
  assert.equal(body.orders[0].id, 'ORDER1234567');
  assert.equal(body.orders[0].totalCents, 1610);
  assert.ok(!JSON.stringify(body).includes('private@example.invalid'));
  assert.equal(calls.length, 2);
});

test('unexpected order type fails closed rather than showing POS orders as online', async () => {
  globalThis.fetch = async (url) => String(url).includes('supabase.co') ? Response.json(true)
    : Response.json({ elements: [{ id: 'ORDER1234567', createdTime: Date.now(), orderType: { id: 'POS12345678' } }] });
  const response = await onRequestGet({ request: request(), env });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'provider_unavailable');
});

test('marks the list partial when more than 50 orders match across online types', async () => {
  const types = ['DELIVERY12345', 'PICKUP1234567'];
  globalThis.fetch = async (url) => {
    if (String(url).includes('supabase.co')) return Response.json(true);
    const typeId = types.find(type => String(url).includes(`orderType%3D${type}`));
    assert.ok(typeId);
    return Response.json({ elements: Array.from({ length: 30 }, (_, index) => ({
      id: `${typeId}${String(index).padStart(2, '0')}`,
      createdTime: Date.now() - index * 1000,
      orderType: { id: typeId, name: typeId },
      total: 1000,
      paymentState: 'PAID',
    })) });
  };
  const response = await onRequestGet({ request: request(), env: { ...env, CLOVER_ONLINE_ORDER_TYPE_IDS: types.join(',') } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.orders.length, 50);
  assert.equal(body.truncated, true);
});
