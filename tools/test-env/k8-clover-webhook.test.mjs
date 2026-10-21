import assert from 'node:assert/strict';
import test from 'node:test';
import { cloverWebhookHandler } from '../../supabase/functions/clover-webhook/handler.ts';

const businessId = '11111111-1111-4111-8111-111111111111';
const env = { SUPABASE_URL: 'https://uxiseddbeszklkrvysxf.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role', CLOVER_WEBHOOK_SECRET: 'test-auth-code',
  CLOVER_WEBHOOK_APP_ID: 'APP1234567', CLOVER_WEBHOOK_ENV: 'sandbox',
  CLOVER_ORDERS_ACCESS_TOKEN: 'test-clover-token' };
const event = (key, action = 'CREATE', ts = 1700000000000) => ({ appId: 'APP1234567',
  merchants: { MERCHANT123: [{ objectId: key, type: action, ts }] } });
const request = (payload, auth = 'test-auth-code') => new Request('https://test.invalid/functions/v1/clover-webhook',
  { method: 'POST', headers: { 'X-Clover-Auth': auth, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

function harness({ refunded = false, missingPayments = false, denied = '' } = {}) {
  const events = new Map(); const orders = new Map(); const calls = [];
  const fetcher = async (input, options) => {
    const url = String(input); calls.push(url);
    const body = options?.body ? JSON.parse(options.body) : null;
    if (url.endsWith('/rpc/clover_webhook_claim_v1')) {
      if (events.has(body.p_event_id)) return Response.json({ claimed: false, ...events.get(body.p_event_id).claim });
      const claim = { eventId: '22222222-2222-4222-8222-222222222222', businessId,
        environment: 'sandbox', tokenSecretName: 'CLOVER_ORDERS_ACCESS_TOKEN', onlineOrderTypeIds: ['ONLINE12345'] };
      events.set(body.p_event_id, { claim, body });
      return Response.json({ claimed: true, ...claim });
    }
    if (url.endsWith('/rpc/clover_order_ingest_v1')) {
      const value = body.p_snapshot;
      assert.equal(value.merchantId, 'MERCHANT123');
      orders.set(value.id, value);
      return Response.json({ orderId: value.id });
    }
    if (url.endsWith('/rpc/clover_webhook_finish_v1')) return Response.json(true);
    if (url.endsWith('/rpc/clover_webhook_verification_v1')) return Response.json(true);
    if (url.includes('/payments/PAY1234567')) {
      assert.equal(new URL(url).searchParams.get('expand'), 'order');
      return Response.json({ id: 'PAY1234567', order: { id: 'ORDER123456' } });
    }
    if (url.includes('/orders/ORDER123456')) {
      const expand = new URL(url).searchParams.get('expand').split(',');
      assert.ok(expand.length <= 3);
      if (expand.includes('customers')) return denied === 'customers'
        ? new Response('', { status: 403 })
        : Response.json({ id: 'ORDER123456', customers: { elements: [{ emailAddress: 'test@example.invalid' }] } });
      if (expand.includes('refunds') && denied === 'refunds') return new Response('', { status: 403 });
      if (expand.includes('refunds')) return Response.json({ id: 'ORDER123456',
        ...(refunded ? { refunds: { elements: [{ id: 'REFUND12345', amount: 500 }] } } : {}) });
      return Response.json({ id: 'ORDER123456', createdTime: 1700000000000,
        orderType: { id: 'ONLINE12345' }, total: 4500, lineItems: { elements: [] },
        ...(missingPayments ? {} : { payments: { elements: [{ id: 'PAY1234567', amount: 4500, result: 'SUCCESS' }] } }) });
    }
    throw new Error('unexpected fetch');
  };
  return { handler: cloverWebhookHandler(env, fetcher), events, orders, calls };
}

test('invalid auth returns 401 without storing body', async () => {
  const h = harness();
  const response = await h.handler(request(event('O:ORDER123456'), 'wrong-code'));
  assert.equal(response.status, 401);
  assert.equal(h.calls.length, 0);
});

test('verification challenge is accepted only during temporary setup window', async () => {
  const h = harness(); const challenge = { verificationCode: '5220ecf5-7dea-4396-b0ba-a1659c182887' };
  assert.equal((await h.handler(request(challenge, ''))).status, 401);
  assert.equal(h.calls.length, 0);
  const setup = cloverWebhookHandler({ ...env, CLOVER_WEBHOOK_SECRET: undefined,
    CLOVER_WEBHOOK_SETUP_ENABLED: 'true' }, async (input) => {
    assert.ok(String(input).endsWith('/rpc/clover_webhook_verification_v1'));
    return Response.json(true);
  });
  assert.equal((await setup(request(challenge, ''))).status, 200);
});

test('valid order event reads Orders API and duplicate does not ingest twice', async () => {
  const h = harness(); const input = request(event('O:ORDER123456'));
  assert.equal((await h.handler(input)).status, 200);
  assert.equal(h.orders.size, 1);
  assert.equal((await h.handler(request(event('O:ORDER123456')))).status, 200);
  assert.equal(h.orders.size, 1);
  assert.equal(h.calls.filter(x => x.endsWith('/rpc/clover_order_ingest_v1')).length, 1);
  assert.equal(h.orders.get('ORDER123456').refunds.length, 0);
});

test('payment before order converges to one order with payment', async () => {
  const h = harness();
  assert.equal((await h.handler(request(event('P:PAY1234567')))).status, 200);
  assert.equal((await h.handler(request(event('O:ORDER123456', 'UPDATE', 1700000000001)))).status, 200);
  assert.equal(h.orders.size, 1);
  assert.equal(h.orders.get('ORDER123456').payments[0].result, 'SUCCESS');
});

test('refund update reads refund from Orders API', async () => {
  const h = harness({ refunded: true });
  assert.equal((await h.handler(request(event('O:ORDER123456', 'UPDATE')))).status, 200);
  assert.equal(h.orders.get('ORDER123456').refunds[0].amount, 500);
});

for (const denied of ['refunds', 'customers']) test(`${denied} 403 stays explicitly unverified`, async () => {
  const h = harness({ denied });
  assert.equal((await h.handler(request(event('O:ORDER123456')))).status, 200);
  const order = h.orders.get('ORDER123456');
  assert.equal(order.refundsVerified, denied !== 'refunds');
  assert.equal(order.customerAccess, denied === 'customers' ? 'denied' : 'verified');
  if (denied === 'customers') assert.equal(order.customerEmail, null);
  assert.equal(h.calls.filter(x => x.includes('/orders/ORDER123456')).length, 3);
});

test('missing payments leaves a failed event and does not ingest', async () => {
  const h = harness({ missingPayments: true });
  assert.equal((await h.handler(request(event('O:ORDER123456')))).status, 503);
  assert.equal(h.orders.size, 0);
  const finish = h.calls.filter(x => x.endsWith('/rpc/clover_webhook_finish_v1'));
  assert.equal(finish.length, 1);
});
