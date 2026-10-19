import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const FILES = ['schema.sql', 'catering-orders.json', 'staff-anonymous.json', 'recovery-source-proof.json'];
const LIMITS = { 'schema.sql': 64 * 1024 * 1024, 'catering-orders.json': 8 * 1024 * 1024,
  'staff-anonymous.json': 128 * 1024, 'recovery-source-proof.json': 128 * 1024 };
const PROOF_KEYS = new Set(['capturedAtUtc', 'expectedCateringRows', 'expectedStaffRows',
  'cateringRowsSha256', 'allRowsReviewedSynthetic', 'schemaDumpSucceeded', 'authPlatformPreserved',
  'markerClassificationPassed', 'freeFormReviewPending', 'localRestoreProof', 'staffAnonymousSha256', 'scope']);
const STAFF_REQUIRED_KEYS = new Set(['staff_ref', 'active', 'auth_linked']);
const STAFF_KEYS = new Set([...STAFF_REQUIRED_KEYS, 'role']);
const SENSITIVE_KEY = /password|passwd|api[_-]?key|(?:access|refresh)[_-]?token|jwt|secret|authorization|cookie|credential/i;
const JWT_VALUE = /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:$|[^A-Za-z0-9_-])/;
const SECRET_VALUE = /\b(?:sb_secret_[A-Za-z0-9_-]{12,}|sk_(?:live|test)_[A-Za-z0-9]{12,})\b/;
const TEST_EMAIL = /^[^\s@]+@(?:[^\s@]+\.)?example\.(?:com|net|org|invalid)$|^[^\s@]+@[^\s@]+\.invalid$/i;

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const nonempty = v => v !== null && v !== '' && v !== false && v !== undefined;
const sameKeys = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const safeField = key => /^[a-z_][a-z0-9_]{0,62}$/i.test(key) ? key : '<dynamic-key>';

// JSON.parse's source context keeps exact numeric lexemes. Never serialize parsed
// order rows back to the recovery file: unsafe integers and decimals stay intact.
function normalizedNumber(source) {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!m) throw new Error('invalid_json_number');
  let digits = (m[2] + (m[3] || '')).replace(/^0+/, '');
  if (!digits) return '0';
  let exponent = BigInt(m[4] || '0') - BigInt((m[3] || '').length);
  const trailing = /0+$/.exec(digits)?.[0].length || 0;
  if (trailing) { digits = digits.slice(0, -trailing); exponent += BigInt(trailing); }
  return m[1] + digits + 'e' + exponent.toString();
}

function valueTree(text) {
  let sourceAvailable = true;
  const tree = JSON.parse(text, function (key, value, context) {
    if (typeof value === 'number') {
      if (typeof context?.source !== 'string') { sourceAvailable = false; return null; }
      return { k: 'number', v: normalizedNumber(context.source) };
    }
    if (value === null) return { k: 'null' };
    if (typeof value === 'string' || typeof value === 'boolean') return { k: typeof value, v: value };
    if (Array.isArray(value)) return { k: 'array', v: value };
    return { k: 'object', v: Object.keys(value).sort().map(k => [k, value[k]]) };
  });
  if (!sourceAvailable) throw new Error('node_source_context_required');
  return tree;
}

// Content equality ignores object-key order, row order, and equivalent numeric
// spellings; it preserves every field, array order, string, null, and exact number.
export function compareRecoveryRows(sourceText, readbackText) {
  let source, readback;
  try { source = JSON.parse(sourceText); readback = JSON.parse(readbackText); }
  catch { return { matches: false, reason: 'invalid_json' }; }
  if (!Array.isArray(source) || !Array.isArray(readback)) return { matches: false, reason: 'rows_not_arrays' };
  if (source.length !== readback.length) return { matches: false, reason: 'row_count_mismatch' };
  function indexed(text) {
    const tree = valueTree(text);
    if (tree.k !== 'array') throw new Error('rows_not_arrays');
    const rows = new Map();
    for (const row of tree.v) {
      if (row.k !== 'object') throw new Error('row_not_object');
      const id = row.v.find(([k]) => k === 'id')?.[1];
      if (!id || !['string', 'number'].includes(id.k)) throw new Error('row_id_missing');
      const key = JSON.stringify(id);
      if (rows.has(key)) throw new Error('duplicate_row_id');
      rows.set(key, JSON.stringify(row));
    }
    return rows;
  }
  try {
    const a = indexed(sourceText), b = indexed(readbackText);
    for (const [key, row] of a) if (b.get(key) !== row)
      return { matches: false, reason: 'row_value_mismatch' };
    return { matches: true, reason: null };
  } catch (error) {
    return { matches: false, reason: String(error.message).replace(/[^a-z_]/g, '') };
  }
}

