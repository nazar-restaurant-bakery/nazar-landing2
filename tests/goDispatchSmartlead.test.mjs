// Sequence 32: GO dispatch through the single 168-hour gate + Smartlead events.
// Owned local PostgreSQL 18.6: full baseline + K6 + G4 + sequence 31 + 32. Synthetic data.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fixture, repo } from "./fixtures/customerTestClassificationNative.mjs";

const MIGRATION = "supabase/migrations/20261030000500_go_dispatch_smartlead.sql";
const ROLLBACK = "supabase/rollbacks/20261030000500_go_dispatch_smartlead_down.sql";
const lf = async (path) => (await readFile(join(repo, path))).toString("utf8").replaceAll("\r\n", "\n");
const sha = (v) => createHash("sha256").update(v).digest("hex");
const h = await fixture({ currentCouponSchema: true });
test.after(() => h.stop());
h.sql(await lf("supabase/migrations/20261029000100_go_outreach_tables.sql"));
h.sql(await lf("supabase/migrations/20261030000400_go_platform_access.sql"));
const B = h.business, L = h.literal;
const svc = (sql) => h.sql(sql, { service: true });
const CAMPAIGNS = [9101, 9102, 9103];
h.sql(`INSERT INTO core.outreach_settings(business_id,sender_name,sender_email,reply_to,physical_address,link_base_url,timezone,
    send_days,send_start,send_end,daily_send_limit,enrichment_daily_credit_limit,enrichment_monthly_credit_limit)
  VALUES('${B}','Synthetic','go@synthetic.test','reply@synthetic.test','1 St','https://go.synthetic.test','America/New_York','{1,2,3,4,5}','09:00','16:00',10,5,50);
  INSERT INTO core.message_send_settings(business_id,enabled,min_interval_hours) VALUES('${B}',true,168)
  ON CONFLICT (business_id) DO UPDATE SET enabled=true,min_interval_hours=168;`);
const lead = (status = "new", extra = {}) => {
  const id = randomUUID(), email = `${id.slice(0, 8)}@lead.synthetic.test`;
  h.sql(`INSERT INTO core.b2b_leads(id,business_id,company_name,email,status,sequence_step,next_step_at)
    VALUES('${id}','${B}','Co ${id.slice(0, 4)}','${email}','${status}',${extra.step ?? 0},${extra.next ? L(extra.next) : "NULL"})`);
  return { id, email };
};
const payload = sha("synthetic payload");
const reserve = (id, step = 1) => svc(`SELECT public.go_dispatch_reserve_v1('${B}','${id}',${step},'${payload}')`);
const result = (r, outcome, sl = "NULL") => svc(`SELECT public.go_dispatch_result_v1('${B}','${r.message_id}','${r.lease_id}','${outcome}',${sl})`);
const event = (campaign, type, emails, key = sha(randomUUID())) =>
  svc(`SELECT public.go_smartlead_event_v1('${B}',${campaign},'${type}',ARRAY[${emails.map(L).join(",")}]::text[],'${key}','msg-1',now())`);
const row = (id) => h.sql(`SELECT to_jsonb(l) FROM core.b2b_leads l WHERE id='${id}'`);
const msg = (id) => h.sql(`SELECT to_jsonb(m) FROM core.message_log m WHERE id='${id}'`);

test("installs with a rollback that restores sequence 31 state; sequence 31 bytes untouched", async () => {
  const s31 = await readFile(join(repo, "supabase/migrations/20261030000400_go_platform_access.sql"));
  assert.equal(sha(s31), "8b58ffbcf4f879e7e385caa51b27c94869e12ca1836e2a82291c3ebe6f6df604");
  const before = h.sql(`SELECT json_build_object('c',(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='b2b_leads_status_check'),
    'f',(SELECT json_agg(md5(pg_get_functiondef(oid)) ORDER BY oid) FROM pg_proc WHERE proname LIKE 'go\\_%'))`);
  let r = h.raw(await lf(MIGRATION)); assert.equal(r.status, 0, r.stderr);
  r = h.raw(await lf(ROLLBACK)); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.sql(`SELECT json_build_object('c',(SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='b2b_leads_status_check'),
    'f',(SELECT json_agg(md5(pg_get_functiondef(oid)) ORDER BY oid) FROM pg_proc WHERE proname LIKE 'go\\_%'))`), before);
  r = h.raw(await lf(MIGRATION)); assert.equal(r.status, 0, r.stderr);
  assert.match(h.raw(await lf(MIGRATION)).stderr, /GO_DISPATCH_ALREADY_INSTALLED_OR_UNEXPECTED/);
  assert.equal(h.sql(`SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'go\\_%\\_v1'
    AND p.prosecdef AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')`), 25);
  const bytes = await readFile(join(repo, MIGRATION));
  assert.equal(bytes.includes(13), false);
  console.log(JSON.stringify({ migration: MIGRATION, sha256: sha(bytes), rollbackSha256: sha(await readFile(join(repo, ROLLBACK))) }));
});

