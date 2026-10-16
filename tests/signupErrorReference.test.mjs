import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { submitSignup } from '../src/lib/signup.ts';
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
globalThis.window = { setTimeout, clearTimeout };
afterEach(() => { globalThis.fetch = originalFetch; });
const payload = { kind: 'vip', requestId: 'synthetic' };
const id = '8c347b08-77a4-4a6e-8747-98ac48dcb334';
test('only an opaque UUID from a failed response is offered for display', async () => {
  globalThis.fetch = async () => Response.json({ error_id: id }, { status: 503 });
  const references = [];
  assert.equal(await submitSignup(payload, value => references.push(value)), false);
  assert.deepEqual(references, [id]);
});
test('arbitrary error text, proxy HTML and offline failures never become references', async () => {
  for (const mock of [
    async () => Response.json({ error_id: '<script>unsafe</script>' }, { status: 503 }),
    async () => new Response('<h1>proxy error</h1>', { status: 502 }),
    async () => { throw new Error('offline'); },
  ]) {
    globalThis.fetch = mock;
    assert.equal(await submitSignup(payload, () => assert.fail('unsafe reference')), false);
  }
});
test('a successful retry remains accepted without a failure reference', async () => {
  globalThis.fetch = async () => Response.json({ code: 'accepted', error_id: id });
  assert.equal(await submitSignup(payload, () => assert.fail('success is not an error')), true);
});
process.on('exit', () => { globalThis.window = originalWindow; });
