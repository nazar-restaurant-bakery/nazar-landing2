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
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (String(url).includes('turnstile')) return Response.json({ success: true, hostname: 'www.nazarrestaurantandbakery.com' });
    if (String(url).includes('submit_signup_once')) return Response.json(null);
    if (String(url).includes('claim_catering_staff_notification_v1')) return Response.json({
      requestId, requestDate: '2026-10-14T03:00:00Z', eventDate: '2026-10-20', guests: 25,
    });
    if (String(url).includes('script.google.com')) return Response.json({ ok: deliveryOk });
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
      CATERING_NOTIFY_URL: 'https://script.google.com/macros/s/test/exec',
      CATERING_NOTIFY_SECRET: 'private-test-key',
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
    const notification = calls.find((call) => call.url.includes('script.google.com'));
    assert.deepEqual(Object.keys(notification.body).sort(),
      ['eventDate', 'guests', 'key', 'requestDate', 'requestId'].sort());
    assert.equal(notification.body.key, 'private-test-key');
    const finish = calls.find((call) => call.url.includes('finish_catering_staff_notification_v1'));
    assert.equal(finish.body.p_sent, deliveryOk);
  });
}
