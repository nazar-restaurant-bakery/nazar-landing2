import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFixture, validateFixture, renderSeedSql } from '../tools/test-env/synthetic-fixture.mjs';

const makeFixture = () => createFixture({ id: randomUUID(), name: 'Nazar-test' });
test('configured test business has all three consent states and only synthetic rows', () => {
  const f = makeFixture();
  assert.equal(f.businesses.length, 1);
  assert.equal(f.customers.length, 3);
  assert.equal(f.signups.length, 3);
  assert.equal(f.catering_requests.length, 1);
  assert.equal(f.offers.length, 1);
  for (const b of f.businesses) assert.deepEqual(f.customers.filter(c => c.business_id === b.id)
    .map(c => c.email_status), ['subscribed', 'not_subscribed', 'unsubscribed']);
  assert.equal(f.offers.some(o => o.active), false);
  for (const table of ['businesses', 'customers', 'signups', 'catering_requests', 'offers'])
    assert.equal(f[table].every(row => row.is_test), true);
});
test('fixture rejects real contact data, unmarked rows and invalid ownership', () => {
  for (const change of [
    f => { f.customers[0].email = 'person@gmail.com'; },
    f => { f.signups[0].is_test = false; },
    f => { f.signups[0].business_id = randomUUID(); },
    f => { f.signups[0].email = 'person@gmail.com'; },
    f => { f.signups[0].phone = '+12035550123'; },
    f => { f.signups[0].name = 'Someone else'; },
    f => { f.offers[0].active = true; },
  ]) {
    const f = makeFixture(); change(f); assert.throws(() => validateFixture(f));
  }
});
test('seed preserves all required flags and fails before inserts for missing schema', () => {
  const sql = renderSeedSql(makeFixture());
  assert.ok(sql.indexOf('information_schema.columns') < sql.indexOf('INSERT INTO'));
  assert.match(sql, /No flags will be silently omitted/);
  assert.match(sql, /app\.k3_test_environment/);
  assert.ok(sql.indexOf('refuses to retag') < sql.indexOf('INSERT INTO'));
  assert.equal(sql.match(/INSERT INTO core\./g).length, 9);
  assert.doesNotMatch(sql, /CREATE TABLE|ALTER TABLE|DROP |TRUNCATE|http|secret|password/i);
  assert.ok(sql.startsWith('BEGIN;'));
  assert.ok(sql.endsWith('COMMIT;\n'));
});
