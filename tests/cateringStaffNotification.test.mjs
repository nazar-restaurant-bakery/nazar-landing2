import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../functions/api/signup.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { onRequestPost } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const requestId = '0c8f9e8d-5a8b-4f1f-8afa-5916392b8d05';
const payload = {
  kind: 'catering', name: 'Nazar Notification Test', email: 'test@example.com',
  phone: '', turnstileToken: 'test-token', requestId,
  eventDate: '2026-10-20', guests: '25', message: 'Synthetic test only',
};

function setup(deliveryOk) {
  const calls = [];
  const background = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    if (String(url).includes('turnstile')) return Response.json({ success: true, hostname: 'www.nazarrestaurantandbakery.com' });
    if (String(url).includes('submit_signup_once')) return Response.json(null);
    if (String(url).includes('claim_catering_staff_notification_v1')) return Response.json({
      requestId, requestDate: '2026-10-14T03:00:00Z', eventDate: '2026-10-20', guests: 25,
    });
    if (String(url).includes('api.cloudflare.com')) return Response.json({
      success: deliveryOk,
      result: deliveryOk ? { delivered: ['ctnazarbakery@gmail.com'], queued: [] } : null,
    });
    if (String(url).includes('finish_catering_staff_notification_v1')) return Response.json(null);
    throw new Error(`Unexpected request: ${url}`);
  };
  const context = {
    request: new Request('https://www.nazarrestaurantandbakery.com/api/signup', {
      method: 'POST', headers: { Origin: 'https://www.nazarrestaurantandbakery.com', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    env: {
      SUPABASE_SECRET_KEY: 'sb_secret_test', TURNSTILE_SECRET_KEY: 'test',
      CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
      CLOUDFLARE_EMAIL_SEND_TOKEN: 'private-test-key',
    },
    waitUntil(promise) { background.push(promise); },
  };
  return { context, calls, background };
}

for (const deliveryOk of [true, false]) {
  test(`saved catering request succeeds when staff delivery ${deliveryOk ? 'works' : 'fails'}`, async () => {
    const { context, calls, background } = setup(deliveryOk);
    const response = await onRequestPost(context);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { code: 'accepted' });
    assert.equal(background.length, 1);
    await Promise.all(background);
    const notification = calls.find((call) => call.url.includes('api.cloudflare.com'));
    assert.deepEqual(Object.keys(notification.body).sort(),
      ['to', 'from', 'subject', 'text'].sort());
    assert.equal(notification.headers.Authorization, 'Bearer private-test-key');
    assert.equal(notification.body.to, 'ctnazarbakery@gmail.com');
    assert.equal(notification.body.from, 'notifications@nazarrestaurantandbakery.com');
    assert.deepEqual(notification.body.text.split('\n').map((line) => line.split(':')[0]),
      ['Request date', 'Event date', 'Guest count', 'CRM']);
    assert.ok(!notification.body.text.includes('Nazar Notification Test'));
    assert.ok(!notification.body.text.includes('test@example.com'));
    const finish = calls.find((call) => call.url.includes('finish_catering_staff_notification_v1'));
    assert.equal(finish.body.p_sent, deliveryOk);
  });
}
