import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../functions/api/signup.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace('"../../src/lib/deploymentEnvironment.ts"', JSON.stringify(new URL('../src/lib/deploymentEnvironment.ts', import.meta.url).href))
  .replace('"../_lib/resendEmail.ts"', JSON.stringify(new URL('../functions/_lib/resendEmail.ts', import.meta.url).href));
const { onRequestPost } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

const requestId = '0c8f9e8d-5a8b-4f1f-8afa-5916392b8d05';
const payload = {
  kind: 'catering', name: 'Nazar Notification Test', email: 'test@example.com',
  phone: '', turnstileToken: 'test-token', requestId,
  eventDate: '2026-10-20', guests: '25', message: 'Synthetic test only',
};

// delivery: 'accepted' (200 + id), 'not_accepted' (422), 'no_id' (200 without id), 'provider_error' (throws)
function setup(delivery, env = { RESEND_API_KEY: 'private-test-key' }) {
  const calls = [];
  const background = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    if (String(url).includes('turnstile')) return Response.json({ success: true, hostname: 'www.nazarrestaurantandbakery.com' });
    if (String(url).includes('submit_signup_once')) return Response.json(null);
    if (String(url).includes('resolve_form_errors_v1')) return Response.json(null);
    if (String(url).includes('claim_catering_staff_notification_v1')) return Response.json({
      requestId, requestDate: '2026-10-14T03:00:00Z', eventDate: '2026-10-20', guests: 25,
    });
    if (String(url).includes('api.resend.com')) {
      if (delivery === 'provider_error') throw new Error('uncertain transport');
      if (delivery === 'not_accepted') return Response.json({ name: 'validation_error' }, { status: 422 });
      return Response.json(delivery === 'accepted' ? { id: 're_test_1' } : {});
    }
    if (String(url).includes('finish_catering_staff_notification_v1')) return Response.json(null);
    throw new Error(`Unexpected request: ${url}`);
  };
  const context = {
    request: new Request('https://www.nazarrestaurantandbakery.com/api/signup', {
      method: 'POST', headers: { Origin: 'https://www.nazarrestaurantandbakery.com', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    env: { SUPABASE_SECRET_KEY: 'sb_secret_test', TURNSTILE_SECRET_KEY: 'test', ...env },
    waitUntil(promise) { background.push(promise); },
  };
  return { context, calls, background };
}

for (const delivery of ['accepted', 'not_accepted', 'no_id', 'provider_error']) {
  test(`saved catering request succeeds when staff delivery is ${delivery}`, async () => {
    const { context, calls, background } = setup(delivery);
    const response = await onRequestPost(context);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { code: 'accepted' });
    assert.equal(background.length, 1);
    await Promise.all(background);
    const notifications = calls.filter((call) => call.url.includes('api.resend.com'));
    assert.equal(notifications.length, 1);
    const [notification] = notifications;
    assert.equal(notification.url, 'https://api.resend.com/emails');
    assert.deepEqual(Object.keys(notification.body).sort(), ['from', 'subject', 'text', 'to']);
    assert.deepEqual(notification.headers, { Authorization: 'Bearer private-test-key',
      'Content-Type': 'application/json', 'Idempotency-Key': requestId });
    assert.deepEqual(notification.body.to, ['ctnazarbakery@gmail.com']);
    assert.equal(notification.body.from, 'Nazar Restaurant & Bakery <notifications@mail.nazarrestaurantandbakery.com>');
    assert.equal(notification.body.subject, 'New Nazar catering request');
    assert.deepEqual(notification.body.text.split('\n').map((line) => line.split(':')[0]),
      ['Request date', 'Event date', 'Guest count', 'CRM']);
    assert.ok(!notification.body.text.includes('Nazar Notification Test'));
    assert.ok(!notification.body.text.includes('test@example.com'));
    const finish = calls.find((call) => call.url.includes('finish_catering_staff_notification_v1'));
    assert.equal(finish.body.p_sent, delivery === 'accepted');
  });
}

test('without RESEND_API_KEY no notification is claimed or sent', async () => {
  const { context, calls, background } = setup('accepted', {});
  assert.equal((await onRequestPost(context)).status, 200);
  await Promise.all(background);
  assert.ok(!calls.some((call) => /api\.resend\.com|claim_catering_staff_notification_v1/.test(call.url)));
});
