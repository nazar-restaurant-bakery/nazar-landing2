import assert from 'node:assert/strict';
import test from 'node:test';
import { campaignCheckLabel, campaignCheckTime, loadCampaignCheck, readCampaignChecks, validCampaignCheck } from '../src/lib/campaignEligibility.ts';

const businessId = '11111111-1111-4111-8111-111111111111';
const orderId = 'SYNTHETICORDER';
const ready = (changes = {}) => ({ known: true, eligible: true, reason: 'eligible',
  campaign: { id: 'synthetic', name: 'INTERNAL TEST $30 pickup simit', benefitType: 'item', targetItemId: 'SYNTHETICITEM' },
  remaining: { person: 1, total: 12, perOrder: 1 }, checkedAt: '2026-10-20T20:00:00Z', snapshotAt: '2026-10-20T19:55:00Z', ...changes });

test('read-only RPC uses only configured business and Clover order ID, with no actor or writer', async () => {
  const calls = [];
  const data = ready();
  assert.deepEqual(await loadCampaignCheck(async (name, params) => {
    calls.push([name, params]); return { data, error: null };
  }, businessId, orderId), { status: 'ready', check: data });
  assert.deepEqual(calls, [['campaign_eligibility_check_v1', { p_business_id: businessId, p_clover_order_id: orderId }]]);
});

for (const reason of ['below_minimum', 'channel_mismatch', 'customer_ineligible', 'period_limit', 'total_limit', 'outside_window', 'no_active_campaign', 'no_item_campaign', 'already_applied']) {
  test(`confirmed ${reason} remains a denied eligibility, not a transport failure`, async () => {
    const data = ready({ eligible: false, reason });
    assert.deepEqual(await loadCampaignCheck(async () => ({ data, error: null }), businessId, orderId), { status: 'ready', check: data });
  });
}
for (const reason of ['order_not_synced', 'order_unmatched', 'amount_evidence_missing', 'ambiguous_campaign']) {
  test(`${reason} remains unknown rather than no benefit`, async () => {
    const data = ready({ known: false, eligible: null, reason, campaign: null, remaining: null });
    assert.deepEqual(await loadCampaignCheck(async () => ({ data, error: null }), businessId, orderId), { status: 'ready', check: data });
  });
}
for (const error of [{ code: '42501' }, { code: 'PGRST301' }, { status: 403 }, { status: 401 }]) {
  test(`scope/session denial ${JSON.stringify(error)} cannot be displayed as ordinary ineligibility`, async () => {
    assert.deepEqual(await loadCampaignCheck(async () => ({ data: null, error }), businessId, orderId), { status: 'denied' });
  });
}
test('network errors and malformed responses remain unknown without an automatic second request', async () => {
  let calls = 0;
  assert.deepEqual(await loadCampaignCheck(async () => { calls++; throw Error('offline'); }, businessId, orderId), { status: 'unavailable' });
  assert.equal(calls, 1);
  for (const data of [null, {}, ready({ known: false }), ready({ eligible: null }), ready({ campaign: null }),
    ready({ checkedAt: 'bad date' }), ready({ snapshotAt: 'bad date' }), ready({ remaining: { person: -1, total: 1, perOrder: 1 } }),
    ready({ reason: 'not_eligible' }), ready({ remaining: { person: 1, total: 1, perOrder: 1.5 } }),
    ready({ campaign: { ...ready().campaign, benefitType: 'discount' } }),
    ready({ campaign: { ...ready().campaign, targetItemId: null } }),
    ready({ remaining: { person: 0, total: 2, perOrder: 1 } })]) {
    assert.equal(validCampaignCheck(data), false);
    assert.deepEqual(await loadCampaignCheck(async () => ({ data, error: null }), businessId, orderId), { status: 'unavailable' });
  }
  assert.deepEqual(await loadCampaignCheck(async () => ({ data: null, error: { code: 'PGRST202' } }), businessId, orderId), { status: 'unavailable' });
});
test('missing configured business or order never makes a request', async () => {
  const never = () => { throw Error('must not be called'); };
  assert.deepEqual(await loadCampaignCheck(never, '', orderId), { status: 'unavailable' });
  assert.deepEqual(await loadCampaignCheck(never, businessId, ''), { status: 'unavailable' });
});
test('benefit label never turns another item or a discount into simit', () => {
  assert.equal(campaignCheckLabel(ready()), 'simit');
  assert.equal(campaignCheckLabel(ready({ campaign: { ...ready().campaign, name: 'SİMİT ikramı' } })), 'simit');
  assert.equal(campaignCheckLabel(ready({ campaign: { ...ready().campaign, name: 'Simitlik ürün' } })), 'item');
  assert.equal(campaignCheckLabel(ready({ campaign: { ...ready().campaign, name: 'Kahve ikramı' } })), 'item');
  assert.equal(campaignCheckLabel(ready({ campaign: { ...ready().campaign, benefitType: 'discount' } })), 'item');
  assert.equal(campaignCheckLabel(null), 'simit');
});
test('source dates are safe and explicitly use New York time', () => {
  assert.equal(campaignCheckTime(null), '—');
  assert.equal(campaignCheckTime('bad'), '—');
  assert.match(campaignCheckTime('2026-10-20T20:00:00Z'), /16:00/);
});
test('batches are bounded, duplicate IDs read once, and stale completions are discarded', async () => {
  let active = 0, max = 0, callCount = 0;
  const accepted = [];
  await readCampaignChecks(async () => { callCount++; active++; max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--; return { data: ready(), error: null };
  }, businessId, ['a', 'b', 'c', 'd', 'e', 'f', 'a'], (id) => accepted.push(id), () => true);
  assert.equal(callCount, 6); assert.equal(max, 4); assert.equal(accepted.length, 6);
  let current = true;
  const pending = [];
  const late = readCampaignChecks(() => new Promise(resolve => pending.push(resolve)), businessId,
    ['a', 'b', 'c', 'd', 'e'], () => assert.fail('stale result rendered'), () => current);
  current = false;
  for (const resolve of pending) resolve({ data: ready(), error: null });
  await late;
  assert.equal(pending.length, 4);
});
