// GO dispatch: platform 168-hour gate (sequence 32 functions) + Smartlead. Fake RPC and
// fake fetch only: no database, no Smartlead account, no email, no secret.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setGoRpcForTests, type GoFunction } from '../src/lib/supabase-client.js';
import { OutreachSequencer, OUTREACH_STEPS, buildStepMessage, type DueLead } from '../src/modules/outreach/email-sequencer.js';
import { verifyWebhookToken, handleSmartleadEvent } from '../src/modules/webhooks/smartlead-webhook.js';
import { ApolloB2BMiner } from '../src/modules/apollo/b2b-miner.js';
import { HttpError } from '../src/lib/http-error.js';
import { parseCampaigns } from '../scripts/smartlead-setup.js';

const B = 'a358eba4-b197-4309-805b-46f43a718454';
const settings = { business_id: B, outreach_sender_name: 'Nazar', outreach_sender_email: 'go@synthetic.test',
  outreach_reply_to: 'reply@synthetic.test', outreach_physical_address: '1 Synthetic St, West Haven, CT', outreach_link_base_url: 'https://go.synthetic.test',
  outreach_timezone: 'America/New_York', outreach_send_days: [1, 2, 3, 4, 5], outreach_send_start: '09:00:00',
  outreach_send_end: '16:00:00', outreach_daily_send_limit: 10, enrichment_daily_credit_limit: 5, enrichment_monthly_credit_limit: 50 };
const lead = (step = 1, extra: Partial<DueLead> = {}): DueLead => ({ id: '11111111-1111-4111-8111-111111111111', step,
  email: 'ada@lead.synthetic.test', contact_name: 'Ada Lovelace', company_name: 'Synthetic & Co', ...extra });
