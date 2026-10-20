import { writeFile } from 'node:fs/promises';
import { createFixture, renderSeedSql } from './synthetic-fixture.mjs';

const [output] = process.argv.slice(2);
if (!output || process.argv.length !== 3) {
  throw new Error('Usage: node tools/test-env/generate-seed.mjs <synthetic-seed.sql>');
}
const fixture = createFixture({ id: process.env.TEST_BUSINESS_ID, name: 'Nazar-test' });
await writeFile(output, renderSeedSql(fixture), { flag: 'wx' });
console.log(JSON.stringify({ generated: true, loaded: false, is_test: true,
  tenants: fixture.businesses.length, customers: fixture.customers.length,
  signups: fixture.signups.length, catering_requests: fixture.catering_requests.length,
  offers: fixture.offers.length,
  note: 'SQL refuses missing is_test columns or an unverified target; it does not create schema.' }));
