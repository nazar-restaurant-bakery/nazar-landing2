// G21 measurement layer on an owned local PostgreSQL 18.6 cluster: full reviewed baseline,
// Clover ledger, site order foundation + reversal, G8 market schema, then this migration.
// Payments are marked verified the way the webhook leaves them; refunds go through the real
// core.site_order_clover_reversal_apply_v1.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fixture, repo } from "./fixtures/customerTestClassificationNative.mjs";

const MIGRATION = "supabase/migrations/20261101000100_measurement_layer.sql";
const ROLLBACK = "supabase/rollbacks/20261101000100_measurement_layer_down.sql";
const OLD = "public.site_order_create_v1(uuid,uuid,text,text,text,text,text,text,timestamptz,jsonb,text,bigint,bigint,text)";
const NEW = OLD.replace("text)", "text,jsonb)");
const MERCHANT = "MERCHANT0001";
const lf = async (path) => (await readFile(join(repo, path))).toString("utf8").replaceAll("\r\n", "\n");
const h = await fixture({ currentCouponSchema: true });
test.after(() => h.stop());
const B = h.business, L = h.literal;
await h.apply();
for (const path of ["20261022000100_site_order_foundation.sql", "20261022000300_site_order_staff_workflow.sql",
  "20261030000100_site_order_clover_reversal.sql", "20261029000100_go_outreach_tables.sql", "20261031000100_market_data_area.sql"])
  h.sql(await lf("supabase/migrations/" + path));
// The fixture business is a marker fixture; this suite needs a non-test business.
h.sql(`UPDATE core.businesses SET is_test=false WHERE id='${B}'`);

const lines = JSON.stringify([{ id: "jajik", size: 10, quantity: 1, lineTotalCents: 1000 }]);
function order({ email, name = "Catering Customer", utm, cents = 10000 }) {
  const args = [`p_business_id=>'${B}'`, `p_request_id=>'${randomUUID()}'`, `p_request_hash=>'${"a".repeat(64)}'`, "p_kind=>'catering'",
    "p_fulfillment=>'pickup'", `p_customer_name=>${L(name)}`, `p_customer_email=>${L(email)}`, "p_customer_phone=>NULL",
    "p_requested_at=>now()+interval '5 days'", `p_lines=>${L(lines)}::jsonb`, "p_note=>''", `p_subtotal_cents=>${cents}`, "p_tax_cents=>0",
    "p_department=>'catering'", ...(utm === undefined ? [] : [`p_utm=>${utm === null ? "NULL" : L(JSON.stringify(utm)) + "::jsonb"}`])];
  return h.sql(`SELECT to_jsonb(public.site_order_create_v1(${args.join(",")}))`, { service: true });
}
let paymentSeq = 0;
function pay(orderId, verifiedAt = "now()") {
  const session = "session-" + orderId.slice(0, 8), payment = "PAY" + String(++paymentSeq).padStart(9, "0");
  h.sql(`SELECT public.site_order_session_set_v1('${B}','${orderId}','sandbox','${MERCHANT}','${session}')`, { service: true });
  h.sql(`UPDATE core.site_order_payments SET status='verified',clover_payment_id='${payment}',verified_cents=expected_cents,verified_at=${verifiedAt}
    WHERE site_order_id='${orderId}'; UPDATE core.site_orders SET status='paid' WHERE id='${orderId}'`);
  return payment;
}
const refund = (payment, ref, amount, total) => h.sql(`SELECT to_jsonb(core.site_order_clover_reversal_apply_v1('${B}','${MERCHANT}','clover_refund','${ref}','${payment}',${amount},${total},'{}'::jsonb))`);
const customer = (email, name = "Catering Customer") => h.sql(`INSERT INTO core.customers(business_id,identity_key,name,email)
  VALUES('${B}','email:${email}',${L(name)},'${email}') RETURNING to_jsonb(id)`);
const report = (from = "current_date-30", to = "current_date") => h.sql(`SELECT public.measurement_report_v1('${B}',${from},${to})`, { service: true });

