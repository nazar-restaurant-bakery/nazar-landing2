import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../apps-script/catering-staff-notify/Code.gs', import.meta.url), 'utf8');

function scriptHarness() {
  const properties = new Map([['WEBHOOK_SECRET', 'test-secret']]);
  const emails = [];
  const context = vm.createContext({
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput(text) { return { text, setMimeType() { return this; } }; },
    },
    PropertiesService: { getScriptProperties() { return {
      getProperty(key) { return properties.get(key); },
      setProperty(key, value) { properties.set(key, value); },
    }; } },
    LockService: { getScriptLock() { return { tryLock() { return true; }, releaseLock() {} }; } },
    MailApp: { getRemainingDailyQuota() { return 100; }, sendEmail(...args) { emails.push(args); } },
    Utilities: { formatDate() { return '2026-10-13 23:00 EDT'; } },
  });
  vm.runInContext(source, context);
  return { context, emails };
}

const request = {
  requestId: '0c8f9e8d-5a8b-4f1f-8afa-5916392b8d05',
  requestDate: '2026-10-14T03:00:00Z', eventDate: '2026-10-20', guests: 25,
};

test('wrong key sends nothing; valid repeated request sends one minimal email', () => {
  const { context, emails } = scriptHarness();
  const post = (body) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }).text);
  assert.deepEqual(post({ ...request, key: 'wrong' }), { ok: false, error: 'forbidden' });
  assert.equal(emails.length, 0);
  assert.deepEqual(post({ ...request, key: 'test-secret' }), { ok: true });
  assert.deepEqual(post({ ...request, key: 'test-secret' }), { ok: true });
  assert.equal(emails.length, 1);
  assert.equal(emails[0][0], 'ctnazarbakery@gmail.com');
  assert.match(emails[0][2], /Request date: 2026-10-13 23:00 EDT/);
  assert.match(emails[0][2], /Event date: 2026-10-20/);
  assert.match(emails[0][2], /Guest count: 25/);
  assert.match(emails[0][2], /https:\/\/www\.nazarrestaurantandbakery\.com\/staff/);
  assert.doesNotMatch(emails[0][2], /test-secret|example\.com|@gmail\.com|0c8f9e8d/);
});
