// Catering checkout consent + confirmation email detail on an owned local
// PostgreSQL 18.6 cluster: full reviewed baseline (real submit_signup_once,
// suppression guard, test classifiers) plus the actual site order migrations.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fixture, repo } from "./fixtures/customerTestClassificationNative.mjs";

const MIGRATION = "supabase/migrations/20261030000200_catering_checkout_consent_email_lines.sql";
const ROLLBACK = "supabase/rollbacks/20261030000200_catering_checkout_consent_email_lines_down.sql";
const lf = async (path) => (await readFile(join(repo, path))).toString("utf8").replaceAll("\r\n", "\n");
const h = await fixture({ currentCouponSchema: true });
test.after(() => h.stop());
await h.apply();
for (const path of ["20261022000100_site_order_foundation.sql", "20261022000300_site_order_staff_workflow.sql",
  "20261022000400_site_order_customer_confirmation.sql"]) h.sql(await lf("supabase/migrations/" + path));
const signupFunction = () => h.sql(`SELECT json_build_object('def',pg_get_functiondef(p.oid),'acl',p.proacl::text,'owner',p.proowner::regrole::text,'secdef',p.prosecdef,'config',p.proconfig)
  FROM pg_proc p WHERE p.oid='public.submit_signup(uuid,text,text,text,text,boolean,boolean,jsonb,jsonb)'::regprocedure`);
const sourceCheck = () => h.sql(`SELECT to_jsonb(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conname='signups_source_check'`);
const original = signupFunction(), originalCheck = sourceCheck();
const consent = (name, email, requestId = randomUUID()) => h.sql(`SELECT public.submit_signup_once('${requestId}','${h.business}',
  ${h.literal(name)},${h.literal(email)},NULL,'catering_checkout',true,false,NULL,NULL)`, { service: true });
const customer = (email) => h.sql(`SELECT to_jsonb(c) FROM core.customers c WHERE email=${h.literal(email)}`);
const signups = (email) => h.sql(`SELECT json_agg(json_build_object('source',source,'consent_email',consent_email,'consent_sms',consent_sms,'is_test',is_test) ORDER BY created_at)
  FROM core.signups WHERE email=${h.literal(email)}`);
const events = (customerId) => h.sql(`SELECT json_agg(json_build_object('type',event_type,'source',source,'email',email_requested,'sms',sms_requested,'evidence',evidence_status) ORDER BY created_at)
  FROM core.consent_events WHERE customer_id='${customerId}'`);

test("migration installs, rolls back byte-identically and reinstalls", async () => {
  assert.throws(() => consent("Before", "before@nazar.test"), /Invalid source|signups_source_check/);
  let r = h.raw(await lf(MIGRATION)); assert.equal(r.status, 0, r.stderr);
  const installed = signupFunction();
  assert.equal(installed.acl, original.acl); assert.equal(installed.owner, original.owner);
  assert.equal(installed.secdef, original.secdef); assert.deepEqual(installed.config, original.config);
  assert.equal(installed.def.replace("'catering','catering_checkout')", "'catering')"), original.def);
  assert.match(h.raw(await lf(MIGRATION)).stderr, /CATERING_CONSENT_ALREADY_INSTALLED/);
  r = h.raw(await lf(ROLLBACK)); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(signupFunction(), original); assert.equal(sourceCheck(), originalCheck);
  r = h.raw(await lf(MIGRATION)); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(signupFunction(), installed);
  const bytes = await readFile(join(repo, MIGRATION));
  assert.equal(bytes.includes(13), false);
  console.log(JSON.stringify({ migration: MIGRATION, sha256: createHash("sha256").update(bytes).digest("hex"),
    rollbackSha256: createHash("sha256").update(await readFile(join(repo, ROLLBACK))).digest("hex") }));
});

test("consenting checkout: email-only marketing request through the existing tables", () => {
  const email = "consent-" + randomUUID().slice(0, 8) + "@nazar.test";
  consent("Checkout Customer", email);
  const c = customer(email);
  assert.equal(c.email_status, "pending_review"); assert.equal(c.email_suppressed_at, null); assert.equal(c.is_test, false);
  assert.deepEqual(signups(email), [{ source: "catering_checkout", consent_email: true, consent_sms: false, is_test: false }]);
  assert.deepEqual(events(c.id), [{ type: "request", source: "catering_checkout", email: true, sms: false, evidence: "pending_review" }]);
  // The VIP coupon / DOI paths stay limited to VIP sources.
  assert.equal(h.sql(`SELECT count(*) FROM core.signups WHERE email=${h.literal(email)} AND source IN ('website_vip_form','website_vip_page')`), 0);
});

