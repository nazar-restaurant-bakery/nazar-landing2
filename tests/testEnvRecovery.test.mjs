import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, validateRecoveryPackage, compareRecoveryRows } from '../tools/test-env/recovery-validation.mjs';

const schema = '-- PostgreSQL schema-only dump\nCREATE TABLE public.catering_orders (id uuid, customer_email text, status text);\n'
  + 'CREATE TABLE core.crm_staff (auth_user_id uuid REFERENCES auth.users(id), role text, active boolean);\n';
const rows = () => Array.from({ length: 4 }, (_, i) => ({ id: randomUUID(),
  customer_name: 'INTERNAL TEST ' + (i + 1), customer_email: 'test' + (i + 1) + '@example.invalid',
  status: 'closed', amount: 15.25, payload: { checkout_session_id: 'synthetic-checkout-' + i } }));
async function fixture(t, mutate = () => {}) {
  const dir = await mkdtemp(join(tmpdir(), 'k3-recovery-validation-'));
  t.after(async () => {
    const target = resolve(dir), allowed = resolve(tmpdir()) + sep;
    assert.ok(target.startsWith(allowed) && target.slice(allowed.length).startsWith('k3-recovery-validation-'));
    await rm(target, { recursive: true, force: true });
  });
  const objects = {
    schema, rows: JSON.stringify(rows()), staff: [{ staff_ref: 'staff_001', role: 'staff', active: true, auth_linked: true }],
    proof: { capturedAtUtc: '2026-10-19T16:00:00Z', expectedCateringRows: 4, expectedStaffRows: 1,
      allRowsReviewedSynthetic: true, schemaDumpSucceeded: true, authPlatformPreserved: true,
      markerClassificationPassed: true, freeFormReviewPending: false, localRestoreProof: false,
      scope: 'read_only_source_capture_not_reset_or_restore' },
  };
  mutate(objects);
  objects.proof.cateringRowsSha256 ??= sha256(objects.rows);
  objects.proof.staffAnonymousSha256 ??= sha256(JSON.stringify(objects.staff));
  await Promise.all([
    writeFile(join(dir, 'schema.sql'), objects.schema),
    writeFile(join(dir, 'catering-orders.json'), objects.rows),
    writeFile(join(dir, 'staff-anonymous.json'), JSON.stringify(objects.staff)),
    writeFile(join(dir, 'recovery-source-proof.json'), JSON.stringify(objects.proof)),
  ]);
  return { dir, objects };
}
test('private recovery validates four exact rows and anonymous staff without copying identity into report', async t => {
  const { dir, objects } = await fixture(t);
  const report = await validateRecoveryPackage(dir);
  assert.equal(report.packageIntegrityVerified, true);
  assert.equal(report.restorationVerified, false);
  assert.equal(report.resetAuthorized, false);
  assert.deepEqual(report.counts, { cateringOrders: 4, anonymousStaffMappings: 1 });
  const serialized = JSON.stringify(report);
  for (const row of JSON.parse(objects.rows)) {
    assert.ok(!serialized.includes(row.id));
    assert.ok(!serialized.includes(row.customer_email));
  }
  assert.equal(await readFile(join(dir, 'catering-orders.json'), 'utf8'), objects.rows);
  assert.equal(report.staffIdentity.privateRelinkRequired, true);
});
test('any actual staff UUID or email field fails; no offending value appears in report', async t => {
  const identity = randomUUID();
  const { dir } = await fixture(t, f => { f.staff[0].auth_user_id = identity; f.staff[0].email = 'private@example.invalid'; });
  const report = await validateRecoveryPackage(dir);
  assert.equal(report.packageIntegrityVerified, false);
  assert.ok(report.issues.some(i => i.code === 'staff_identity_free_fields_required'));
  assert.ok(!JSON.stringify(report).includes(identity));
  assert.ok(!JSON.stringify(report).includes('private@example.invalid'));
});
test('credential keys and JWT values inside raw payload block integrity approval, without redaction', async t => {
  const token = 'eyJabcdefghi.abcdefghijkl.abcdefghijkl';
  const { dir, objects } = await fixture(t, f => {
    const data = JSON.parse(f.rows); data[0].payload.secret = token; f.rows = JSON.stringify(data);
  });
  const report = await validateRecoveryPackage(dir);
  assert.equal(report.packageIntegrityVerified, false);
  assert.ok(report.issues.some(i => i.code === 'possible_credential_field'));
  assert.ok(report.issues.some(i => i.code === 'possible_credential_value'));
  assert.ok(!JSON.stringify(report).includes(token));
  assert.equal(await readFile(join(dir, 'catering-orders.json'), 'utf8'), objects.rows);
});
test('count, source byte hash and unreviewed synthetic data each fail closed', async t => {
  for (const mutate of [
    f => { f.rows = JSON.stringify(JSON.parse(f.rows).slice(0, 3)); },
    f => { f.proof.cateringRowsSha256 = 'a'.repeat(64); },
    f => { f.proof.allRowsReviewedSynthetic = false; },
    f => { f.proof.authPlatformPreserved = false; },
  ]) {
    const { dir } = await fixture(t, mutate);
    assert.equal((await validateRecoveryPackage(dir)).packageIntegrityVerified, false);
  }
});
test('nonreserved contact, duplicate row IDs, uneven columns and Auth table exports block approval', async t => {
  for (const mutate of [
    f => { const a = JSON.parse(f.rows); a[0].customer_email = 'person@gmail.com'; f.rows = JSON.stringify(a); },
    f => { const a = JSON.parse(f.rows); a[1].id = a[0].id; f.rows = JSON.stringify(a); },
    f => { const a = JSON.parse(f.rows); delete a[0].status; f.rows = JSON.stringify(a); },
    f => { f.schema += 'CREATE TABLE auth.users (id uuid);\n'; },
    f => { f.schema += 'COPY public.catering_orders FROM stdin;\n'; },
  ]) {
    const { dir } = await fixture(t, mutate);
    assert.equal((await validateRecoveryPackage(dir)).packageIntegrityVerified, false);
  }
});
test('exact row readback preserves large integers, decimal precision, nulls and nested values', () => {
  const a = '[{"id":"a","value":9007199254740993,"decimal":1.0000000000000000001,"items":[null,true,"x"]}]';
  const same = '[{"items":[null,true,"x"],"decimal":10000000000000000001e-19,"value":9007199254740993,"id":"a"}]';
  assert.equal(compareRecoveryRows(a, same).matches, true);
  assert.equal(compareRecoveryRows(a, a.replace('9007199254740993', '9007199254740992')).matches, false);
  assert.equal(compareRecoveryRows(a, a.replace('1.0000000000000000001', '1')).matches, false);
  assert.equal(compareRecoveryRows(a, a.replace('[null,true,"x"]', '[true,null,"x"]')).matches, false);
  assert.equal(compareRecoveryRows(a, a.replace('"value":9007199254740993,', '')).matches, false);
});
test('readback ignores row order but fails changed, missing or extra values', async t => {
  const { dir, objects } = await fixture(t);
  const readback = JSON.parse(objects.rows).reverse();
  assert.equal(compareRecoveryRows(objects.rows, JSON.stringify(readback)).matches, true);
  readback[0].payload.checkout_session_id = 'changed';
  const report = await validateRecoveryPackage(dir, { readbackText: JSON.stringify(readback) });
  assert.equal(report.packageIntegrityVerified, false);
  assert.equal(report.localReadback.matches, false);
  assert.ok(report.issues.some(i => i.code === 'readback_mismatch'));
});

