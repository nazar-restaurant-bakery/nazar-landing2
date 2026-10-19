import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
    f => { f.customers[0].identity_key = `${f.businesses[0].id}:email:${f.customers[0].email}`; },
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

test('actual reviewed baseline and markers accept the seed and reuse its identity for idempotent Preview submission', async t => {
  const runtime = process.env.PGLITE_MODULE
    || new URL('../../../tmp/test-db-tools/node_modules/@electric-sql/pglite/dist/index.js', import.meta.url).href;
  const { PGlite } = await import(runtime);
  const db = new PGlite();
  t.after(() => db.close());
  const baseline = await readFile(new URL('../supabase/baselines/20261019_application_schema.sql', import.meta.url), 'utf8');
  const markers = await readFile(new URL('../supabase/migrations/20261019000100_test_record_markers.sql', import.meta.url), 'utf8');
  // Read the existing compatibility ID; do not invent a new target or rewrite
  // historical constants. PGlite accepts SQL, not psql client meta-commands.
  const businessId = baseline.match(/CONSTRAINT businesses_id_check CHECK \(\(id = '([0-9a-f-]+)'::uuid\)\)/)?.[1];
  assert.ok(businessId, 'Existing baseline business guard must be explicit');
  assert.equal((baseline.match(/^\\(?:un)?restrict\s+\S+\r?$/gm) || []).length, 2);
  const sqlOnly = baseline.replace(/^\\(?:un)?restrict\s+\S+\r?$/gm, '');
  await db.exec(`CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';`);
  await db.exec(sqlOnly);
  await db.exec(markers);
  const fixture = createFixture({ id: businessId, name: 'Nazar-test' });
  await db.exec("SET app.k3_test_environment='isolated-test';");
  await db.exec(renderSeedSql(fixture));
  const counts = async () => (await db.query(`SELECT
    (SELECT count(*)::int FROM core.businesses) businesses,
    (SELECT count(*)::int FROM core.customers) customers,
    (SELECT count(*)::int FROM core.signups) signups,
    (SELECT count(*)::int FROM core.catering_requests) catering_requests,
    (SELECT count(*)::int FROM core.offers) offers,
    (SELECT count(*)::int FROM core.signup_request_keys) request_keys`)).rows[0];
  assert.deepEqual(await counts(), { businesses: 1, customers: 3, signups: 3, catering_requests: 1, offers: 1, request_keys: 0 });
  const statuses = (await db.query('SELECT email_status FROM core.customers ORDER BY email_status')).rows.map(row => row.email_status);
  assert.deepEqual(statuses, ['not_subscribed', 'subscribed', 'unsubscribed']);
  for (const table of ['businesses', 'customers', 'signups', 'catering_requests', 'offers']) {
    assert.equal((await db.query(`SELECT bool_and(is_test) marked FROM core.${table}`)).rows[0].marked, true, table);
  }
  const selected = fixture.customers.find(customer => customer.email_status === 'not_subscribed');
  assert.equal(selected.identity_key, `email:${selected.email}`);
  const requestId = randomUUID();
  const params = [requestId, businessId, selected.name, selected.email, null, 'website_vip_page', true, false, {}, null];
  const submit = () => db.query('SELECT public.submit_signup_once($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::text,$7::boolean,$8::boolean,$9::jsonb,$10::jsonb)', params);
  await submit();
  assert.deepEqual(await counts(), { businesses: 1, customers: 3, signups: 4, catering_requests: 1, offers: 1, request_keys: 1 });
  const customer = (await db.query('SELECT id,identity_key,is_test FROM core.customers WHERE email=$1', [selected.email])).rows;
  assert.deepEqual(customer, [{ id: selected.id, identity_key: selected.identity_key, is_test: true }]);
  assert.equal((await db.query('SELECT count(*)::int count FROM core.signups WHERE email=$1 AND is_test', [selected.email])).rows[0].count, 2);
  await submit();
  assert.deepEqual(await counts(), { businesses: 1, customers: 3, signups: 4, catering_requests: 1, offers: 1, request_keys: 1 });
});
