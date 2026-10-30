// GO platform access functions on an owned local PostgreSQL 18.6 cluster: full
// reviewed baseline + actual K6 + G4 migrations. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fixture, repo } from "./fixtures/customerTestClassificationNative.mjs";

const MIGRATION = "supabase/migrations/20261030000400_go_platform_access.sql";
const ROLLBACK = "supabase/rollbacks/20261030000400_go_platform_access_down.sql";
const lf = async (path) => (await readFile(join(repo, path))).toString("utf8").replaceAll("\r\n", "\n");
const h = await fixture({ currentCouponSchema: true });
test.after(() => h.stop());
h.sql(await lf("supabase/migrations/20261029000100_go_outreach_tables.sql"));
const B = h.business, OTHER = randomUUID();
const L = h.literal;
const svc = (sql) => h.sql(sql, { service: true });
const json = (value) => L(JSON.stringify(value)) + "::jsonb";
const hash = (key) => createHash("sha256").update(key).digest("hex");
// Production-shaped synthetic tenant: 38 new, 10 contacted, 36 on_hold, 1 unsubscribed; 8 suppressions; 1 settings row.
h.sql(`ALTER TABLE core.businesses DROP CONSTRAINT IF EXISTS businesses_id_check;
  INSERT INTO core.businesses(id,name,intake_enabled,is_test) VALUES('${OTHER}','Synthetic other tenant',false,true);
  INSERT INTO core.outreach_settings(business_id,sender_name,sender_email,reply_to,physical_address,link_base_url,timezone,
    send_days,send_start,send_end,daily_send_limit,enrichment_daily_credit_limit,enrichment_monthly_credit_limit)
  VALUES('${B}','Synthetic Sender','sender@synthetic.test','reply@synthetic.test','1 Synthetic St','https://go.synthetic.test',
    'America/New_York','{1,2,3,4,5}','09:00','16:00',10,5,50);
  INSERT INTO core.b2b_leads(business_id,company_name,email,status,source)
  SELECT '${B}','Synthetic Co '||g,'lead'||g||'@synthetic.test',
    CASE WHEN g<=38 THEN 'new' WHEN g<=48 THEN 'contacted' WHEN g<=84 THEN 'on_hold' ELSE 'unsubscribed' END,'apollo_csv'
  FROM generate_series(1,85) g;
  INSERT INTO core.email_suppressions(business_id,email,reason,source)
  SELECT '${B}','blocked'||g||'@synthetic.test','unsubscribe_link','email' FROM generate_series(1,8) g;
  INSERT INTO core.b2b_leads(business_id,company_name,email,status) VALUES('${OTHER}','Other tenant lead','lead1@synthetic.test','new');`);

test("migration installs 18 service-only SECURITY DEFINER functions with fixed search_path", async () => {
  const before = h.sql("SELECT json_agg(md5(pg_get_functiondef(oid)) ORDER BY oid) FROM pg_proc WHERE pronamespace='core'::regnamespace");
  const r = h.raw(await lf(MIGRATION)); assert.equal(r.status, 0, r.stderr);
  const fns = h.sql(`SELECT json_agg(json_build_object('name',p.proname,'secdef',p.prosecdef,'config',p.proconfig,
      'service',has_function_privilege('service_role',p.oid,'EXECUTE'),'anon',has_function_privilege('anon',p.oid,'EXECUTE'),
      'auth',has_function_privilege('authenticated',p.oid,'EXECUTE'),'public',has_function_privilege('public',p.oid,'EXECUTE')) ORDER BY p.proname)
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'go\\_%\\_v1'`);
  assert.equal(fns.length, 18);
  for (const f of fns) assert.deepEqual([f.secdef, f.config, f.service, f.anon, f.auth], [true, ['search_path=""'], true, false, false], f.name);
  // No GO function deletes or changes suppression rows; tables and older functions unchanged.
  assert.equal(h.sql(`SELECT count(*) FROM pg_proc WHERE proname LIKE 'go\\_%' AND prosrc ~* '(delete|update)[^;]*email_suppressions'`), 0);
  const coreBefore = before.length;
  assert.equal(h.sql("SELECT count(*) FROM pg_proc WHERE pronamespace='core'::regnamespace"), coreBefore + 2);
  assert.equal(h.sql("SELECT has_schema_privilege('service_role','core','USAGE')"), false);
  assert.match(h.raw(await lf(MIGRATION)).stderr, /GO_ACCESS_ALREADY_INSTALLED/);
  const bytes = await readFile(join(repo, MIGRATION));
  assert.equal(bytes.includes(13), false);
  console.log(JSON.stringify({ migration: MIGRATION, sha256: createHash("sha256").update(bytes).digest("hex"),
    rollbackSha256: createHash("sha256").update(await readFile(join(repo, ROLLBACK))).digest("hex") }));
});