test("no campaign configured or gate disabled means no dispatch", () => {
  const a = lead();
  assert.equal(reserve(a.id).code, "campaign_not_configured");
  assert.equal(svc(`SELECT public.go_smartlead_campaigns_set_v1('${B}',ARRAY[${CAMPAIGNS}]::bigint[])`), true);
  assert.equal(svc(`SELECT to_jsonb(public.go_smartlead_business_v1(9102))`), B);
  h.sql(`UPDATE core.message_send_settings SET enabled=false WHERE business_id='${B}'`);
  assert.equal(reserve(a.id).code, "settings_disabled");
  h.sql(`UPDATE core.message_send_settings SET enabled=true WHERE business_id='${B}'`);
  assert.equal(h.sql("SELECT count(*) FROM core.message_log WHERE b2b_lead_id IS NOT NULL"), 0);
});

test("on_hold, suppressed and leads without address are never selected or reserved", () => {
  const hold = lead("on_hold"), blocked = lead(), noMail = randomUUID();
  h.sql(`INSERT INTO core.email_suppressions(business_id,email,reason,source) VALUES('${B}','${blocked.email}','unsubscribe_link','email');
    INSERT INTO core.b2b_leads(id,business_id,company_name,status) VALUES('${noMail}','${B}','No mail','new')`);
  const due = svc(`SELECT public.go_dispatch_due_v1('${B}',100)`).map((d) => d.id);
  for (const id of [hold.id, blocked.id, noMail]) assert.ok(!due.includes(id), id);
  assert.equal(reserve(hold.id).code, "status_on_hold");
  assert.equal(reserve(noMail).code, "missing_email");
  assert.equal(reserve(blocked.id).code, "suppressed");
  assert.equal(row(blocked.id).status, "unsubscribed");
});

test("step 1: gate record 'sending' -> Smartlead accepted -> EMAIL_SENT finalizes 'sent', next step after 7 days", () => {
  const a = lead();
  const r = reserve(a.id);
  assert.equal(r.allowed, true); assert.equal(r.campaign_id, 9101); assert.equal(r.email, a.email);
  const m = msg(r.message_id);
  assert.deepEqual([m.status, m.customer_id, m.b2b_lead_id, m.message_kind], ["sending", null, a.id, "campaign"]);
  assert.equal(m.recipient_sha256, sha(a.email));
  assert.equal(reserve(a.id).code, "frequency_limited");
  assert.ok(!svc(`SELECT public.go_dispatch_due_v1('${B}',100)`).some((d) => d.id === a.id));
  assert.equal(result(r, "accepted", 555).status, "sending");
  const key = sha("sent-" + a.id);
  assert.equal(event(9101, "EMAIL_SENT", ["go@synthetic.test", a.email], key).outcome, "sent_step_1");
  assert.equal(event(9101, "EMAIL_SENT", [a.email], key).outcome, "duplicate");
  assert.equal(msg(r.message_id).status, "sent");
  const after = row(a.id);
  assert.deepEqual([after.status, after.sequence_step], ["contacted", 1]);
  assert.equal(h.sql(`SELECT next_step_at BETWEEN now()+interval '6 days 23 hours' AND now()+interval '7 days 1 hour' FROM core.b2b_leads WHERE id='${a.id}'`), true);
  assert.equal(reserve(a.id, 2).code, "not_due");
  // Even when the step is marked due early, the 168-hour gate refuses.
  h.sql(`UPDATE core.b2b_leads SET next_step_at=now()-interval '1 minute' WHERE id='${a.id}'`);
  assert.equal(reserve(a.id, 2).code, "frequency_limited");
});

test("step 2 is allowed once 168 hours have passed, and goes to the step-2 campaign", () => {
  const a = lead("contacted", { step: 1, next: new Date(Date.now() - 60000).toISOString() });
  h.sql(`INSERT INTO core.message_log(business_id,b2b_lead_id,message_key,message_kind,payload_sha256,recipient_sha256,identity_sha256,
      status,lease_id,reserved_at,reservation_expires_at,claimed_at,dispatch_expires_at,dispatch_authorized_at,sent_at,finished_at)
    VALUES('${B}','${a.id}','go.b2b:${a.id}:s1:a1','campaign','${payload}','${sha(a.email)}','${sha("b2b:" + a.id)}','sent',gen_random_uuid(),
      now()-interval '8 days',now()-interval '8 days'+interval '5 minutes',now()-interval '8 days',now()-interval '8 days'+interval '10 minutes',
      now()-interval '8 days',now()-interval '8 days',now()-interval '8 days')`);
  const r = reserve(a.id, 2);
  assert.equal(r.allowed, true); assert.equal(r.campaign_id, 9102);
  assert.equal(result(r, "accepted").status, "sending");
  assert.equal(event(9102, "EMAIL_SENT", [a.email]).outcome, "sent_step_2");
  assert.equal(row(a.id).sequence_step, 2);
});