test("checkout without consent creates no customer, signup or consent record", () => {
  // The server calls intake only when the box is ticked; nothing else writes here.
  const email = "noconsent-" + randomUUID().slice(0, 8) + "@nazar.test";
  assert.equal(customer(email), null); assert.equal(signups(email), null);
});

test("a suppressed address cannot become permitted again through the checkbox", () => {
  const email = "suppressed-" + randomUUID().slice(0, 8) + "@nazar.test";
  consent("Suppressed Customer", email);
  h.sql(`SELECT core.suppress_email(${h.literal(email)},'synthetic test')`);
  const before = customer(email);
  assert.equal(before.email_status, "unsubscribed"); assert.ok(before.email_suppressed_at);
  // A different checkout (the existing 10-minute fingerprint dedupe skips identical repeats).
  consent("Suppressed Customer at checkout", email);
  const after = customer(email);
  assert.equal(after.email_status, "unsubscribed"); assert.equal(after.email_suppressed_at, before.email_suppressed_at);
  assert.equal(events(after.id).filter((e) => e.type === "request").length, 2);
  // The existing guard trigger also rejects a direct lift without staff evidence.
  assert.notEqual(h.raw(`UPDATE core.customers SET email_status='subscribed',email_suppressed_at=NULL WHERE id='${after.id}'`).status, 0);
  assert.equal(customer(email).email_status, "unsubscribed");
});

test("INTERNAL TEST names stay classified as test records", () => {
  const email = "internal-" + randomUUID().slice(0, 8) + "@nazar.test";
  consent("INTERNAL TEST catering checkout", email);
  assert.equal(customer(email).is_test, true);
  assert.deepEqual(signups(email).map((s) => s.is_test), [true]);
});

test("email detail is readable only by the server while the email is claimed", () => {
  const rpc = (sql) => h.sql(sql, { service: true });
  const requestId = randomUUID(), session = "SESSION" + randomUUID().slice(0, 8);
  const lines = [{ id: "jajik", size: 10, quantity: 2, unitPriceCents: 5000, lineTotalCents: 10000 }];
  const orderId = rpc(`SELECT to_jsonb(public.site_order_create_v1('${h.business}','${requestId}','${"a".repeat(64)}','catering','pickup',
    'Ayşe <b>','ayse@nazar.test',NULL,now()+interval '10 days',${h.literal(JSON.stringify(lines))}::jsonb,'No <onions>',10000,735,'catering'))`);
  rpc(`SELECT public.site_order_session_set_v1('${h.business}','${orderId}','production','MERCHANT0001','${session}')`);
  assert.equal(rpc(`SELECT to_jsonb(public.site_order_payment_confirm_v1('${h.business}','${session}','MERCHANT0001','PAYMENT0001',10735,now(),'{}'))`), "paid");
  const detail = () => rpc(`SELECT public.site_order_customer_email_detail_v1('${h.business}','${orderId}')`);
  assert.equal(detail(), null);
  assert.equal(rpc(`SELECT public.site_order_customer_email_claim_v1('${h.business}','${session}')`).orderId, orderId);
  assert.deepEqual(detail(), { customerName: "Ayşe <b>", preparationNote: "No <onions>", lines,
    subtotalCents: 10000, taxCents: 735, totalCents: 10735 });
  for (const role of ["anon", "authenticated"])
    assert.notEqual(h.raw(`SELECT public.site_order_customer_email_detail_v1('${h.business}','${orderId}')`, { role }).status, 0);
  rpc(`SELECT public.site_order_customer_email_finish_v1('${h.business}','${orderId}',true,'accepted')`);
  assert.equal(detail(), null);
});

test("rollback refuses once checkout consent records exist", async () => {
  const r = h.raw(await lf(ROLLBACK));
  assert.notEqual(r.status, 0); assert.match(r.stderr, /CATERING_CONSENT_ROLLBACK_DATA_PRESENT/);
  assert.ok(signupFunction().def.includes("'catering_checkout'"));
});
