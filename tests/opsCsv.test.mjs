import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { csvRows, parseCents, parseCloverCsv } from '../supabase/functions/ops-collect/clover_csv.ts';

const opts = { periodStart: '2026-09-01', periodEnd: '2026-09-30', now: new Date('2026-10-01T16:00:00Z'), fileName: 'synthetic.csv' };
const header = 'order_id,transaction_id,transaction_type,occurred_at,channel,net_sales_usd,taxes_usd,tips_usd,amount_collected_usd,export_period_start,export_period_end';
const row = (order, id, kind = 'payment', date = '2026-09-02T14:00:00Z', channel = 'pickup', amount = '1.00', start = '2026-09-01', end = '2026-09-30') => [order, id, kind, date, channel, amount, '0.00', '0.00', amount, start, end].join(',');
const csv = (...rows) => header + '\n' + rows.join('\n') + '\n';
const value = (parsed, key) => parsed.metrics.find(m => m.metric === key)?.value_num;

function salesReport({ blank = false } = {}) {
  const dates = Array.from({ length: 30 }, (_, i) => 'Sep ' + (i + 1));
  const gross = Array.from({ length: 30 }, (_, i) => 10000 + i * 100);
  const refunds = gross.map((_, i) => i === 5 ? 500 : 0);
  const net = gross.map((v, i) => v - refunds[i]); const tax = gross.map(() => 100); const tips = gross.map(() => 200);
  const collected = net.map((v, i) => v + tax[i] + tips[i]);
  const dollar = n => (n / 100).toFixed(2);
  const rows = [['Sales Report'], ['Tue, Sep 1, 2026, 12:00 AM - Wed, Sep 30, 2026, 11:59 PM'], ['Requested on: synthetic'], ['Filters: none'], [], ['Net sales', dollar(net.reduce((a, b) => a + b, 0)), 'from 30 orders'], ['Amount Collected', dollar(collected.reduce((a, b) => a + b, 0))], [], ['Sales'], ['', 'Total', ...dates]];
  for (const [label, values] of [['Gross sales', gross], ['Refunds', refunds], ['Net sales', net], ['Taxes', tax], ['Tips', tips], ['Amount collected', collected]]) rows.push([label, dollar(values.reduce((a, b) => a + b, 0)), ...values.map((n, i) => blank && label === 'Tips' && i === 3 ? '' : dollar(n))]);
  rows.push([], ['Tender types'], ['Tender', 'Total'], ['Cash', '1.00'], ['Amount Collected', '1.00']);
  const quote = value => /[",\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
  return { text: rows.map(r => r.map(quote).join(',')).join('\n'), gross, refunds, net, tax, tips, collected };
}

test('decimal money is exact cents; blank is unknown and invalid precision is rejected', () => {
  assert.equal(parseCents('0.10') + parseCents('0.20'), 30);
  assert.equal(parseCents('$1,234.56'), 123456); assert.equal(parseCents('($3.10)'), -310);
  assert.equal(parseCents(''), null); assert.equal(parseCents('  '), null);
  for (const amount of ['1e3', 'NaN', '1.001', '1,23.00', '=SUM(A1)', 'Infinity']) assert.throws(() => parseCents(amount));
});
test('strict CSV handles BOM, escaped quotes, CRLF and multiline fields', () => {
  assert.deepEqual(csvRows('\uFEFFa,b\r\n"line\nnext","say ""hi"""\r\n'), [['a', 'b'], ['line\nnext', 'say "hi"']]);
  assert.throws(() => csvRows('a,b\n"unterminated')); assert.throws(() => csvRows('a,b\n"x"bad,y'));
});
test('Sales Report matches all 180 synthetic cells and ignores duplicate summary/tender totals', async () => {
  const fixture = salesReport(); const result = await parseCloverCsv(fixture.text, opts);
  const expected = [fixture.gross, fixture.refunds, fixture.net, fixture.tax, fixture.tips, fixture.collected];
  const fields = ['grossCents', 'refundCents', 'netCents', 'taxCents', 'tipCents', 'collectedCents'];
  let checked = 0;
  result.daily.forEach((day, index) => fields.forEach((field, f) => { assert.equal(day[field], expected[f][index]); checked++; }));
  assert.equal(checked, 180); assert.equal(result.daily.length, 30); assert.equal(result.commissionReady, false); assert.equal(result.qualifiedSales, null);
  assert.equal(value(result, 'net_sales_mtd'), fixture.net.reduce((a, b) => a + b, 0) / 100);
  assert.equal(value(result, 'orders_mtd'), 30); assert.equal(value(result, 'orders_yesterday'), null);
  assert.equal(value(result, 'channel_pickup_net_sales_mtd'), null);
});
test('Sales Report never subtracts Refunds again from already net sales', async () => {
  const fixture = salesReport(); const result = await parseCloverCsv(fixture.text, opts);
  assert.equal(result.daily[5].netCents, fixture.gross[5] - fixture.refunds[5]);
  assert.notEqual(result.daily[5].netCents, fixture.gross[5] - 2 * fixture.refunds[5]);
});
test('Sales Report preserves blank cells and rejects date/year/total conflicts', async () => {
  const blank = await parseCloverCsv(salesReport({ blank: true }).text, opts);
  assert.equal(blank.daily[3].tipCents, null); assert.equal(blank.counts.unknownAmounts, 1);
  await assert.rejects(() => parseCloverCsv(salesReport().text, { ...opts, periodStart: '2027-09-01', periodEnd: '2027-09-30' }));
  await assert.rejects(() => parseCloverCsv(salesReport().text.replace(',Sep 2,', ',Sep 3,'), opts));
  await assert.rejects(() => parseCloverCsv(salesReport().text.replace('Gross sales,', 'Gross sales,1.00,'), opts));
});
test('split payments count one order; duplicate rows and summary rows are not added', async () => {
  const payment = row('O1', 'P1', 'payment', undefined, 'pickup', '0.10');
  const parsed = await parseCloverCsv(csv(payment, payment, row('O1', 'P2', 'payment', undefined, 'pickup', '0.20'), row('', '', 'summary', '', '', '999.00')), opts);
  assert.equal(parsed.qualifiedSales, 0.30); assert.equal(value(parsed, 'orders_mtd'), 1); assert.equal(parsed.counts.duplicates, 2);
  assert.equal(parsed.commissionReady, true);
});
test('refund belongs to its own NY date, including payment and refund boundaries', async () => {
  const parsed = await parseCloverCsv(csv(
    row('AUGUST_ORDER', 'R1', 'refund', '2026-09-02T01:00:00Z', 'pickup', '2.00'),
    row('O1', 'P1', 'payment', '2026-10-01T01:00:00Z', 'pickup', '10.00'),
    row('O2', 'P2', 'payment', '2026-09-01T01:00:00Z', 'pickup', '99.00'),
  ), opts);
  assert.equal(parsed.qualifiedSales, 8); assert.equal(parsed.daily.find(day => day.date === '2026-09-01').netCents, -200);
  assert.equal(parsed.daily.find(day => day.date === '2026-09-30').netCents, 1000); assert.equal(value(parsed, 'orders_mtd'), 1);
});
test('Uber and Grubhub are excluded; unknown channel blocks commission instead of guessing', async () => {
  const parsed = await parseCloverCsv(csv(row('O1', 'P1'), row('O2', 'P2', 'payment', undefined, 'Uber Eats', '50.00'), row('O3', 'P3', 'payment', undefined, 'Delivery Grubhub', '30.00')), opts);
  assert.equal(parsed.qualifiedSales, 1); assert.equal(parsed.counts.excluded, 2); assert.equal(value(parsed, 'orders_mtd'), 1);
  const unknown = await parseCloverCsv(csv(row('O1', 'P1'), row('O2', 'P2', 'payment', undefined, 'other', '3.00')), opts);
  assert.equal(unknown.commissionReady, false); assert.equal(unknown.qualifiedSales, null); assert.equal(unknown.counts.unknownChannel, 1);
});
test('unknown product net is not zero; invalid timestamp, row type and conflicting duplicate fail closed', async () => {
  const blank = await parseCloverCsv(csv(row('O1', 'P1', 'payment', undefined, 'pickup', '')), opts);
  assert.equal(value(blank, 'net_sales_mtd'), null); assert.equal(blank.qualifiedSales, null);
  for (const text of [csv(row('O1', 'P1', 'sale')), csv(row('O1', 'P1', 'payment', '2026-09-01T12:00')), csv(row('O1', 'P1'), row('O1', 'P1', 'payment', undefined, 'pickup', '8.00'))]) await assert.rejects(() => parseCloverCsv(text, opts));
});
test('ambiguous refund summary is rejected rather than double deducted', async () => {
  const text = csv(row('O1', 'P1')).replace(header, header + ',refund_amount_usd').replace(/\n$/, ',1.00\n');
  await assert.rejects(() => parseCloverCsv(text, opts), /ambiguous_refund_basis/);
});
test('same file fingerprint and values are stable; importer can upsert rather than add', async () => {
  const text = csv(row('O1', 'P1')); const a = await parseCloverCsv(text, opts); const b = await parseCloverCsv(text, opts);
  assert.equal(a.fingerprint, b.fingerprint); assert.match(a.fingerprint, /^[a-f0-9]{64}$/); assert.deepEqual(a.metrics, b.metrics);
  assert.equal(a.sourceFile, 'synthetic.csv'); assert.equal(a.metrics.every(m => m.collector === 'manual_csv'), true);
});
test('full calendar month can finalize; current MTD is estimate only; arbitrary partial never finalizes', async () => {
  const full = await parseCloverCsv(csv(row('O1', 'P1', 'payment', '2026-06-02T14:00:00Z', 'pickup', '3.00', '2026-06-01', '2026-06-30')), { ...opts, periodStart: '2026-06-01', periodEnd: '2026-06-30' });
  assert.equal(full.commissionReady, true); assert.equal(full.commissionEstimateReady, false); assert.equal(full.qualifiedSales, 3);
  const currentOptions = { ...opts, periodStart: '2026-10-01', periodEnd: '2026-10-18', now: new Date('2026-10-19T14:00:00Z') };
  const current = await parseCloverCsv(csv(row('O1', 'P1', 'payment', '2026-10-10T14:00:00Z', 'pickup', '4.00', '2026-10-01', '2026-10-18')), currentOptions);
  assert.equal(current.commissionReady, false); assert.equal(current.commissionEstimateReady, true); assert.equal(current.qualifiedSales, 4);
  assert.equal(current.metrics.find(m => m.metric === 'net_sales_mtd').value_text, 'estimate');
  const partial = await parseCloverCsv(csv(row('O1', 'P1', 'payment', '2026-10-10T14:00:00Z', 'pickup', '4.00', '2026-10-05', '2026-10-18')), { ...currentOptions, periodStart: '2026-10-05' });
  assert.equal(partial.commissionReady, false); assert.equal(partial.commissionEstimateReady, false); assert.equal(partial.qualifiedSales, null);
});
test('UI-selected dates alone do not prove export coverage; normalized period declarations must match', async () => {
  const undeclared = csv(row('O1', 'P1')).split('\n').map(line => line.split(',').slice(0, -2).join(',')).join('\n');
  const parsed = await parseCloverCsv(undeclared, opts); assert.equal(parsed.coverageValidated, false); assert.equal(parsed.qualifiedSales, null);
  await assert.rejects(() => parseCloverCsv(csv(row('O1', 'P1', 'payment', undefined, 'pickup', '1.00', '2026-09-02', '2026-09-30')), opts), /csv_period_mismatch/);
  await assert.rejects(() => parseCloverCsv(csv(row('O1', 'P1', 'payment', '2026-09-31T12:00:00Z')), opts), /invalid_transaction_date/);
});
test('a current/future month declared through month-end is not a finalized commission period', async () => {
  const parsed = await parseCloverCsv(csv(row('O1', 'P1', 'payment', '2026-10-10T14:00:00Z', 'pickup', '4.00', '2026-10-01', '2026-10-31')), { ...opts, periodStart: '2026-10-01', periodEnd: '2026-10-31', now: new Date('2026-10-19T14:00:00Z') });
  assert.equal(parsed.commissionReady, false); assert.equal(parsed.commissionEstimateReady, false); assert.equal(parsed.qualifiedSales, null);
});
test('committed normalized sample is synthetic, qualified and reproducible', async () => {
  const text = await fs.readFile(new URL('./fixtures/ops_clover_normalized_synthetic.csv', import.meta.url), 'utf8');
  const parsed = await parseCloverCsv(text, opts); assert.equal(parsed.commissionReady, true); assert.equal(parsed.qualifiedSales, 63); assert.equal(value(parsed, 'orders_mtd'), 3); assert.equal(parsed.counts.excluded, 2);
});