function inspectRows(rows, issues, fieldNames) {
  if (!Array.isArray(rows)) { issues.push({ code: 'rows_not_array' }); return; }
  const ids = new Set();
  let firstKeys;
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      issues.push({ code: 'row_not_object', rowNumber: index + 1 }); continue;
    }
    const keys = Object.keys(row);
    if (!firstKeys) firstKeys = keys;
    else if (!sameKeys(firstKeys, keys)) issues.push({ code: 'row_column_set_differs', rowNumber: index + 1 });
    if (!['string', 'number'].includes(typeof row.id) || String(row.id).length === 0)
      issues.push({ code: 'row_id_missing', rowNumber: index + 1 });
    else if (ids.has(String(row.id))) issues.push({ code: 'duplicate_row_id', rowNumber: index + 1 });
    else ids.add(String(row.id));
    walk(row, []);
  }
  function walk(value, path) {
    if (Array.isArray(value)) { value.forEach(v => walk(v, path.concat('[]'))); return; }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        const current = path.concat(key);
        const safePath = current.map(safeField).join('.');
        if (path.length === 0) fieldNames.add(safeField(key));
        if (SENSITIVE_KEY.test(key) && nonempty(nested))
          issues.push({ code: 'possible_credential_field', field: safePath });
        if (/^(?:auth_user_id|author_id|created_by_auth_id|updated_by_auth_id)$/i.test(key) && nonempty(nested))
          issues.push({ code: 'auth_identity_reference_requires_review', field: safePath });
        walk(nested, current);
      }
    } else if (typeof value === 'string') {
      const safePath = path.map(safeField).join('.');
      if (JWT_VALUE.test(value) || SECRET_VALUE.test(value))
        issues.push({ code: 'possible_credential_value', field: safePath });
      if (/email/i.test(path.at(-1) || '') && value !== '' && !TEST_EMAIL.test(value))
        issues.push({ code: 'nonreserved_contact_requires_review', field: safePath });
    }
  }
}