test('malformed JSON and dynamic payload keys never leak values through a validation error', async t => {
  assert.deepEqual(compareRecoveryRows('[{"secret":"private-value"}', '[]'), { matches: false, reason: 'invalid_json' });
  const identity = randomUUID();
  const { dir } = await fixture(t, f => {
    const data = JSON.parse(f.rows); data[0].payload[identity] = { password: 'private-value' }; f.rows = JSON.stringify(data);
  });
  const report = await validateRecoveryPackage(dir);
  assert.equal(report.packageIntegrityVerified, false);
  assert.ok(!JSON.stringify(report).includes(identity));
  assert.ok(!JSON.stringify(report).includes('private-value'));
  assert.ok(report.issues.some(i => i.field?.includes('<dynamic-key>')));
});

test('a source without a role column keeps its staff role explicitly unknown', async t => {
  for (const mode of ['omitted', 'null']) {
    const { dir } = await fixture(t, f => { if (mode === 'omitted') delete f.staff[0].role; else f.staff[0].role = null; });
    const report = await validateRecoveryPackage(dir);
    assert.equal(report.packageIntegrityVerified, true);
    assert.equal(report.staffIdentity.roleUnknownCount, 1);
  }
  const { dir } = await fixture(t, f => { f.staff[0].role = 'admin'; });
  assert.equal((await validateRecoveryPackage(dir)).packageIntegrityVerified, false);
});

test('marker-only capture remains pending until complete free-form review is attested', async t => {
  const { dir } = await fixture(t, f => {
    f.proof.allRowsReviewedSynthetic = false; f.proof.freeFormReviewPending = true;
  });
  const report = await validateRecoveryPackage(dir);
  assert.equal(report.packageIntegrityVerified, false);
  assert.equal(report.markerClassificationPassed, true);
  assert.equal(report.freeFormReviewPending, true);
  assert.ok(report.issues.some(i => i.code === 'synthetic_review_not_attested'));
  assert.ok(report.issues.some(i => i.code === 'free_form_review_pending'));
  assert.equal(report.restorationVerified, false);
  assert.equal(report.resetAuthorized, false);
});

test('producer anonymous staff hash, capture scope and sandbox pseudonym are strictly validated', async t => {
  const { dir } = await fixture(t, f => { f.staff[0].staff_ref = 'sandbox-staff-1'; f.staff[0].role = null; });
  const report = await validateRecoveryPackage(dir);
  assert.equal(report.packageIntegrityVerified, true);
  assert.equal(report.anonymousStaffMatchesDeclaredByteHash, true);
  assert.equal(report.staffIdentity.roleUnknownCount, 1);
  for (const change of [
    f => { f.proof.staffAnonymousSha256 = '0'.repeat(64); },
    f => { f.proof.scope = 'reset_approved'; },
    f => { delete f.proof.scope; },
    f => { f.staff[0].staff_ref = randomUUID(); },
  ]) {
    const { dir } = await fixture(t, change);
    assert.equal((await validateRecoveryPackage(dir)).packageIntegrityVerified, false);
  }
});