type Call = { name: GoFunction; args: Record<string, unknown> };
function fakeDb(answers: Partial<Record<GoFunction, (args: Record<string, unknown>) => unknown>>) {
  const calls: Call[] = [];
  setGoRpcForTests(async (name, args) => {
    calls.push({ name, args });
    const answer = answers[name];
    if (!answer) throw new Error('unexpected rpc ' + name);
    return answer(args);
  });
  return calls;
}
type Seen = { url: URL; body: any };
function fakeSmartlead(...responses: (Response | (() => Response))[]) {
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    seen.push({ url: new URL(String(input)), body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = responses.shift();
    if (!next) throw new Error('unexpected Smartlead call');
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;
  return seen;
}
const originalFetch = globalThis.fetch;
const base = { go_outreach_settings_get_v1: () => settings };
process.env.GO_UNSUBSCRIBE_SECRET = 'synthetic-unsubscribe-secret-0123456789';
afterEach(() => {
  setGoRpcForTests(null); globalThis.fetch = originalFetch;
  process.env.SMARTLEAD_API_KEY = 'synthetic-smartlead-key';
});
process.env.SMARTLEAD_API_KEY = 'synthetic-smartlead-key';
const reserved = { allowed: true, code: 'reserved', message_id: 'M1', lease_id: 'L1', campaign_id: 9101 };
// Kabul edilen adaydan sonra kampanya durumu okunur; ACTIVE ise başka çağrı yok.
const active = () => Response.json({ id: 9101, status: 'ACTIVE' });

test('sequence is day 1, 8 and 15; content is built in GO with address and unsubscribe link, HTML-escaped', () => {
  assert.deepEqual(OUTREACH_STEPS.map((s) => s.day), [1, 8, 15]);
  const m = buildStepMessage(settings, B, lead());
  assert.equal(m.subject, 'Lunch for the Synthetic & Co team');
  assert.match(m.text, /^Hi Ada,/);
  assert.match(m.text, /1 Synthetic St, West Haven, CT\nUnsubscribe: https:\/\/go\.synthetic\.test\/u\//);
  assert.ok(m.html.includes('<br>') && !m.html.includes('\n'));
  // Step 3 names the company in the body: HTML-escaped there, plain in the text.
  const third = buildStepMessage(settings, B, lead(3));
  assert.ok(third.html.includes('Synthetic &amp; Co&#39;s first catering order') && third.text.includes("Synthetic & Co's"));
  assert.match(m.payloadSha256, /^[0-9a-f]{64}$/);
  assert.equal(buildStepMessage(settings, B, lead()).payloadSha256, m.payloadSha256);
  assert.notEqual(buildStepMessage(settings, B, lead(2)).payloadSha256, m.payloadSha256);
  assert.throws(() => buildStepMessage(settings, B, lead(4)), /Geçersiz adım/);
});

test('allowed lead: gate first, then Smartlead step campaign, then result recorded as accepted', async () => {
  const calls = fakeDb({ ...base, go_dispatch_reserve_v1: () => reserved, go_dispatch_result_v1: () => ({ status: 'sending' }) });
  const seen = fakeSmartlead(Response.json({ success: true, added_count: 1, lead_ids: [777] }), active());
  const result = await new OutreachSequencer().dispatch(B, settings, lead());
  assert.deepEqual(result, { b2b_lead_id: lead().id, queued: true, step: 1, reason: 'queued' });
  assert.deepEqual(calls.map((c) => c.name), ['go_dispatch_reserve_v1', 'go_dispatch_result_v1']);
  assert.deepEqual(Object.keys(calls[0].args), ['p_business_id', 'p_lead_id', 'p_step', 'p_payload_sha256']);
  assert.equal(seen[0].url.pathname, '/api/v1/campaigns/9101/leads');
  assert.equal(seen[0].url.searchParams.get('api_key'), 'synthetic-smartlead-key');
  const sent = seen[0].body;
  assert.deepEqual(sent.settings, { ignore_global_block_list: false, ignore_unsubscribe_list: false,
    ignore_community_bounce_list: false, ignore_duplicate_leads_in_other_campaign: true, return_lead_ids: true });
  assert.deepEqual([sent.lead_list.length, sent.lead_list[0].email, sent.lead_list[0].first_name, sent.lead_list[0].last_name],
    [1, 'ada@lead.synthetic.test', 'Ada', 'Lovelace']);
  assert.deepEqual(Object.keys(sent.lead_list[0].custom_fields), ['go_subject', 'go_body', 'go_message_id']);
  assert.deepEqual(calls[1].args, { p_business_id: B, p_message_id: 'M1', p_lease_id: 'L1', p_outcome: 'accepted', p_smartlead_lead_id: 777 });
});

test('a gate refusal never reaches Smartlead', async () => {
  for (const code of ['status_on_hold', 'suppressed', 'frequency_limited', 'daily_limit_reached', 'settings_disabled', 'campaign_not_configured']) {
    fakeDb({ ...base, go_dispatch_reserve_v1: () => ({ allowed: false, code }) });
    fakeSmartlead();
    assert.deepEqual(await new OutreachSequencer().dispatch(B, settings, lead()), { b2b_lead_id: lead().id, queued: false, step: 1, reason: code });
  }
});

test('Smartlead outcomes map to accepted / rejected / unknown; configuration errors stop the run', async () => {
  const cases: [Response, string, boolean][] = [
    [Response.json({ ok: true, upload_count: 1 }), 'accepted', false],
    [Response.json({ success: true, added_count: 0, skipped_count: 1 }), 'rejected', false],
    [Response.json({ success: true }), 'unknown', false],
    [new Response('boom', { status: 500 }), 'unknown', false],
    [new Response('no', { status: 401 }), 'rejected', true],
    [new Response('no', { status: 404 }), 'rejected', true]
  ];
  for (const [response, outcome, stop] of cases) {
    const calls = fakeDb({ ...base, go_dispatch_reserve_v1: () => reserved, go_dispatch_result_v1: () => ({}) });
    fakeSmartlead(response, active());
    const result = await new OutreachSequencer().dispatch(B, settings, lead());
    assert.equal(calls[1].args.p_outcome, outcome);
    assert.equal(Boolean(result.stopRun), stop, outcome);
  }
});

test('429 is retried after a pause', async () => {
  fakeDb({ ...base, go_dispatch_reserve_v1: () => reserved, go_dispatch_result_v1: () => ({}) });
  const seen = fakeSmartlead(new Response('', { status: 429 }), Response.json({ added_count: 1 }), active());
  assert.equal((await new OutreachSequencer().dispatch(B, settings, lead())).queued, true);
  assert.deepEqual(seen.map((s) => s.url.pathname), ['/api/v1/campaigns/9101/leads', '/api/v1/campaigns/9101/leads', '/api/v1/campaigns/9101']);
});

// Taslak kampanyanın ilk adayla başlatılması
function captureWarnings() {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  return { warnings, restore: () => { console.warn = original; } };
}
const accepted = () => Response.json({ added_count: 1, lead_ids: [777] });
const dispatchOne = () => {
  fakeDb({ ...base, go_dispatch_reserve_v1: () => reserved, go_dispatch_result_v1: () => ({}) });
  return new OutreachSequencer().dispatch(B, settings, lead());
};

test('DRAFTED step campaign is started after the first accepted lead and the recorded result', async () => {
  const calls = fakeDb({ ...base, go_dispatch_reserve_v1: () => reserved, go_dispatch_result_v1: () => ({}) });
  let resultRecordedBeforeGet = false;
  const seen = fakeSmartlead(accepted(), () => {
    resultRecordedBeforeGet = calls.some((c) => c.name === 'go_dispatch_result_v1');
    return Response.json({ id: 9101, status: 'DRAFTED' });
  }, Response.json({ ok: true }));
  const result = await new OutreachSequencer().dispatch(B, settings, lead());
  assert.deepEqual(result, { b2b_lead_id: lead().id, queued: true, step: 1, reason: 'queued' });
  assert.ok(resultRecordedBeforeGet);
  assert.deepEqual(seen.map((s) => s.url.pathname), ['/api/v1/campaigns/9101/leads', '/api/v1/campaigns/9101', '/api/v1/campaigns/9101/status']);
  assert.equal(seen[1].body, null);
  assert.deepEqual(seen[2].body, { status: 'START' });
});

test('ACTIVE campaign is not started again', async () => {
  const seen = fakeSmartlead(accepted(), active());
  assert.equal((await dispatchOne()).queued, true);
  assert.equal(seen.length, 2);
});

test('PAUSED and STOPPED campaigns are never started; a warning names campaign and status only', async () => {
  for (const status of ['PAUSED', 'STOPPED', 'COMPLETED']) {
    const seen = fakeSmartlead(accepted(), Response.json({ status }));
    const log = captureWarnings();
    try {
      assert.deepEqual(await dispatchOne(), { b2b_lead_id: lead().id, queued: true, step: 1, reason: 'queued' });
    } finally { log.restore(); }
    assert.equal(seen.length, 2, status);
    assert.ok(log.warnings.some((w) => w.includes('9101') && w.includes(status)), status);
    assert.ok(!log.warnings.join('').includes('synthetic-smartlead-key'));
  }
});

test('GET or POST failure while starting never changes the queued result', async () => {
  for (const responses of [
    [new Response('boom', { status: 500 })],
    [Response.json({ status: 'DRAFTED' }), new Response('no', { status: 400 })],
    [() => { throw new Error('network'); }]
  ] as (Response | (() => Response))[][]) {
    const seen = fakeSmartlead(accepted(), ...responses);
    const log = captureWarnings();
    try {
      assert.deepEqual(await dispatchOne(), { b2b_lead_id: lead().id, queued: true, step: 1, reason: 'queued' });
    } finally { log.restore(); }
    assert.equal(seen.length, 1 + responses.length);
    assert.ok(log.warnings.some((w) => w.includes('9101')));
    assert.ok(!log.warnings.join('').includes('synthetic-smartlead-key'));
  }
});

test('a rejected or unknown lead never triggers the start check', async () => {
  for (const response of [Response.json({ added_count: 0 }), Response.json({ success: true })]) {
    const seen = fakeSmartlead(response);
    assert.equal((await dispatchOne()).queued, false);
    assert.equal(seen.length, 1);
  }
});

test('runDue: two leads for the same campaign read its status once', async () => {
  fakeDb({ ...base, go_dispatch_quota_v1: () => ({ remaining: 5 }),
    go_dispatch_due_v1: () => [lead(1), lead(1, { id: '22222222-2222-4222-8222-222222222222', email: 'bo@lead.synthetic.test' })],
    go_dispatch_reserve_v1: () => reserved, go_dispatch_result_v1: () => ({}) });
  const seen = fakeSmartlead(accepted(), Response.json({ status: 'DRAFTED' }), Response.json({ ok: true }), accepted());
  const run = await new OutreachSequencer().runDue(B, 20);
  assert.equal(run.queued_count, 2);
  assert.deepEqual(seen.map((s) => s.url.pathname), ['/api/v1/campaigns/9101/leads', '/api/v1/campaigns/9101',
    '/api/v1/campaigns/9101/status', '/api/v1/campaigns/9101/leads']);
});

test('runDue: daily limit first, at most the remaining quota, stops on configuration error', async () => {
  let calls = fakeDb({ ...base, go_dispatch_quota_v1: () => ({ daily_limit: 10, sent_today: 10, remaining: 0 }) });
  fakeSmartlead();
  assert.deepEqual((await new OutreachSequencer().runDue(B, 20)).reasons, { daily_limit_reached: 1 });
  assert.ok(!calls.some((c) => c.name === 'go_dispatch_due_v1'));
  calls = fakeDb({ ...base, go_dispatch_quota_v1: () => ({ remaining: 2 }),
    go_dispatch_due_v1: () => [lead(1), lead(2, { id: '22222222-2222-4222-8222-222222222222' })],
    go_dispatch_reserve_v1: () => reserved, go_dispatch_result_v1: () => ({}) });
  const seen = fakeSmartlead(new Response('', { status: 401 }));
  const run = await new OutreachSequencer().runDue(B, 20);
  assert.equal(calls.find((c) => c.name === 'go_dispatch_due_v1')!.args.p_limit, 2);
  assert.equal(run.selected, 1); assert.equal(seen.length, 1);
});

test('manual trigger only sends a lead that the database lists as due', async () => {
  const calls = fakeDb({ ...base, go_dispatch_due_v1: () => [] });
  fakeSmartlead();
  assert.deepEqual(await new OutreachSequencer().sendNextStep(B, lead().id),
    { b2b_lead_id: lead().id, queued: false, step: null, reason: 'not_due_or_ineligible' });
  assert.deepEqual(calls.find((c) => c.name === 'go_dispatch_due_v1')!.args, { p_business_id: B, p_limit: 1, p_lead_id: lead().id });
});

test('webhook token: constant-time match only for the configured secret', () => {
  const secret = 'x'.repeat(40);
  assert.equal(verifyWebhookToken(secret, secret), true);
  assert.equal(verifyWebhookToken('y'.repeat(40), secret), false);
  assert.equal(verifyWebhookToken(undefined, secret), false);
  assert.equal(verifyWebhookToken('short', 'short'), false);
});

test('Smartlead events go to the platform with the campaign business, candidate addresses and a body-hash key', async () => {
  const raw = JSON.stringify({ event_type: 'EMAIL_REPLY', campaign_id: 9101, from_email: 'Ada@Lead.Synthetic.test',
    to_email: 'go@synthetic.test', time_replied: '2026-11-02T15:00:00Z', reply_body: 'Interested' });
  const calls = fakeDb({ go_smartlead_business_v1: () => B, go_smartlead_event_v1: () => ({ outcome: 'sequence_stopped' }) });
  assert.deepEqual(await handleSmartleadEvent(raw), { status: 200, outcome: 'sequence_stopped' });
  assert.deepEqual(calls[0].args, { p_campaign_id: 9101 });
  const args = calls[1].args;
  assert.equal(args.p_business_id, B); assert.equal(args.p_event_type, 'EMAIL_REPLY');
  assert.deepEqual(args.p_emails, ['go@synthetic.test', 'ada@lead.synthetic.test']);
  assert.equal(args.p_event_key, crypto.createHash('sha256').update(raw).digest('hex'));
  assert.equal(args.p_occurred_at, '2026-11-02T15:00:00.000Z');
  assert.ok(!JSON.stringify(args).includes('Interested'));
});

test('ignored types, unknown campaigns and bad bodies never write', async () => {
  const calls = fakeDb({ go_smartlead_business_v1: () => null });
  assert.equal((await handleSmartleadEvent(JSON.stringify({ event_type: 'EMAIL_OPEN', campaign_id: 1 }))).outcome, 'ignored_type:EMAIL_OPEN');
  assert.deepEqual(await handleSmartleadEvent('{nope'), { status: 400, outcome: 'invalid_body' });
  assert.deepEqual(await handleSmartleadEvent(JSON.stringify({ event_type: 'EMAIL_SENT', campaign_id: 'x' })), { status: 400, outcome: 'invalid_campaign' });
  assert.deepEqual(await handleSmartleadEvent(JSON.stringify({ event_type: 'EMAIL_BOUNCE', campaign_id: 5, to_email: 'a@b.test' })), { status: 200, outcome: 'unknown_campaign' });
  assert.deepEqual(calls.map((c) => c.name), ['go_smartlead_business_v1']);
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') ? [path] : [];
  });
}

test('Resend cold-email parts and Apollo demo mode are gone; Apify mock is untouched', async () => {
  assert.equal(existsSync('src/lib/mailer.ts'), false);
  assert.equal(existsSync('src/modules/webhooks/resend-webhook.ts'), false);
  for (const file of [...files('src'), ...files('scripts')]) assert.doesNotMatch(readFileSync(file, 'utf8'), /resend|svix/i, file);
  const index = readFileSync('src/index.ts', 'utf8');
  assert.ok(index.includes("'/webhooks/smartlead/:token'") && !index.includes('/api/growth/email/test'));
  assert.doesNotMatch(readFileSync('src/modules/apollo/b2b-miner.ts', 'utf8'), /mock-person|is_mock: true/);
  assert.match(readFileSync('src/modules/apify/ad-scraper.ts', 'utf8'), /mock/i);
  delete process.env.APOLLO_API_KEY;
  await assert.rejects(new ApolloB2BMiner().searchCateringLeads({ business_id: B }), (e: unknown) => e instanceof HttpError && e.status === 503);
});

test('setup script accepts exactly three distinct positive campaign ids', () => {
  assert.deepEqual(parseCampaigns('11, 22,33'), [11, 22, 33]);
  for (const bad of ['1,2', '1,1,2', '1,2,x', '0,1,2', undefined]) assert.equal(parseCampaigns(bad as string), null, String(bad));
});
