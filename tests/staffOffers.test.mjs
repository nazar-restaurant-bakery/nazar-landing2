import assert from 'node:assert/strict';
import test from 'node:test';
import { loadStaffOffers, validStaffOffers, staffOfferDate } from '../src/lib/staffOffers.ts';

const businessId = '11111111-1111-4111-8111-111111111111';
const offer = (status, number = 1) => ({
  id: `synthetic-${number}`, name: `Synthetic ${status}`, description: null,
  code: null, channel_target: 'clover', starts_at: '2026-10-01', ends_at: '2026-10-31',
  active: status !== 'inactive', offer_status: status,
});

test('staff catalogue includes live, scheduled, ended and inactive offers without filtering', async () => {
  const calls = [];
  const rows = ['live', 'scheduled', 'ended', 'inactive'].map(offer);
  const result = await loadStaffOffers(async (name, params) => {
    calls.push([name, params]);
    return { data: name === 'crm_staff_authorized_v1' ? true : rows, error: null };
  }, businessId);
  assert.deepEqual(calls, [['crm_staff_authorized_v1', undefined], ['list_offers', { p_business_id: businessId }]]);
  assert.deepEqual(result, { status: 'ready', offers: rows });
});

test('unauthorized and expired sessions never request a private catalogue or public fallback', async () => {
  for (const response of [
    { data: false, error: null },
    { data: null, error: { code: '42501' } },
    { data: null, error: { code: 'PGRST301' } },
    { data: null, error: { status: 403 } },
  ]) {
    const calls = [];
    const result = await loadStaffOffers(async (name) => { calls.push(name); return response; }, businessId);
    assert.deepEqual(result, { status: 'denied' });
    assert.deepEqual(calls, ['crm_staff_authorized_v1']);
  }
});

test('authorization or catalogue network failures remain unknown rather than zero offers', async () => {
  assert.deepEqual(await loadStaffOffers(async () => { throw new Error('offline'); }, businessId), { status: 'unavailable' });
  assert.deepEqual(await loadStaffOffers(async () => ({ data: null, error: { code: 'NETWORK_ERROR' } }), businessId), { status: 'unavailable' });
  for (const payload of [null, {}, [offer('unknown')], [{ ...offer('live'), active: 'true' }], [{ ...offer('live'), ends_at: '2026-02-30' }]]) {
    assert.deepEqual(await loadStaffOffers(async (name) => ({ data: name === 'crm_staff_authorized_v1' ? true : payload, error: null }), businessId), { status: 'unavailable' });
  }
  assert.deepEqual(await loadStaffOffers(async () => ({ data: 'true', error: null }), businessId), { status: 'unavailable' });
});

test('a valid empty catalogue is distinct from denied or unavailable reads', async () => {
  assert.equal(validStaffOffers([]), true);
  assert.deepEqual(await loadStaffOffers(async (name) => ({ data: name === 'crm_staff_authorized_v1' ? true : [], error: null }), businessId), { status: 'ready', offers: [] });
  assert.deepEqual(await loadStaffOffers(async (name) => name === 'crm_staff_authorized_v1'
    ? { data: true, error: null } : { data: null, error: { code: '42501' } }, businessId), { status: 'denied' });
  let called = false;
  assert.deepEqual(await loadStaffOffers(async () => { called = true; return { data: [], error: null }; }, ''), { status: 'unavailable' });
  assert.equal(called, false);
});

test('calendar-only dates stay on the intended New York day and malformed dates are safe', () => {
  assert.equal(staffOfferDate(null), '—');
  for (const date of ['broken', '2026-02-30', '2026-10-18T00:00:00Z']) assert.equal(staffOfferDate(date), 'Geçersiz tarih');
  assert.match(staffOfferDate('2026-10-18'), /^18 .*2026$/);
  assert.match(staffOfferDate('2026-01-01'), /^1 .*2026$/);
});
