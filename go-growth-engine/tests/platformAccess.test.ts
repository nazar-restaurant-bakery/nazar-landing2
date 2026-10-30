// GO → platform: every database touch goes through public.go_*_v1 functions.
// The database is replaced by a fake RPC; no network, no secret, no email.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { goRpc, GoDatabaseError, setGoRpcForTests, type GoFunction } from '../src/lib/supabase-client.js';
import { authorizeApiKey, hashApiKey } from '../src/lib/api-key.js';
import { suppressEmail, isEmailSuppressed } from '../src/modules/outreach/unsubscribe.js';
import { LeadImporter } from '../src/modules/outreach/lead-importer.js';
import { ApolloEnricher } from '../src/modules/apollo/enricher.js';
import { ApolloB2BMiner } from '../src/modules/apollo/b2b-miner.js';
import { OutreachSequencer, getDailySendQuota } from '../src/modules/outreach/email-sequencer.js';
import { handleResendEvent } from '../src/modules/webhooks/resend-webhook.js';
import { runScheduledTick } from '../src/scheduler.js';
import { HttpError } from '../src/lib/http-error.js';
import { compareWithExpected, EXPECTED } from '../scripts/verify-platform.js';

const B = 'a358eba4-b197-4309-805b-46f43a718454';
type Call = { name: GoFunction; args: Record<string, unknown> };
function fakeDb(answers: Partial<Record<GoFunction, (args: Record<string, unknown>) => unknown>> = {}) {
  const calls: Call[] = [];
  setGoRpcForTests(async (name, args) => {
    calls.push({ name, args });
    const answer = answers[name];
    if (!answer) throw new Error('unexpected rpc ' + name);
    return answer(args);
  });
  return calls;
}
const settings = { business_id: B, outreach_sender_name: 'Nazar', outreach_sender_email: 'go@synthetic.test',
  outreach_reply_to: 'reply@synthetic.test', outreach_physical_address: '1 St', outreach_link_base_url: 'https://go.synthetic.test',
  outreach_timezone: 'America/New_York', outreach_send_days: [1, 2, 3, 4, 5], outreach_send_start: '09:00:00',
  outreach_send_end: '16:00:00', outreach_daily_send_limit: 10, enrichment_daily_credit_limit: 5, enrichment_monthly_credit_limit: 50 };
const originalFetch = globalThis.fetch;
afterEach(() => { setGoRpcForTests(null); globalThis.fetch = originalFetch; delete process.env.APOLLO_API_KEY; });

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