test("read-only verification returns the expected production counts", () => {
  const v = svc(`SELECT public.go_platform_verify_v1('${B}')`);
  assert.equal(v.leads_total, 85);
  assert.deepEqual(v.leads_by_status, { new: 38, contacted: 10, on_hold: 36, unsubscribed: 1 });
  assert.equal(v.suppressions, 8); assert.equal(v.outreach_settings_rows, 1);
  assert.equal(v.outreach_settings.outreach_sender_name, "Synthetic Sender");
  assert.deepEqual(v.outreach_settings.outreach_send_days, [1, 2, 3, 4, 5]);
  assert.equal(v.outreach_settings.outreach_send_start, "09:00:00");
  const ro = h.raw(`BEGIN READ ONLY; SET LOCAL request.jwt.claim.role='service_role'; SET LOCAL ROLE service_role;
    SELECT public.go_platform_verify_v1('${B}'); COMMIT;`);
  assert.equal(ro.status, 0, ro.stderr);
});

test("anon and authenticated cannot call; core tables stay closed to service_role", () => {
  for (const role of ["anon", "authenticated"]) {
    assert.notEqual(h.raw(`SELECT public.go_platform_verify_v1('${B}')`, { role }).status, 0, role);
    assert.notEqual(h.raw(`SELECT public.go_suppress_email_v1('${B}','x@synthetic.test','unsubscribe_link','email','unsubscribed')`, { role }).status, 0, role);
  }
  for (const table of ["b2b_leads", "email_suppressions", "outreach_settings", "api_keys"])
    assert.notEqual(h.raw(`SELECT count(*) FROM core.${table}`, { service: true }).status, 0, table);
  // A direct call without the service_role claim is refused by the function itself.
  assert.notEqual(h.raw(`SET ROLE service_role; SELECT public.go_platform_verify_v1('${B}')`).status, 0);
});

test("every function is scoped to its business_id", () => {
  assert.throws(() => svc(`SELECT public.go_platform_verify_v1('${randomUUID()}')`), /GO_BUSINESS_NOT_FOUND/);
  assert.equal(svc(`SELECT public.go_leads_by_email_v1('${B}',ARRAY['lead1@synthetic.test'])`).length, 1);
  assert.equal(svc(`SELECT public.go_leads_by_email_v1('${OTHER}',ARRAY['lead2@synthetic.test'])`).length, 0);
  const otherLead = h.sql(`SELECT to_jsonb(id) FROM core.b2b_leads WHERE business_id='${OTHER}'`);
  assert.equal(svc(`SELECT public.go_lead_fill_v1('${B}','${otherLead}',${json({ title: "x" })})`), false);
  assert.equal(svc(`SELECT public.go_outreach_settings_get_v1('${OTHER}')`), null);
  assert.deepEqual(svc("SELECT public.go_outreach_business_ids_v1()"), [B]);
});

test("API key authorize keeps the 401 -> 400/404 -> 403 order; create is atomic, revoke by prefix", () => {
  const key = "go_synthetic_key_" + randomUUID();
  const id = svc(`SELECT to_jsonb(public.go_api_key_create_v1('synthetic',${L(key.slice(0, 8))},'${hash(key)}',ARRAY['${B}']::uuid[]))`);
  assert.match(id, /^[0-9a-f-]{36}$/);
  const auth = (k, b) => svc(`SELECT to_jsonb(public.go_api_key_authorize_v1('${hash(k)}',${b ? `'${b}'` : "NULL"}))`);
  assert.equal(auth("wrong", B), "invalid_key");
  assert.equal(auth(key, null), "business_missing");
  assert.equal(auth(key, randomUUID()), "business_not_found");
  assert.equal(auth(key, OTHER), "forbidden");
  assert.equal(auth(key, B), "ok");
  assert.throws(() => svc(`SELECT public.go_api_key_create_v1('bad','PREFIX01','${hash("y")}',ARRAY['${B}','${randomUUID()}']::uuid[])`), /GO_BUSINESS_NOT_FOUND/);
  assert.equal(h.sql(`SELECT count(*) FROM core.api_keys WHERE name='bad'`), 0);
  assert.equal(svc(`SELECT public.go_api_key_revoke_v1(${L(key.slice(0, 8))})`).status, "revoked");
  assert.equal(auth(key, B), "invalid_key");
});

test("suppression only adds; a second unsubscribe keeps the first reason and nothing can remove it", () => {
  assert.equal(svc(`SELECT public.go_suppress_email_v1('${B}','Lead2@Synthetic.test','unsubscribe_link','email','unsubscribed')`), true);
  assert.equal(svc(`SELECT public.go_suppress_email_v1('${B}','lead2@synthetic.test','hard_bounce','resend_webhook','bounced')`), false);
  assert.equal(h.sql(`SELECT to_jsonb(reason) FROM core.email_suppressions WHERE email='lead2@synthetic.test'`), "unsubscribe_link");
  assert.equal(h.sql(`SELECT to_jsonb(status) FROM core.b2b_leads WHERE business_id='${B}' AND email='lead2@synthetic.test'`), "bounced");
  assert.equal(h.sql(`SELECT to_jsonb(status) FROM core.b2b_leads WHERE business_id='${OTHER}'`), "new");
  assert.deepEqual(svc(`SELECT public.go_suppressed_emails_v1('${B}',ARRAY['lead2@synthetic.test','lead3@synthetic.test'])`), ["lead2@synthetic.test"]);
  assert.notEqual(h.raw(`DELETE FROM core.email_suppressions WHERE email='lead2@synthetic.test'`).status, 0);
});