test("migration: utm column + p_utm on the order RPC, private view/functions, re-apply refused", async () => {
  const r = h.raw(await lf(MIGRATION)); assert.equal(r.status, 0, r.stderr);
  assert.equal(h.sql(`SELECT to_regprocedure('${OLD}') IS NULL`), true);
  assert.deepEqual(h.sql(`SELECT json_build_array(prosecdef,proconfig,pronargdefaults) FROM pg_proc WHERE oid='${NEW}'::regprocedure`), [true, ['search_path=""'], 1]);
  for (const role of ["anon", "authenticated"]) {
    assert.equal(h.sql(`SELECT has_function_privilege('${role}','${NEW}','EXECUTE')`), false);
    assert.equal(h.sql(`SELECT has_function_privilege('${role}','public.measurement_report_v1(uuid,date,date)','EXECUTE')`), false);
  }
  assert.equal(h.sql(`SELECT has_function_privilege('service_role','${NEW}','EXECUTE')`), true);
  assert.equal(h.sql(`SELECT has_function_privilege('service_role','public.measurement_report_v1(uuid,date,date)','EXECUTE')`), true);
  assert.equal(h.sql(`SELECT has_function_privilege('service_role','public.crm_customer_attribution_v1(uuid)','EXECUTE')`), false);
  assert.equal(h.sql(`SELECT has_function_privilege('authenticated','public.crm_customer_attribution_v1(uuid)','EXECUTE')`), true);
  for (const role of ["anon", "authenticated", "service_role"]) {
    assert.equal(h.sql(`SELECT has_schema_privilege('${role}','core','USAGE')`), false);
    assert.equal(h.sql(`SELECT has_table_privilege('${role}','core.measurement_catering_orders_v1','SELECT')`), false);
    assert.equal(h.sql(`SELECT has_function_privilege('${role}','core.measurement_attribution_refresh_v1(uuid,uuid)','EXECUTE')`), false);
  }
  assert.match(h.raw(await lf(MIGRATION)).stderr, /G21_ALREADY_APPLIED/);
  const bytes = await readFile(join(repo, MIGRATION));
  assert.equal(bytes.includes(13), false);
  console.log(JSON.stringify({ migration: MIGRATION, sha256: createHash("sha256").update(bytes).digest("hex"),
    rollbackSha256: createHash("sha256").update(await readFile(join(repo, ROLLBACK))).digest("hex") }));
});

test("order with UTM stores the source; without UTM it is created exactly as before; bad UTM is refused", () => {
  const utm = { utm_source: "google", utm_medium: "cpc", utm_campaign: "123456789", gclid: "Cj0KCQ-synthetic", landing_page: "/catering" };
  const withUtm = order({ email: "utm-check@nazar-customer.com", utm });
  assert.deepEqual(h.sql(`SELECT utm FROM core.site_orders WHERE id='${withUtm}'`), utm);
  const without = order({ email: "utm-check@nazar-customer.com" }), explicitNull = order({ email: "utm-check@nazar-customer.com", utm: null });
  assert.equal(h.sql(`SELECT count(*) FROM core.site_orders WHERE id IN ('${without}','${explicitNull}') AND utm IS NULL`), 2);
  assert.equal(h.sql(`SELECT count(*) FROM core.site_order_tickets WHERE site_order_id='${without}'`), 1);
  for (const bad of [{ referrer: "https://x.test/?email=a@b.c" }, { utm_source: "x".repeat(201) }, { utm_source: 5 },
    { utm_source: "a\u0001b" }, { landing_page: "https://evil.test/" }, ["utm_source"]])
    assert.throws(() => order({ email: "utm-check@nazar-customer.com", utm: bad }), /Invalid site order|site_orders_utm_valid/, JSON.stringify(bad));
  h.sql("DELETE FROM core.site_order_events; DELETE FROM core.site_order_tickets; DELETE FROM core.site_orders");
});