test('no source file reads or writes a table directly', () => {
  for (const file of [...files('src'), ...files('scripts')]) {
    const text = readFileSync(file, 'utf8');
    // Supabase table access looks like .from('b2b_leads'); Buffer.from(...) is not a table.
    assert.doesNotMatch(text, /(?<!Buffer)\.from\(\s*['"`][a-z_]+['"`]\s*\)|\.schema\(|coreDb/, file);
  }
  // The only database entry point is goRpc in supabase-client.ts.
  const rpcUsers = [...files('src'), ...files('scripts')].filter((f) => /\/rest\/v1\//.test(readFileSync(f, 'utf8')));
  assert.deepEqual(rpcUsers.map((f) => f.replaceAll('\\', '/')), ['src/lib/supabase-client.ts']);
  assert.match(readFileSync('src/lib/supabase-client.ts', 'utf8'), /\/rest\/v1\/rpc\/\$\{name\}/);
});

test('goRpc calls only /rest/v1/rpc/go_*; sb_secret_ keys go in apikey only, errors carry no key', async () => {
  const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    return seen.length === 1 ? Response.json({ leads_total: 85 }) : Response.json({ code: '42501', message: 'Access denied' }, { status: 403 });
  }) as typeof fetch;
  process.env.GO_SUPABASE_URL = 'https://' + 'a'.repeat(20) + '.supabase.co';
  process.env.GO_SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_synthetic_only';
  try {
    assert.deepEqual(await goRpc('go_platform_verify_v1', { p_business_id: B }), { leads_total: 85 });
    assert.equal(seen[0].url, process.env.GO_SUPABASE_URL + '/rest/v1/rpc/go_platform_verify_v1');
    assert.deepEqual(seen[0].headers, { apikey: 'sb_secret_synthetic_only', 'Content-Type': 'application/json' });
    await assert.rejects(goRpc('go_platform_verify_v1', { p_business_id: B }), (e: unknown) =>
      e instanceof GoDatabaseError && e.status === 403 && e.code === '42501' && !e.message.includes('sb_secret'));
    process.env.GO_SUPABASE_SERVICE_ROLE_KEY = 'eyJsynthetic.legacy.jwt';
    seen.length = 0;
    await goRpc('go_platform_verify_v1', { p_business_id: B });
    assert.equal((seen[0].headers as Record<string, string>).Authorization, 'Bearer eyJsynthetic.legacy.jwt');
    process.env.GO_SUPABASE_URL = 'https://evil.example';
    await assert.rejects(goRpc('go_platform_verify_v1', {}), /Veritabanı bağlantısı yok/);
  } finally {
    delete process.env.GO_SUPABASE_URL; delete process.env.GO_SUPABASE_SERVICE_ROLE_KEY;
  }
});

test('API key check sends only the hash and keeps the business null when missing', async () => {
  const calls = fakeDb({ go_api_key_authorize_v1: () => 'forbidden' });
  assert.equal(await authorizeApiKey('go_secret_value', null), 'forbidden');
  assert.deepEqual(calls[0].args, { p_key_hash: hashApiKey('go_secret_value'), p_business_id: null });
  assert.ok(!JSON.stringify(calls).includes('go_secret_value'));
});

test('suppression only adds through the function; lookup is business scoped', async () => {
  const calls = fakeDb({ go_suppress_email_v1: () => true, go_suppressed_emails_v1: () => ['x@synthetic.test'] });
  await suppressEmail(B, 'x@synthetic.test');
  assert.deepEqual(calls[0], { name: 'go_suppress_email_v1', args: { p_business_id: B, p_email: 'x@synthetic.test',
    p_reason: 'unsubscribe_link', p_source: 'email', p_lead_status: 'unsubscribed' } });
  assert.equal(await isEmailSuppressed(B, 'x@synthetic.test'), true);
  assert.deepEqual(calls[1].args, { p_business_id: B, p_emails: ['x@synthetic.test'] });
});

test('bulk import: new rows without business_id, existing rows fill blanks only, no email sent', async () => {
  const calls = fakeDb({
    go_leads_by_email_v1: () => [{ id: 'L1', email: 'old@synthetic.test', contact_name: '', title: 'CEO', company_name: 'Old Co' }],
    go_leads_insert_v1: (a) => (a.p_rows as unknown[]).map((_, i) => 'N' + i),
    go_lead_fill_v1: () => true
  });
  const result = await new LeadImporter().importLeads(B, [
    { email: 'Old@Synthetic.test', company_name: 'Other', contact_name: 'Ada', title: 'CTO' },
    { email: 'new@synthetic.test', company_name: 'New Co' },
    { email: 'bad', company_name: 'X' }]);
  assert.deepEqual([result.inserted, result.updated, result.skipped], [1, 1, 1]);
  const insert = calls.find((c) => c.name === 'go_leads_insert_v1')!;
  assert.deepEqual(insert.args.p_rows, [{ email: 'new@synthetic.test', company_name: 'New Co', contact_name: null, title: null,
    status: 'enrichment_pending', source: 'import' }]);
  assert.deepEqual(calls.find((c) => c.name === 'go_lead_fill_v1')!.args, { p_business_id: B, p_lead_id: 'L1', p_patch: { contact_name: 'Ada' } });
  assert.ok(calls.every((c) => c.args.p_business_id === B));
});

test('enrichment uses credit sums, logs before updating, and marks duplicates atomically', async () => {
  process.env.APOLLO_API_KEY = 'synthetic-apollo-key';
  const calls = fakeDb({
    go_outreach_settings_get_v1: () => settings,
    go_enrichment_credits_used_v1: () => ({ used_today: 1, used_month: 3 }),
    go_leads_enrichment_pending_v1: () => [{ id: 'A', email: null, apollo_person_id: 'P1', metadata: {} },
      { id: 'B', email: null, apollo_person_id: 'P2', metadata: { k: 1 } }],
    go_enrichment_log_v1: () => null,
    go_lead_enrichment_found_v1: (a) => (a.p_lead_id === 'A' ? { status: 'new' } : { status: 'enrichment_failed', duplicate_of: 'A' })
  });
  globalThis.fetch = (async () => Response.json({ person: { id: 'P', email: 'Same@Synthetic.test', email_status: 'verified' } })) as typeof fetch;
  const result = await new ApolloEnricher().enrichLeads(B);
  assert.equal(result.credits_before.remaining, 4);
  assert.deepEqual(calls.find((c) => c.name === 'go_leads_enrichment_pending_v1')!.args, { p_business_id: B, p_limit: 4, p_lead_ids: null });
  assert.deepEqual(result.details.map((d) => [d.b2b_lead_id, d.status, d.reason]), [['A', 'new', undefined], ['B', 'enrichment_failed', 'duplicate']]);
  const names = calls.map((c) => c.name);
  assert.ok(names.indexOf('go_enrichment_log_v1') < names.indexOf('go_lead_enrichment_found_v1'));
  assert.equal(calls.find((c) => c.name === 'go_lead_enrichment_found_v1')!.args.p_email, 'same@synthetic.test');
});

test('Apollo miner inserts new people for the request business only', async () => {
  process.env.APOLLO_API_KEY = 'synthetic-apollo-key';
  const calls = fakeDb({ go_leads_insert_v1: () => ['X'] });
  globalThis.fetch = (async () => Response.json({ people: [{ id: 'P9', name: 'Ada L', title: 'Office Manager',
    organization: { name: 'Synthetic Co' } }] })) as typeof fetch;
  const result = await new ApolloB2BMiner().searchCateringLeads({ business_id: B });
  assert.equal(result.saved_count, 1);
  const rows = calls[0].args.p_rows as Record<string, unknown>[];
  assert.equal(calls[0].args.p_business_id, B);
  assert.equal('business_id' in rows[0], false);
  assert.deepEqual([rows[0].apollo_person_id, rows[0].status, rows[0].email], ['P9', 'enrichment_pending', null]);
});

test('dispatch stays closed until Task 6/7: no reservation, no quota read, no email', async () => {
  const calls = fakeDb();
  globalThis.fetch = (async () => { throw new Error('no network expected'); }) as typeof fetch;
  const sequencer = new OutreachSequencer();
  assert.deepEqual(await sequencer.sendNextStep(B, '11111111-1111-4111-8111-111111111111'),
    { b2b_lead_id: '11111111-1111-4111-8111-111111111111', sent: false, step: null, reason: 'dispatch_not_migrated' });
  assert.deepEqual((await sequencer.runDue(B, 20)).reasons, { dispatch_not_migrated: 1 });
  await assert.rejects(getDailySendQuota(B, settings, new Date()), (e: unknown) => e instanceof HttpError && e.status === 503);
  assert.equal(calls.length, 0);
});

test('Resend bounce/complaint is not dropped: 503 so Resend retries; other events ignored', async () => {
  const calls = fakeDb();
  await assert.rejects(handleResendEvent({ type: 'email.bounced', data: { email_id: 'em_1', bounce: { type: 'Permanent' } } }),
    (e: unknown) => e instanceof HttpError && e.status === 503);
  await assert.rejects(handleResendEvent({ type: 'email.complained', data: { email_id: 'em_2' } }),
    (e: unknown) => e instanceof HttpError && e.status === 503);
  assert.equal(await handleResendEvent({ type: 'email.delivered' }), 'ignored_type:email.delivered');
  assert.equal(calls.length, 0);
});

test('scheduler stays off: no database call when GO_SCHEDULER_ENABLED is not "true"', async () => {
  const calls = fakeDb();
  process.env.GO_SCHEDULER_ENABLED = 'false';
  await runScheduledTick(Date.now());
  assert.equal(calls.length, 0);
});

test('verification compares exactly with the transferred counts', () => {
  const ok = { business_id: B, leads_total: 85, leads_by_status: { ...EXPECTED.leads_by_status }, suppressions: 8,
    outreach_settings_rows: 1, outreach_settings: settings };
  assert.deepEqual(compareWithExpected(ok), []);
  assert.deepEqual(compareWithExpected({ ...ok, leads_total: 84, leads_by_status: { ...ok.leads_by_status, new: 37 }, suppressions: 7 }),
    ['aday new: beklenen 38, bulunan 37', 'aday toplam: beklenen 85, bulunan 84', 'engel kaydı: beklenen 8, bulunan 7']);
  assert.deepEqual(compareWithExpected({ ...ok, leads_by_status: { ...ok.leads_by_status, bounced: 1 } }), ['aday bounced: beklenen 0, bulunan 1']);
});
