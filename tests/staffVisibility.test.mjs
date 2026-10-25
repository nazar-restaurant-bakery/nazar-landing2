import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const code = await readFile(new URL('../src/lib/staffVisibility.ts', import.meta.url), 'utf8');
const { visibleStaffTab } = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(code)).toString('base64'));

test('restaurant owner sees service tabs and no platform tabs, including direct URLs', () => {
  for (const tab of ['customers', 'catering', 'tasks', 'offers', 'orders', 'coupons', 'ops', 'password']) {
    assert.equal(visibleStaffTab(tab, false), true, tab);
  }
  for (const tab of ['profile-sync', 'system', 'team', 'unknown']) {
    assert.equal(visibleStaffTab(tab, false), false, tab);
  }
});

test('platform operator sees both restaurant and platform sections', () => {
  for (const tab of ['customers', 'catering', 'tasks', 'offers', 'orders', 'coupons', 'ops', 'password', 'profile-sync', 'system', 'team']) {
    assert.equal(visibleStaffTab(tab, true), true, tab);
  }
});
