import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../tools/test-env/recovery-validation.mjs';

const runtime = process.env.PGLITE_MODULE
  || new URL('../../../tmp/test-db-tools/node_modules/@electric-sql/pglite/dist/index.js', import.meta.url).href;
const { PGlite } = await import(runtime);
const captureSource = await readFile(new URL('../tools/test-env/capture-schema.py', import.meta.url), 'utf8');
function sourceSql(name) {
  const raw = captureSource.match(new RegExp(name + ' = """([\\s\\S]*?)"""'))?.[1];
  assert.ok(raw, name + ' missing');
  // Current Python literals contain only paired backslashes (regex escapes).
  // Refuse a new Python escape instead of silently testing different SQL.
  assert.ok(!raw.replaceAll('\\\\', '').includes('\\'), 'unsupported Python SQL literal escape');
  return raw.replaceAll('\\\\', '\\');
}
async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec("CREATE SCHEMA auth; CREATE SCHEMA core; CREATE TABLE auth.users(id uuid PRIMARY KEY);"
    + "CREATE TABLE core.crm_staff(auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id),active boolean NOT NULL DEFAULT true);"
    + "CREATE TABLE public.catering_orders(id uuid PRIMARY KEY,customer_name text,customer_email text,payload jsonb,amount numeric);"
    + "CREATE INDEX orders_name_idx ON public.catering_orders(customer_name);"
    + "ALTER TABLE public.catering_orders ENABLE ROW LEVEL SECURITY;"
    + "CREATE POLICY no_public_rows ON public.catering_orders USING(false);"
    + "CREATE VIEW public.order_summary AS SELECT id,amount FROM public.catering_orders;"
    + "CREATE FUNCTION public.example_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;"
    + "CREATE TRIGGER synthetic_trigger BEFORE INSERT ON public.catering_orders FOR EACH ROW EXECUTE FUNCTION public.example_trigger();"
    + "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO PUBLIC;");
  const staffId = randomUUID(), ids = Array.from({ length: 4 }, () => randomUUID());
  await db.query('INSERT INTO auth.users VALUES($1)', [staffId]);
  await db.query('INSERT INTO core.crm_staff(auth_user_id) VALUES($1)', [staffId]);
  for (const [i, id] of ids.entries()) await db.query(
    'INSERT INTO public.catering_orders VALUES($1,$2,$3,$4,$5)',
    [id, 'INTERNAL TEST ' + (i + 1), 'synthetic' + (i + 1) + '@example.invalid',
      JSON.stringify({ fixture: true, unicode: 'ş', nested: [null, true, i] }), 15.25 + i]);
  const execute = async sql => (await db.exec(sql)).flatMap(r => r.rows ?? [])[0]?.jsonb_build_object;
  return { db, ids, staffId, execute };
}
test('current catalog SQL executes on actual isolated PostgreSQL catalogs, types, constraints, policies and ACLs', async t => {
  const f = await fixture(t);
  const catalog = await f.execute(sourceSql('CATALOG_SQL'));
  assert.equal(catalog.read_only, 'on');
  assert.ok(catalog.server_version_num >= 170000);
  const kinds = [...new Set(catalog.objects.map(o => o.kind))].sort();
  assert.deepEqual(kinds, ['constraint', 'default_acl', 'policy', 'relation', 'routine', 'rule', 'schema', 'trigger', 'type']);
  assert.ok(catalog.objects.every(o => ['public', 'core'].includes(o.schema_name)));
});
test('current sandbox SQL proves exact-four gates, raw UTF8 hash and anonymous unknown-role staff', async t => {
  const f = await fixture(t), sql = sourceSql('SANDBOX_RECOVERY_SQL');
  const recovery = await f.execute(sql);
  assert.equal(recovery.total, 4); assert.equal(recovery.marked, 4); assert.equal(recovery.staff_count, 1);
  assert.equal(JSON.parse(recovery.rows_json).length, 4);
  assert.equal(sha256(recovery.rows_json), recovery.rows_sha256);
  const staff = JSON.parse(recovery.staff_json);
  assert.deepEqual(staff, [{ staff_ref: 'sandbox-staff-1', active: true, auth_linked: true, role: null }]);
  assert.ok(!recovery.staff_json.includes(f.staffId));
  const extraId = randomUUID();
  await f.db.query('INSERT INTO public.catering_orders(id,customer_name,customer_email) VALUES($1,$2,$3)',
    [extraId, 'INTERNAL TEST extra', 'extra@example.invalid']);
  let result = await f.execute(sql);
  assert.equal(result.rows_json, null); assert.equal(result.staff_json, null); assert.equal(result.rows_sha256, null);
  await f.db.query('DELETE FROM public.catering_orders WHERE id=$1', [extraId]);
  await f.db.query('UPDATE public.catering_orders SET customer_email=$1 WHERE id=$2', ['not-reserved@gmail.com', f.ids[0]]);
  result = await f.execute(sql); assert.equal(result.rows_json, null); assert.equal(result.marked, 3);
  await f.db.query('UPDATE public.catering_orders SET customer_email=$1,customer_name=$2 WHERE id=$3',
    ['synthetic1@example.invalid', 'Unmarked name', f.ids[0]]);
  result = await f.execute(sql); assert.equal(result.rows_json, null); assert.equal(result.marked, 3);
  await f.db.query('UPDATE public.catering_orders SET customer_name=$1 WHERE id=$2', ['INTERNAL TEST 1', f.ids[0]]);
  await f.db.exec('DELETE FROM core.crm_staff');
  result = await f.execute(sql); assert.equal(result.rows_json, null); assert.equal(result.staff_count, 0);
});
