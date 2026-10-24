import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePickupSlot, CATERING_LEAD_TIME_MS, CHECKOUT_TIME_BUFFER_MS } from '../functions/_lib/cateringPickup.ts';
import { firstPickup, pickupError, newYorkPickup, newYorkDate, isPickupClosed, PICKUP_TIMES } from '../src/lib/cateringPickup.ts';
const now = new Date('2026-10-23T14:40:00Z');
test('72 hours plus unchanged checkout reserve: exact boundary passes; one millisecond earlier fails', () => {
 const boundary = new Date(now.getTime() + CATERING_LEAD_TIME_MS + CHECKOUT_TIME_BUFFER_MS);
 assert.equal(boundary.toISOString(), '2026-10-26T15:00:00.000Z');
 assert.equal(validatePickupSlot(boundary.toISOString(), now).getTime(), boundary.getTime());
 assert.throws(() => validatePickupSlot(new Date(boundary.getTime()-1).toISOString(), now), /72 hours/);
 assert.equal(pickupError('2026-10-26','11:00',now.getTime()),null);
 assert.equal(pickupError('2026-10-26','11:00',now.getTime()+1),'lead');
});
test('19:00 inclusive, 19:30 excluded; whole and half hours only', () => {
 for (const time of ['11:00','11:30','18:30','19:00']) {
  assert.equal(pickupError('2026-10-27',time,now.getTime()),null);
  assert.ok(validatePickupSlot(newYorkPickup('2026-10-27',time),now));
 }
 for (const time of ['10:30','19:30','11:15']) {
  assert.equal(pickupError('2026-10-27',time,now.getTime()),'hours');
  assert.throws(() => validatePickupSlot(newYorkPickup('2026-10-27',time),now),/half-hour/);
 }
 assert.equal(PICKUP_TIMES.at(-1),'19:00');
});
test('Wednesday is rejected by client and server in New York regardless of input offset', () => {
 assert.equal(isPickupClosed('2026-10-28'),true);
 assert.equal(pickupError('2026-10-28','11:00',now.getTime()),'closed');
 assert.throws(() => validatePickupSlot('2026-10-28T15:00:00Z',now),/Wednesdays/);
 assert.throws(() => validatePickupSlot('2026-10-29T01:00:00+06:00',now),/Wednesdays/);
});
test('first selection advances past closing time and Wednesday without truncating the 72-hour clock', () => {
 assert.deepEqual(firstPickup(now.getTime()),{date:'2026-10-26',time:'11:00'});
 assert.deepEqual(firstPickup(Date.parse('2026-10-25T14:40:00Z')),{date:'2026-10-29',time:'11:00'});
 assert.deepEqual(firstPickup(Date.parse('2026-10-26T22:50:00Z')),{date:'2026-10-30',time:'11:00'});
 assert.deepEqual(firstPickup(Date.parse('2026-10-23T14:50:00Z')),{date:'2026-10-26',time:'11:30'});
});
test('New York DST conversion uses elapsed 72 hours and actual local day', () => {
 for (const instant of ['2026-03-05T15:40:00Z','2026-10-29T14:40:00Z']) {
  const selection=firstPickup(Date.parse(instant));
  const iso=newYorkPickup(selection.date,selection.time);
  assert.equal(newYorkDate(new Date(iso)),selection.date);
  assert.ok(validatePickupSlot(iso,new Date(instant)));
 }
 assert.equal(newYorkPickup('2026-03-08','11:00'),'2026-03-08T15:00:00.000Z');
 assert.equal(newYorkPickup('2026-11-01','11:00'),'2026-11-01T16:00:00.000Z');
 assert.equal(newYorkPickup('2026-02-30','11:00'),null);
});