test("lead insert/fill: new rows only, defaults kept, blank fields only, status untouched", () => {
  const ids = svc(`SELECT public.go_leads_insert_v1('${B}',${json([
    { email: "New@Synthetic.test", company_name: "New Co", status: "enrichment_pending", source: "import" },
    { email: "lead1@synthetic.test", company_name: "Dup", status: "new" },
    { apollo_person_id: "AP1", company_name: "Apollo Co", status: "enrichment_pending", city: null, state: "CT", metadata: { a: 1 } }])})`);
  assert.equal(ids.length, 2);
  const row = h.sql(`SELECT to_jsonb(l) FROM core.b2b_leads l WHERE email='new@synthetic.test'`);
  assert.deepEqual([row.city, row.state, row.source, row.business_id], ["West Haven", "CT", "import", B]);
  assert.equal(h.sql(`SELECT city IS NULL FROM core.b2b_leads WHERE apollo_person_id='AP1'`), true);
  assert.throws(() => svc(`SELECT public.go_leads_insert_v1('${B}',${json([{ email: "x@synthetic.test", company_name: "X", status: "contacted" }])})`), /GO_INVALID_LEAD/);
  assert.throws(() => svc(`SELECT public.go_leads_insert_v1('${B}',${json([{ email: "x@synthetic.test", company_name: "X", status: "new", business_id: OTHER }])})`), /GO_INVALID_LEAD/);
  const lead = h.sql(`SELECT to_jsonb(l) FROM core.b2b_leads l WHERE email='lead1@synthetic.test' AND business_id='${B}'`);
  h.sql(`UPDATE core.b2b_leads SET title=NULL,metadata='{"keep":1}' WHERE id='${lead.id}'`);
  assert.equal(svc(`SELECT public.go_lead_fill_v1('${B}','${lead.id}',${json({ title: "Manager", company_name: "Other", metadata: { keep: 2, add: 3 } })})`), true);
  const filled = h.sql(`SELECT to_jsonb(l) FROM core.b2b_leads l WHERE id='${lead.id}'`);
  assert.deepEqual([filled.title, filled.company_name, filled.metadata, filled.status], ["Manager", "Synthetic Co 1", { keep: 1, add: 3 }, "new"]);
  assert.throws(() => svc(`SELECT public.go_lead_fill_v1('${B}','${lead.id}',${json({ status: "converted" })})`), /GO_INVALID_PATCH/);
});

test("enrichment: pending batch, credit sums, found/duplicate/failed only while pending", () => {
  const pending = svc(`SELECT public.go_leads_enrichment_pending_v1('${B}',10)`);
  assert.equal(pending.length, 2);
  const apollo = pending.find((l) => l.apollo_person_id === "AP1");
  svc(`SELECT public.go_enrichment_log_v1('${B}','${apollo.id}','AP1',1,'found')`);
  const credits = svc(`SELECT public.go_enrichment_credits_used_v1('${B}',now()-interval '1 hour',now()-interval '1 day')`);
  assert.deepEqual(credits, { used_today: 1, used_month: 1 });
  assert.deepEqual(svc(`SELECT public.go_lead_enrichment_found_v1('${B}','${apollo.id}','lead3@synthetic.test','{}')`).status, "enrichment_failed");
  const other = pending.find((l) => l.apollo_person_id !== "AP1");
  assert.deepEqual(svc(`SELECT public.go_lead_enrichment_found_v1('${B}','${other.id}','verified@synthetic.test','{}')`), { status: "new" });
  assert.deepEqual(svc(`SELECT public.go_lead_enrichment_found_v1('${B}','${other.id}','again@synthetic.test','{}')`), { status: "unchanged" });
  assert.equal(svc(`SELECT public.go_lead_enrichment_fail_v1('${B}','${other.id}','{}')`), false);
  assert.throws(() => svc(`SELECT public.go_enrichment_log_v1('${OTHER}','${apollo.id}',NULL,0,'error')`), /GO_INVALID_ENRICHMENT_LOG/);
});

test("rollback removes only the functions and leaves data intact; reinstall works", async () => {
  const counts = () => h.sql(`SELECT json_build_object('l',(SELECT count(*) FROM core.b2b_leads),'s',(SELECT count(*) FROM core.email_suppressions),'o',(SELECT count(*) FROM core.outreach_settings))`);
  const before = counts();
  let r = h.raw(await lf(ROLLBACK)); assert.equal(r.status, 0, r.stderr);
  assert.equal(h.sql(`SELECT count(*) FROM pg_proc WHERE proname LIKE 'go\\_%\\_v1'`), 0);
  assert.deepEqual(counts(), before);
  r = h.raw(await lf(MIGRATION)); assert.equal(r.status, 0, r.stderr);
});
