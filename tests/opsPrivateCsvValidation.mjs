// Optional LOCAL validation. Never includes real source rows or monetary values in
// stdout/errors. Do not commit a real report or real financial numbers as fixtures.
import fs from 'node:fs/promises';
import { csvRows, parseCents, parseCloverCsv, csvFingerprint } from '../supabase/functions/ops-collect/clover_csv.ts';
const [sourcePath, referencePath, periodStart, periodEnd] = process.argv.slice(2);
if (!sourcePath || !referencePath || !periodStart || !periodEnd) throw new Error('Usage: opsPrivateCsvValidation.mjs SOURCE_CSV REFERENCE_DAILY_CSV YYYY-MM-DD YYYY-MM-DD');
try {
  const source = await fs.readFile(sourcePath, 'utf8'); const reference = await fs.readFile(referencePath, 'utf8');
  const parsed = await parseCloverCsv(source, { periodStart, periodEnd, now: new Date(periodEnd + 'T16:00:00Z') });
  const rows = csvRows(reference); const headers = rows[0];
  const columns = [['grossCents', 'Gross_Sales_USD'], ['refundCents', 'Product_Refunds_USD'], ['netCents', 'Net_Sales_USD'], ['taxCents', 'Taxes_USD'], ['tipCents', 'Tips_USD'], ['collectedCents', 'Amount_Collected_USD']];
  const dateIndex = headers.indexOf('Date_New_York');
  if (dateIndex < 0 || columns.some(([, name]) => !headers.includes(name))) throw new Error('reference_schema');
  let checkedValues = 0;
  for (const row of rows.slice(1).filter(row => row.some(value => value.trim()))) {
    const actual = parsed.daily.find(day => day.date === row[dateIndex]); if (!actual) throw new Error('missing_reference_date');
    for (const [field, name] of columns) {
      const expected = parseCents(row[headers.indexOf(name)]);
      if (actual[field] !== expected) throw new Error('private_cell_mismatch');
      checkedValues++;
    }
  }
  if (checkedValues < 20) throw new Error('insufficient_private_sample');
  console.log(JSON.stringify({ passed: true, checkedValues, minimumRequired: 20, fullDailyFinancialCells: checkedValues, sourceSha256: await csvFingerprint(source), referenceSha256: await csvFingerprint(reference) }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, code: /^[a-z_]+$/.test(error.message) ? error.message : 'private_validation_failed' })); process.exitCode = 1;
}