test("a recent customer email to the same address blocks the lead too (single gate)", () => {
  const a = lead();
  const customer = randomUUID();
  h.sql(`INSERT INTO core.customers(id,business_id,identity_key,name,email,email_status,is_test) VALUES('${customer}','${B}','email:${a.email}','Same person','${a.email}','subscribed',true);
    INSERT INTO core.message_log(business_id,customer_id,message_key,message_kind,payload_sha256,recipient_sha256,identity_sha256,
      status,lease_id,reserved_at,reservation_expires_at,claimed_at,dispatch_expires_at,dispatch_authorized_at,sent_at,finished_at)
    VALUES('${B}','${customer}','klaviyo:${customer}','flow','${payload}','${sha(a.email)}','${sha("email:" + a.email)}','sent',gen_random_uuid(),
      now()-interval '1 day',now()-interval '1 day'+interval '5 minutes',now()-interval '1 day',now()-interval '1 day'+interval '10 minutes',
      now()-interval '1 day',now()-interval '1 day',now()-interval '1 day')`);
  assert.equal(reserve(a.id).code, "frequency_limited");
});

test("rejected by Smartlead: no email left, lead may be selected again; unknown blocks the lead", () => {
  const a = lead(), b = lead();
  assert.equal(result(reserve(a.id), "rejected").status, "blocked");
  assert.deepEqual(svc(`SELECT public.go_dispatch_due_v1('${B}',10,'${a.id}')`).map((d) => [d.id, d.step, d.email]), [[a.id, 1, a.email]]);
  assert.equal(result(reserve(b.id), "unknown").status, "unknown");
  assert.equal(reserve(b.id).code, "frequency_limited");
});

test("reply stops the sequence; bounce and unsubscribe add to the suppression list; nothing removed", () => {
  const replied = lead(), bounced = lead(), unsub = lead();
  for (const x of [replied, bounced, unsub]) { const r = reserve(x.id); result(r, "accepted"); event(9101, "EMAIL_SENT", [x.email]); }
  assert.equal(event(9101, "EMAIL_REPLY", [replied.email]).outcome, "sequence_stopped");
  assert.equal(row(replied.id).status, "replied"); assert.equal(row(replied.id).next_step_at, null);
  assert.ok(!svc(`SELECT public.go_dispatch_due_v1('${B}',100)`).some((d) => d.id === replied.id));
  assert.equal(reserve(replied.id, 2).code, "status_replied");
  assert.equal(event(9101, "EMAIL_BOUNCE", [bounced.email]).outcome, "suppressed_bounce");
  assert.equal(event(9101, "LEAD_UNSUBSCRIBED", [unsub.email]).outcome, "suppressed_unsubscribe");
  assert.deepEqual([row(bounced.id).status, row(unsub.id).status], ["bounced", "unsubscribed"]);
  assert.equal(h.sql(`SELECT count(*) FROM core.email_suppressions WHERE source='smartlead_webhook' AND email IN ('${bounced.email}','${unsub.email}')`), 2);
  assert.notEqual(h.raw(`DELETE FROM core.email_suppressions WHERE email='${bounced.email}'`).status, 0);
});

test("unmatched and unknown-campaign events are recorded, not dropped", () => {
  assert.equal(event(9101, "EMAIL_REPLY", ["stranger@synthetic.test"]).outcome, "unmatched");
  assert.equal(event(1, "EMAIL_REPLY", ["stranger@synthetic.test"]).outcome, "unknown_campaign");
  assert.equal(h.sql("SELECT count(*) FROM core.b2b_outreach_events WHERE outcome IN ('unmatched','unknown_campaign')"), 2);
});

test("daily limit counts the local day's gate records", () => {
  h.sql(`UPDATE core.outreach_settings SET daily_send_limit=1 WHERE business_id='${B}'`);
  const quota = svc(`SELECT public.go_dispatch_quota_v1('${B}')`);
  assert.equal(quota.remaining, 0);
  assert.equal(reserve(lead().id).code, "daily_limit_reached");
  h.sql(`UPDATE core.outreach_settings SET daily_send_limit=10 WHERE business_id='${B}'`);
});

test("only service_role may call; rollback refuses once dispatch data exists", async () => {
  for (const role of ["anon", "authenticated"])
    assert.notEqual(h.raw(`SELECT public.go_dispatch_due_v1('${B}',1)`, { role }).status, 0, role);
  assert.notEqual(h.raw(`SELECT * FROM core.b2b_dispatches`, { service: true }).status, 0);
  assert.match(h.raw(await lf(ROLLBACK)).stderr, /GO_DISPATCH_ROLLBACK_DATA_PRESENT/);
});