const ids = {};
test("view and report: only verified payments count, refunds removed, tests excluded, unknown source not a campaign", () => {
  ids.a = customer("ayse@nazar-customer.com"); ids.b = customer("bora@nazar-customer.com"); ids.c = customer("cem@nazar-customer.com");
  ids.d = customer("deniz@nazar-customer.com"); ids.e = customer("ece@nazar-customer.com");
  const google = { utm_source: "google", utm_medium: "cpc", utm_campaign: "123456789" };
  const o1 = order({ email: "ayse@nazar-customer.com", utm: google, cents: 10000 }); pay(o1, "now()-interval '3 days'");
  const o2 = order({ email: "bora@nazar-customer.com", utm: { gclid: "Cj0KCQ-only" }, cents: 5000 }); pay(o2);
  const o3 = order({ email: "AYSE@nazar-customer.com ", utm: { utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "spring" }, cents: 8000 });
  const p3 = pay(o3, "now()-interval '1 day'"); assert.equal(refund(p3, "REFUNDPART01", 3000, 3000), "partial_refund");
  const o4 = order({ email: "cem@nazar-customer.com", cents: 7000 }); pay(o4);                         // unknown source
  const o5 = order({ email: "deniz@nazar-customer.com", utm: google, cents: 6000 });
  const p5 = pay(o5); assert.equal(refund(p5, "REFUNDFULL01", 6000, 6000), "reversed");               // full refund
  order({ email: "ece@nazar-customer.com", utm: google, cents: 9000 });                                // never paid
  const o7 = order({ email: "tester@example.com", name: "Tester", utm: google, cents: 4000 }); pay(o7); // test record
  const o8 = order({ email: "pending@nazar-customer.com", utm: google, cents: 2000 });
  h.sql(`SELECT public.site_order_session_set_v1('${B}','${o8}','sandbox','${MERCHANT}','session-pending')`, { service: true });
  Object.assign(ids, { o1, o2, o3, o4, o5, o7 });

  const rows = h.sql(`SELECT json_object_agg(site_order_id, json_build_array(customer_id,is_test,revenue_state,revenue_cents,refunded_cents,source_class))
    FROM core.measurement_catering_orders_v1`);
  assert.deepEqual(rows[o1], [ids.a, false, "verified", 10000, 0, "google_ads"]);
  assert.deepEqual(rows[o2], [ids.b, false, "verified", 5000, 0, "google_ads"]);
  assert.deepEqual(rows[o3], [ids.a, false, "verified", 5000, 3000, "other_campaign"]);
  assert.deepEqual(rows[o4], [ids.c, false, "verified", 7000, 0, "unknown"]);
  assert.deepEqual(rows[o5], [ids.d, false, "refunded", 0, 6000, "google_ads"]);
  assert.deepEqual(rows[o7].slice(1, 3), [true, "verified"]);
  assert.equal(rows[o8][2], "unverified");

  // Google Ads spend for the same campaign and period, from market.ad_reports.
  h.sql(`INSERT INTO market.ad_reports(business_id,platform,campaign_id,campaign_name,report_date,spend,source,observed_at) VALUES
    ('${B}','google_ads','123456789','Catering Search',current_date-2,40,'google_ads_api',now()),
    ('${B}','google_ads','123456789','Catering Search',current_date-1,25.5,'google_ads_api',now()),
    ('${B}','google_ads','123456789','Catering Search',current_date-90,999,'google_ads_api',now())`);
  const r = report();
  assert.equal(r.scope, "catering_site_orders"); assert.equal(r.currency, "USD");
  const key = (c) => [c.source_class, c.utm_source, c.utm_campaign].join("|");
  const campaigns = Object.fromEntries(r.campaigns.map((c) => [key(c), c]));
  assert.deepEqual(Object.keys(campaigns).sort(), ["google_ads|google|", "google_ads|google|123456789", "other_campaign|facebook|spring"]);
  const g = campaigns["google_ads|google|123456789"];
  assert.deepEqual([g.orders, g.customers, g.revenue_cents, g.refunded_orders, g.refunded_cents, g.ad_spend_usd], [1, 1, 10000, 1, 6000, 65.5]);
  const gclid = campaigns["google_ads|google|"];
  assert.deepEqual([gclid.orders, gclid.revenue_cents, gclid.ad_spend_usd], [1, 5000, null]);
  const fb = campaigns["other_campaign|facebook|spring"];
  assert.deepEqual([fb.orders, fb.customers, fb.revenue_cents, fb.refunded_cents, fb.ad_spend_usd], [1, 1, 5000, 3000, null]);
  assert.deepEqual(r.unattributed, { orders: 1, revenue_cents: 7000 });
  assert.equal(JSON.stringify(r).includes("tester@example.com"), false);
  // A Google campaign with no ad_reports rows in the period gets no invented spend.
  assert.equal(report("current_date", "current_date").campaigns.find((c) => c.utm_campaign === "123456789")?.ad_spend_usd ?? null, null);
  assert.throws(() => h.sql(`SELECT public.measurement_report_v1('${B}',current_date,current_date-1)`, { service: true }), /MEASUREMENT_PERIOD_INVALID/);
  assert.throws(() => h.sql(`SELECT public.measurement_report_v1('${B}',current_date-400,current_date)`, { service: true }), /MEASUREMENT_PERIOD_INVALID/);
  assert.throws(() => h.sql(`SELECT public.measurement_report_v1('${B}',current_date-1,current_date)`, { role: "authenticated" }), /permission denied/);
});

