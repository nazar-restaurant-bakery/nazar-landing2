import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { staffCopy as c } from '../src/lib/staffCopy.ts';

const staffSource = (await readFile(new URL('../src/lib/staffUi.ts', import.meta.url), 'utf8'))
  .replace('import { staffCopy as c } from "./staffCopy";', `const c = ${JSON.stringify(c)};`);
const staffModule = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(staffSource)).toString('base64')}`);
const daySource = (await readFile(new URL('../src/lib/cloverPullDay.ts', import.meta.url), 'utf8'))
  .replace('import { staffDateInput, staffInputIso } from "./staffUi.ts";',
    'const { staffDateInput, staffInputIso } = globalThis.__k7StaffDate;');
globalThis.__k7StaffDate = staffModule;
const { closedCloverDay } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(daySource)).toString('base64')}`);

test('completed New York day maps to a bounded trailing pull and exact local-midnight window', () => {
  assert.deepEqual(closedCloverDay('2026-10-15', new Date('2026-10-20T12:00:00Z')), {
    days: 6, start: '2026-10-15T04:00:00.000Z', end: '2026-10-16T04:00:00.000Z',
  });
});

test('today, future, invalid and older than 30 days are rejected', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  for (const day of ['2026-10-20', '2026-10-21', '2026-02-30', '2026-09-01']) {
    assert.equal(closedCloverDay(day, now), null);
  }
});
