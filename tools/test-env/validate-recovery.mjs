import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { validateRecoveryPackage } from './recovery-validation.mjs';

const args = process.argv.slice(2);
const directory = args.shift();
const options = {};
let output;
while (args.length) {
  const flag = args.shift(), value = args.shift();
  if (!value || !['--output', '--readback'].includes(flag)) throw new Error('Invalid arguments');
  if (flag === '--output') output = resolve(value);
  else options.readbackText = await readFile(value, 'utf8');
}
if (!directory) throw new Error('Usage: node tools/test-env/validate-recovery.mjs <private-directory> [--readback <json>] [--output <new-report.json>]');
if (output && ['schema.sql', 'catering-orders.json', 'staff-anonymous.json', 'recovery-source-proof.json']
  .some(name => output === resolve(join(directory, name)))) throw new Error('Report cannot replace a recovery input');
const report = await validateRecoveryPackage(directory, options);
const serialized = JSON.stringify(report, null, 2) + '\n';
if (output) await writeFile(output, serialized, { flag: 'wx' });
console.log(serialized);
process.exitCode = report.packageIntegrityVerified ? 0 : 1;