test("customer record: first and last attributed campaign; unknown, refunded, unpaid and test orders are not written", () => {
  report();
  const rows = h.sql(`SELECT json_object_agg(customer_id, json_build_array(first_source_class,first_utm_campaign,first_site_order_id,
    last_source_class,last_utm_source,last_utm_campaign,last_site_order_id,attributed_orders,attributed_revenue_cents)) FROM core.customer_campaign_attribution`);
  assert.deepEqual(Object.keys(rows).sort(), [ids.a, ids.b].sort());
  assert.deepEqual(rows[ids.a], ["google_ads", "123456789", ids.o1, "other_campaign", "facebook", "spring", ids.o3, 2, 15000]);
  assert.deepEqual(rows[ids.b].slice(0, 6), ["google_ads", null, ids.o2, "google_ads", "google", null]);
  // A later full refund removes the customer's only attributed order from the record.
  const payment = h.sql(`SELECT to_jsonb(clover_payment_id) FROM core.site_order_payments WHERE site_order_id='${ids.o2}'`);
  assert.equal(refund(payment, "REFUNDFULL02", 5000, 5000), "reversed");
  report();
  assert.equal(h.sql(`SELECT count(*) FROM core.customer_campaign_attribution WHERE customer_id='${ids.b}'`), 0);
});

test("staff CRM card: crm.read staff see the attribution; others are denied", () => {
  const staff = randomUUID(), outsider = randomUUID();
  h.sql(`INSERT INTO auth.users(id) VALUES('${staff}'),('${outsider}');
    INSERT INTO core.business_staff(business_id,staff_id,role,active) VALUES('${B}','${staff}','staff',true)`);
  const as = (uid, text) => h.sql(`SET request.jwt.claim.sub='${uid}'; SET request.jwt.claim.role='authenticated'; ${text}`, { role: "authenticated" });
  const card = as(staff, `SELECT public.crm_customer_attribution_v1('${ids.a}')`);
  assert.deepEqual([card.first.source_class, card.first.utm_campaign, card.last.utm_source, card.attributed_orders], ["google_ads", "123456789", "facebook", 2]);
  assert.equal(as(staff, `SELECT public.crm_customer_attribution_v1('${ids.c}')`), null);
  assert.throws(() => as(outsider, `SELECT public.crm_customer_attribution_v1('${ids.a}')`), /Access denied/);
  assert.throws(() => h.sql(`SELECT public.crm_customer_attribution_v1('${ids.a}')`, { role: "anon" }), /permission denied/);
});

test("rollback refuses while UTM data exists, then restores the original order RPC exactly", async () => {
  const before = h.sql(`SELECT count(*) FROM core.site_orders`);
  assert.match(h.raw(await lf(ROLLBACK)).stderr, /G21_ROLLBACK_DATA_PRESENT/);
  h.sql("UPDATE core.site_orders SET utm=NULL");
  const r = h.raw(await lf(ROLLBACK)); assert.equal(r.status, 0, r.stderr);
  assert.equal(h.sql(`SELECT to_regprocedure('${NEW}') IS NULL AND to_regprocedure('${OLD}') IS NOT NULL`), true);
  assert.equal(h.sql(`SELECT has_function_privilege('service_role','${OLD}','EXECUTE') AND NOT has_function_privilege('authenticated','${OLD}','EXECUTE')`), true);
  const original = (await lf("supabase/migrations/20261022000100_site_order_foundation.sql")).match(/CREATE FUNCTION public\.site_order_create_v1[\s\S]*?\nEND \$\$;/)[0];
  const body = original.slice(original.indexOf("AS $$") + 5, original.lastIndexOf("$$"));
  assert.equal(h.sql(`SELECT to_jsonb(prosrc) FROM pg_proc WHERE oid='${OLD}'::regprocedure`), body);
  assert.equal(h.sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='core' AND table_name='site_orders' AND column_name='utm'"), 0);
  assert.equal(h.sql("SELECT to_regclass('core.measurement_catering_orders_v1') IS NULL AND to_regclass('core.customer_campaign_attribution') IS NULL"), true);
  assert.equal(h.sql(`SELECT count(*) FROM core.site_orders`), before);
  assert.match(h.raw(await lf(ROLLBACK)).stderr, /G21_NOT_APPLIED/);
  const again = h.raw(await lf(MIGRATION)); assert.equal(again.status, 0, again.stderr);
});
