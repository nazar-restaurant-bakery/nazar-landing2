import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = ['subscribed', 'not_subscribed', 'unsubscribed'];
const quote = value => value === null ? 'NULL' : typeof value === 'boolean'
  ? String(value) : typeof value === 'number' ? String(value)
  : `'${String(value).replaceAll("'", "''")}'`;

// Every identity is generated for this fixture, never copied from a live tenant.
export function createFixture(input) {
  if (!input || !UUID.test(input.id) || input.name !== 'Nazar-test')
    throw new Error('An environment-supplied business UUID and Nazar-test name are required');
  const tenantInputs = [input];
  const fixture = { version: 1, environment: 'isolated-test', is_test: true,
    businesses: [], customers: [], signups: [], catering_requests: [], offers: [] };
  for (const [tenantIndex, input] of tenantInputs.entries()) {
    fixture.businesses.push({ id: input.id, name: input.name,
      timezone: 'America/New_York', intake_enabled: true, is_test: true });
    for (const [index, status] of statuses.entries()) {
      const customerId = randomUUID(), signupId = randomUUID();
      const email = `${status.replaceAll('_', '-')}.${input.id}@example.invalid`;
      const name = `INTERNAL TEST tenant ${tenantIndex + 1} ${status}`;
      fixture.customers.push({ id: customerId, business_id: input.id,
        identity_key: `${input.id}:email:${email}`, name, email, phone: null,
        email_status: status,
        email_suppressed_at: status === 'unsubscribed' ? '2026-01-01T00:00:00Z' : null,
        is_test: true });
      fixture.signups.push({ id: signupId, business_id: input.id,
        customer_id: customerId, name, email, phone: null,
        source: 'catering', consent_email: false, consent_sms: false,
        utm: '{}', meta: JSON.stringify({ is_test: true, fixture: 'k3-v1' }),
        fingerprint: `k3:${input.id}:${status}`, processed: true, is_test: true });
      if (index === 0) fixture.catering_requests.push({ id: randomUUID(),
        signup_id: signupId, customer_id: customerId, event_date: '2030-01-15',
        guests: 12, message: 'INTERNAL TEST. No order, contact or message requested.',
        status: 'closed', assigned_to: 'Synthetic test operator', follow_up_at: null,
        is_test: true });
    }
    fixture.offers.push({ id: randomUUID(), business_id: input.id,
      name: `INTERNAL TEST offer tenant ${tenantIndex + 1}`,
      description: 'INTERNAL TEST inactive configurable campaign fixture',
      code: `TEST-${input.id}`, channel_target: 'clover',
      starts_at: '2030-01-01', ends_at: '2030-01-31', active: false, is_test: true });
  }
  validateFixture(fixture);
  return fixture;
}

export function validateFixture(fixture) {
  if (fixture.environment !== 'isolated-test' || fixture.is_test !== true)
    throw new Error('Only isolated-test fixtures are accepted');
  const tenants = new Set(fixture.businesses?.map(t => t.id));
  if (tenants.size !== 1 || fixture.businesses[0].name !== 'Nazar-test')
    throw new Error('One synthetic Nazar-test business is required');
  for (const table of ['businesses', 'customers', 'signups', 'catering_requests', 'offers']) {
    if (!Array.isArray(fixture[table]) || fixture[table].some(row => row.is_test !== true))
      throw new Error(`All ${table} rows must be explicitly is_test=true`);
  }
  const customers = new Map(fixture.customers.map(c => [c.id, c]));
  const signups = new Map(fixture.signups.map(s => [s.id, s]));
  for (const row of fixture.customers) {
    if (!tenants.has(row.business_id) || !row.email.endsWith('@example.invalid')
        || row.phone !== null || !row.name.startsWith('INTERNAL TEST'))
      throw new Error('Only reserved-domain synthetic customers are allowed');
  }
  for (const signup of fixture.signups) {
    const customer = customers.get(signup.customer_id);
    if (customer?.business_id !== signup.business_id)
      throw new Error('Invalid signup ownership');
    if (signup.name !== customer.name || signup.email !== customer.email
        || signup.phone !== customer.phone)
      throw new Error('Signup contact fields must match the synthetic customer');
  }
  for (const request of fixture.catering_requests) {
    const signup = signups.get(request.signup_id);
    if (!signup || signup.customer_id !== request.customer_id)
      throw new Error('Invalid catering ownership');
  }
  if (fixture.offers.some(o => !tenants.has(o.business_id) || o.active !== false))
    throw new Error('Synthetic offers must belong to a fixture tenant and stay inactive');
  for (const id of tenants) {
    if (statuses.some(status => !fixture.customers.some(c => c.business_id === id
      && c.email_status === status))) throw new Error('Missing consent-state fixture');
  }
}

export function renderSeedSql(fixture) {
  validateFixture(fixture);
  const tables = ['businesses', 'customers', 'signups', 'catering_requests', 'offers'];
  const preflight = `BEGIN;\nSET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\nDO $k3$\nDECLARE t text;\nBEGIN\n  IF current_setting('app.k3_test_environment',true) IS DISTINCT FROM 'isolated-test' THEN\n    RAISE EXCEPTION 'K3 seed requires an explicitly verified isolated test target';\n  END IF;\n  FOREACH t IN ARRAY ARRAY[${tables.map(quote).join(',')}] LOOP\n    IF NOT EXISTS(SELECT 1 FROM information_schema.columns\n      WHERE table_schema='core' AND table_name=t AND column_name='is_test'\n        AND data_type='boolean') THEN\n      RAISE EXCEPTION 'K3 schema prerequisite missing: core.%.is_test boolean. No flags will be silently omitted.',t;\n    END IF;\n  END LOOP;\nEND $k3$;\n`;
  const businessId = quote(fixture.businesses[0].id);
  const collisionGuard = `DO $k3_collision$ BEGIN\n  IF EXISTS(SELECT 1 FROM core.businesses WHERE id=${businessId}::uuid AND (NOT is_test OR name IS DISTINCT FROM 'Nazar-test')) THEN\n    RAISE EXCEPTION 'K3 seed refuses to retag or rename an existing non-fixture business';\n  END IF;\nEND $k3_collision$;\n`;
  return preflight + collisionGuard + tables.flatMap(table => fixture[table].map(row =>
    `INSERT INTO core.${table} (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map(quote).join(',')})`
      + (table === 'businesses'
        ? ' ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,timezone=EXCLUDED.timezone,intake_enabled=EXCLUDED.intake_enabled,is_test=true;' : ';')
  )).join('\n') + '\nCOMMIT;\n';
}
