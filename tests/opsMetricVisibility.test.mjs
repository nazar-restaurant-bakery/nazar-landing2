import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { opsCopy } from '../src/lib/opsCopy.ts';

const load = async (path, substitutions = {}) => {
  let code = await readFile(new URL(path, import.meta.url), 'utf8');
  for (const [from, to] of Object.entries(substitutions)) code = code.replace(from, to);
  return import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(code)).toString('base64'));
};
const { observedSiteFailure } = await load('../src/components/staff/ops/opsMetricVisibility.ts');
const { opsMetricNumber } = await load('../src/components/staff/ops/opsFormat.ts', { 'import { opsCopy as c } from "../../../lib/staffCopy";': `const c = ${JSON.stringify(opsCopy)};` });
const time = '2026-10-19T14:00:01Z';
const connection = { source: 'site', status: 'error', last_error: 'site_http_503', last_ok_at: '2026-10-18T14:00:01Z', note: null, capabilities: [] };
const receipt = { id: 'synthetic-action', request_key: 'synthetic-key', action: 'collect', requested_by: 'synthetic-staff', requested_at: '2026-10-19T14:00:00Z', status: 'failed', result: {}, finished_at: '2026-10-19T14:00:20Z' };
const ping = [['is_up', 0], ['http_status', 503], ['response_ms', 155]].map(([metric, value_num]) => ({ source: 'site', metric, value_num, value_text: null, collected_at: time, collector: 'edge_fn', period_start: null, period_end: null, is_test: false }));

test('fractional Google Ads attribution is preserved without turning 0.5 into one conversion', () => {
  assert.equal(opsMetricNumber(0.5, 'google_ads', 'conversions_7d'), '0,5');
  assert.equal(opsMetricNumber(0.25, 'google_ads', 'conversions_7d'), '0,25');
  assert.equal(opsMetricNumber(3, 'google_ads', 'conversions_7d'), '3');
  assert.equal(opsMetricNumber(null, 'google_ads', 'conversions_7d'), '—');
  assert.equal(opsMetricNumber(450, 'google_ads', 'clicks_7d'), '450');
});
test('a measured failed ping can display outage, HTTP status and duration with its error badge', () => {
  const observed = observedSiteFailure(ping, connection, [receipt]);
  assert.equal(observed.get('is_up').value_num, 0);
  assert.equal(observed.get('http_status').value_num, 503);
  assert.equal(observed.get('response_ms').value_num, 155);
  assert.deepEqual([...observed.keys()], ['is_up', 'http_status', 'response_ms']);
});
test('prior success, prior failed attempts and network errors cannot masquerade as a fresh measured outage', () => {
  assert.equal(observedSiteFailure(ping.map(metric => ({ ...metric, collected_at: '2026-10-18T14:00:01Z' })), connection, [receipt]), null);
  assert.equal(observedSiteFailure(ping.map(metric => ({ ...metric, value_num: metric.metric === 'is_up' ? 1 : metric.metric === 'http_status' ? 200 : metric.value_num })), connection, [receipt]), null);
  assert.equal(observedSiteFailure(ping, { ...connection, last_error: 'provider_network_error' }, [receipt]), null);
  assert.equal(observedSiteFailure(ping, { ...connection, last_error: 'site_http_500' }, [receipt]), null);
  assert.equal(observedSiteFailure(ping, connection, [receipt, { ...receipt, id: 'newer', requested_at: '2026-10-19T15:00:00Z', finished_at: '2026-10-19T15:00:20Z' }]), null);
});
test('unproven, test, mismatched and out-of-receipt measurements remain unavailable', () => {
  assert.equal(observedSiteFailure(ping, connection, null), null);
  assert.equal(observedSiteFailure(ping, connection, [{ ...receipt, status: 'running' }]), null);
  assert.equal(observedSiteFailure(ping, connection, [{ ...receipt, status: 'done' }]), null);
  assert.equal(observedSiteFailure(ping, connection, [{ ...receipt, finished_at: 'invalid' }]), null);
  assert.equal(observedSiteFailure(ping, { ...connection, status: 'connected' }, [receipt]), null);
  assert.equal(observedSiteFailure(ping.map(metric => ({ ...metric, is_test: true })), connection, [receipt]), null);
  assert.equal(observedSiteFailure(ping.map(metric => metric.metric === 'response_ms' ? { ...metric, collected_at: '2026-10-19T14:00:02Z' } : metric), connection, [receipt]), null);
  assert.equal(observedSiteFailure(ping.map(metric => ({ ...metric, collected_at: '2026-10-19T14:01:00Z' })), connection, [receipt]), null);
});