async function readBounded(directory, name) {
  const file = join(directory, name);
  const st = await lstat(file);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error('nonregular_artifact:' + name);
  if (st.size === 0 || st.size > LIMITS[name]) throw new Error('artifact_size_invalid:' + name);
  const bytes = await readFile(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('invalid_utf8:' + name);
  return { name, bytes, text, sha256: sha256(bytes) };
}

export async function validateRecoveryPackage(directory, options = {}) {
  directory = resolve(directory);
  const st = await lstat(directory);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('nonregular_recovery_directory');
  const artifacts = await Promise.all(FILES.map(name => readBounded(directory, name)));
  const byName = Object.fromEntries(artifacts.map(f => [f.name, f]));
  const issues = [], fields = new Set();
  const parse = name => {
    try { return JSON.parse(byName[name].text); }
    catch { issues.push({ code: 'invalid_json', file: name }); return null; }
  };
  const rows = parse('catering-orders.json'), staff = parse('staff-anonymous.json'), proof = parse('recovery-source-proof.json');
  inspectRows(rows, issues, fields);
  const expectedRows = options.expectedCateringRows ?? 4;
  const expectedStaff = options.expectedStaffRows ?? 1;
  if (rows?.length !== expectedRows) issues.push({ code: 'unexpected_catering_row_count' });
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) issues.push({ code: 'source_proof_invalid' });
  else {
    if (Object.keys(proof).some(k => !PROOF_KEYS.has(k))) issues.push({ code: 'source_proof_unknown_field' });
    if (proof.expectedCateringRows !== expectedRows || proof.expectedStaffRows !== expectedStaff)
      issues.push({ code: 'declared_counts_mismatch' });
    if (!/^[a-f0-9]{64}$/.test(proof.cateringRowsSha256 || '')
        || proof.cateringRowsSha256 !== byName['catering-orders.json'].sha256)
      issues.push({ code: 'source_rows_hash_mismatch' });
    if (!/^[a-f0-9]{64}$/.test(proof.staffAnonymousSha256 || '')
        || proof.staffAnonymousSha256 !== byName['staff-anonymous.json'].sha256)
      issues.push({ code: 'staff_anonymous_hash_mismatch' });
    if (proof.scope !== 'read_only_source_capture_not_reset_or_restore') issues.push({ code: 'capture_scope_invalid' });
    for (const [key, code] of [['allRowsReviewedSynthetic', 'synthetic_review_not_attested'],
      ['schemaDumpSucceeded', 'schema_dump_not_attested'], ['authPlatformPreserved', 'auth_preservation_not_attested']])
      if (proof[key] !== true) issues.push({ code });
    if (proof.markerClassificationPassed !== true) issues.push({ code: 'marker_classification_not_attested' });
    if (proof.freeFormReviewPending !== false) issues.push({ code: 'free_form_review_pending' });
    if (typeof proof.capturedAtUtc !== 'string' || !Number.isFinite(Date.parse(proof.capturedAtUtc)))
      issues.push({ code: 'capture_time_missing' });
  }
  if (!Array.isArray(staff) || staff.length !== expectedStaff) issues.push({ code: 'unexpected_staff_row_count' });
  const staffRefs = new Set();
  for (const row of Array.isArray(staff) ? staff : []) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || (Object.keys(row).some(k => !STAFF_KEYS.has(k)) || [...STAFF_REQUIRED_KEYS].some(k => !Object.hasOwn(row, k)))) {
      issues.push({ code: 'staff_identity_free_fields_required' }); continue;
    }
    if (!/^(?:staff_[0-9]{3}|sandbox-staff-[1-9][0-9]*)$/.test(row.staff_ref) || staffRefs.has(row.staff_ref))
      issues.push({ code: 'staff_pseudonym_invalid' });
    else staffRefs.add(row.staff_ref);
    if ((row.role !== undefined && row.role !== null && !['owner', 'staff'].includes(row.role))
        || typeof row.active !== 'boolean' || row.auth_linked !== true)
      issues.push({ code: 'staff_mapping_invalid' });
  }
  const schema = byName['schema.sql'].text;
  if (!/CREATE TABLE\s+(?:"?public"?\.)"?catering_orders"?\s*\(/i.test(schema)
      || !/CREATE TABLE\s+(?:"?core"?\.)"?crm_staff"?\s*\(/i.test(schema))
    issues.push({ code: 'required_application_table_missing' });
  if (/^\s*(?:COPY|INSERT\s+INTO)\s+(?:"?auth"?\.|"?storage"?\.)/im.test(schema)
      || /^\s*CREATE\s+(?:TABLE|SCHEMA)\s+"?auth"?(?:\.|\s|;)/im.test(schema))
    issues.push({ code: 'auth_or_storage_export_detected' });
  if (/^\s*COPY\s+.+\s+FROM\s+stdin\s*;/im.test(schema))
    issues.push({ code: 'schema_contains_copy_data' });
  if (JWT_VALUE.test(schema) || SECRET_VALUE.test(schema)) issues.push({ code: 'possible_credential_in_schema' });
  const deduped = [...new Map(issues.map(issue => [JSON.stringify(issue), issue])).values()];
  let readback = { provided: false, matches: false, reason: null };
  if (options.readbackText !== undefined) readback = {
    provided: true, ...compareRecoveryRows(byName['catering-orders.json'].text, options.readbackText),
  };
  if (readback.provided && !readback.matches) deduped.push({ code: 'readback_mismatch', reason: readback.reason });
  return {
    formatVersion: 1, scope: 'private_local_application_recovery',
    checkedAtUtc: new Date().toISOString(),
    packageIntegrityVerified: deduped.length === 0,
    restorationVerified: false, resetAuthorized: false,
    sourceRowsMatchDeclaredByteHash: proof?.cateringRowsSha256 === byName['catering-orders.json'].sha256,
    anonymousStaffMatchesDeclaredByteHash: proof?.staffAnonymousSha256 === byName['staff-anonymous.json'].sha256,
    syntheticContentReviewAttested: proof?.allRowsReviewedSynthetic === true,
    markerClassificationPassed: proof?.markerClassificationPassed === true,
    freeFormReviewPending: proof?.freeFormReviewPending !== false,
    counts: { cateringOrders: Array.isArray(rows) ? rows.length : null,
      anonymousStaffMappings: Array.isArray(staff) ? staff.length : null },
    rowFieldNames: [...fields].sort(),
    artifacts: artifacts.map(f => ({ file: f.name, bytes: f.bytes.length, sha256: f.sha256 })),
    staffIdentity: { exported: false, authPlatformPreserved: proof?.authPlatformPreserved === true,
      privateRelinkRequired: true, pseudonymCount: staffRefs.size,
      roleUnknownCount: Array.isArray(staff) ? staff.filter(s => s?.role === null || s?.role === undefined).length : null },
    localReadback: readback, issues: deduped,
    limitations: ['Hashes establish file integrity against the declared source hash, not capture authenticity.',
      'Application schema and four orders are private recovery material; this is not an Auth or full-platform backup.',
      'Staff identity is intentionally absent; preserved Auth users require a separate private relink.',
      'An independent successful local schema restore and row readback are required before claiming restoration.'],
  };
}
