// G8 market data area on an owned local PostgreSQL 18.6 cluster: full reviewed
// baseline + G4 (core.b2b_leads) + this migration. Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fixture, repo } from "./fixtures/customerTestClassificationNative.mjs";

const MIGRATION = "supabase/migrations/20261031000100_market_data_area.sql";
const ROLLBACK = "supabase/rollbacks/20261031000100_market_data_area_down.sql";
const TABLES = ["ad_reports", "area_businesses", "business_profile_reports", "competitor_ads",
  "competitor_menu_items", "competitor_reviews", "competitors", "imports"];
const lf = async (path) => (await readFile(join(repo, path))).toString("utf8").replaceAll("\r\n", "\n");
const h = await fixture({ currentCouponSchema: true });
test.after(() => h.stop());
h.sql(await lf("supabase/migrations/20261029000100_go_outreach_tables.sql"));
const B = h.business, OTHER = randomUUID(), NOW = "'2026-10-31T12:00:00Z'";
h.sql(`ALTER TABLE core.businesses DROP CONSTRAINT IF EXISTS businesses_id_check;
  INSERT INTO core.businesses(id,name,intake_enabled,is_test) VALUES('${OTHER}','Synthetic other tenant',false,true);`);
const coreSnapshot = () => h.sql(`SELECT json_build_object(
  'tables',(SELECT json_agg(t.d ORDER BY t.d) FROM (SELECT c.relname||':'||md5(coalesce((SELECT string_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod),',' ORDER BY a.attnum)
     FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'')) AS d
     FROM pg_class c WHERE c.relnamespace='core'::regnamespace AND c.relkind='r') t),
  'functions',(SELECT json_agg(md5(pg_get_functiondef(p.oid)) ORDER BY p.proname, p.oid) FROM pg_proc p WHERE p.pronamespace='core'::regnamespace),
  'constraints',(SELECT json_agg(conname ORDER BY conname) FROM pg_constraint WHERE connamespace='core'::regnamespace))`);
const fails = (sql, pattern, options) => {
  const r = h.raw(sql, options);
  assert.notEqual(r.status, 0, sql);
  assert.match(r.stderr, pattern);
};
let coreBefore;

test("migration creates the market schema with 8 RLS tables and leaves core unchanged", async () => {
  coreBefore = coreSnapshot();
  const r = h.raw(await lf(MIGRATION)); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.sql(`SELECT json_agg(json_build_object('t',relname,'rls',relrowsecurity) ORDER BY relname)
    FROM pg_class WHERE relnamespace='market'::regnamespace AND relkind='r'`), TABLES.map((t) => ({ t, rls: true })));
  // Every table carries the shared columns; imports has no import_id.
  for (const t of TABLES) {
    const cols = h.sql(`SELECT json_agg(column_name ORDER BY column_name) FROM information_schema.columns
      WHERE table_schema='market' AND table_name='${t}' AND column_name IN ('business_id','source','observed_at','import_id','is_test','created_at')`);
    assert.deepEqual(cols, ["business_id", "created_at", ...(t === "imports" ? [] : ["import_id"]), "is_test", "observed_at", "source"], t);
  }
  // No personal-data columns anywhere in the schema.
  assert.equal(h.sql(`SELECT count(*) FROM information_schema.columns WHERE table_schema='market'
    AND column_name ~ '(email|phone|author|reviewer|first_name|last_name|contact|customer)'`), 0);
  assert.deepEqual(coreSnapshot(), coreBefore);
  assert.match(h.raw(await lf(MIGRATION)).stderr, /G8_ALREADY_APPLIED/);
  const bytes = await readFile(join(repo, MIGRATION));
  assert.equal(bytes.includes(13), false);
  console.log(JSON.stringify({ migration: MIGRATION, sha256: createHash("sha256").update(bytes).digest("hex"),
    rollbackSha256: createHash("sha256").update(await readFile(join(repo, ROLLBACK))).digest("hex") }));
});

test("anon, authenticated and service_role cannot reach the market schema", () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    assert.equal(h.sql(`SELECT has_schema_privilege('${role}','market','USAGE')`), false, role);
    assert.equal(h.sql(`SELECT count(*) FROM pg_class c WHERE c.relnamespace='market'::regnamespace AND c.relkind='r'
      AND has_table_privilege('${role}',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')`), 0, role);
    for (const t of TABLES) fails(`SELECT count(*) FROM market.${t}`, /permission denied for schema market/, { role });
    fails(`INSERT INTO market.imports(business_id,source,kind,observed_at) VALUES('${B}','csv','competitors',now())`,
      /permission denied for schema market/, { role });
  }
  fails("SELECT count(*) FROM market.competitors", /permission denied for schema market/, { service: true });
  assert.equal(h.sql("SELECT count(*) FROM pg_proc WHERE pronamespace='market'::regnamespace AND has_function_privilege('service_role',oid,'EXECUTE')"), 0);
});

test("unique keys reject duplicates; daily ad report and profile rows update in place", () => {
  const sha = "a".repeat(64);
  const imp = h.sql(`INSERT INTO market.imports(business_id,source,kind,file_name,file_sha256,period_start,period_end,row_count,status,observed_at)
    VALUES('${B}','csv','competitors','rivals.csv','${sha}','2026-10-01','2026-10-31',2,'succeeded',${NOW}) RETURNING to_jsonb(id)`);
  fails(`INSERT INTO market.imports(business_id,source,kind,file_sha256,observed_at) VALUES('${B}','csv','competitors','${sha}',${NOW})`,
    /imports_business_file_unique/);
  // API runs have no file: several are allowed. The same file for another business is allowed.
  h.sql(`INSERT INTO market.imports(business_id,source,kind,observed_at) VALUES('${B}','places_api','competitors',${NOW}),('${B}','places_api','competitors',${NOW});
    INSERT INTO market.imports(business_id,source,kind,file_sha256,observed_at,is_test) VALUES('${OTHER}','csv','competitors','${sha}',${NOW},true)`);

  const comp = h.sql(`INSERT INTO market.competitors(business_id,place_id,name,address,types,rating,review_count,latitude,longitude,website,source,observed_at,import_id)
    VALUES('${B}','place-1','Synthetic Grill','1 Synthetic St','{restaurant}',4.4,120,41.27,-72.95,'https://rival.synthetic.test','csv',${NOW},'${imp}') RETURNING to_jsonb(id)`);
  fails(`INSERT INTO market.competitors(business_id,place_id,name,source,observed_at) VALUES('${B}','place-1','Again','places_api',${NOW})`,
    /competitors_business_place_unique/);
  // A row cannot point at another business's import or competitor.
  fails(`INSERT INTO market.competitors(business_id,place_id,name,source,observed_at,import_id) VALUES('${OTHER}','place-x','X','csv',${NOW},'${imp}')`,
    /foreign key/);
  fails(`INSERT INTO market.competitor_reviews(business_id,competitor_id,external_id,source,observed_at) VALUES('${OTHER}','${comp}','r-x','places_api',${NOW})`,
    /foreign key/);

  const menu = `INSERT INTO market.competitor_menu_items(business_id,competitor_id,item_name,category,price,source,observed_at)
    VALUES('${B}','${comp}','Adana Kebab','Grill',18.50,'apify',${NOW})`;
  h.sql(menu); fails(menu, /competitor_menu_items_observation_unique/);
  h.sql(menu.replace(NOW, "'2026-11-07T12:00:00Z'")); // a later observation records price history

  const review = `INSERT INTO market.competitor_reviews(business_id,competitor_id,external_id,rating,review_text,published_at,source,observed_at)
    VALUES('${B}','${comp}','rev-1',5,'Synthetic text',${NOW},'places_api',${NOW})`;
  h.sql(review); fails(review, /competitor_reviews_external_unique/);

  const ad = `INSERT INTO market.competitor_ads(business_id,competitor_id,platform,external_id,first_seen_at,last_seen_at,ad_text,landing_url,source,observed_at)
    VALUES('${B}','${comp}','meta','ad-1',${NOW},${NOW},'Synthetic ad','https://rival.synthetic.test/x','apify',${NOW})`;
  h.sql(ad); fails(ad, /competitor_ads_external_unique/);

  const lead = h.sql(`INSERT INTO core.b2b_leads(business_id,company_name,status) VALUES('${B}','Synthetic Office','new') RETURNING to_jsonb(id)`);
  const otherLead = h.sql(`INSERT INTO core.b2b_leads(business_id,company_name,status) VALUES('${OTHER}','Other Office','new') RETURNING to_jsonb(id)`);
  const area = `INSERT INTO market.area_businesses(business_id,place_id,name,types,b2b_lead_id,source,observed_at)
    VALUES('${B}','place-a','Synthetic Office','{office}','${lead}','places_api',${NOW})`;
  h.sql(area); fails(area, /area_businesses_business_place_unique/);
  fails(`INSERT INTO market.area_businesses(business_id,place_id,name,b2b_lead_id,source,observed_at)
    VALUES('${B}','place-b','Wrong lead','${otherLead}','places_api',${NOW})`, /G8_LEAD_OTHER_BUSINESS/);
  h.sql(`INSERT INTO market.area_businesses(business_id,place_id,name,source,observed_at) VALUES('${B}','place-c','No lead','places_api',${NOW})`);

  const adReport = (clicks) => `INSERT INTO market.ad_reports(business_id,platform,campaign_id,campaign_name,report_date,impressions,clicks,spend,conversions,source,observed_at)
    VALUES('${B}','google_ads','123','Synthetic campaign','2026-10-30',1000,${clicks},12.34,1,'google_ads_api',${NOW})`;
  h.sql(adReport(10)); fails(adReport(10), /ad_reports_daily_unique/);
  h.sql(adReport(15) + " ON CONFLICT ON CONSTRAINT ad_reports_daily_unique DO UPDATE SET clicks=EXCLUDED.clicks, updated_at=now()");
  assert.deepEqual(h.sql(`SELECT json_build_object('n',count(*),'clicks',max(clicks)) FROM market.ad_reports`), { n: 1, clicks: 15 });
  fails(adReport(1).replace("'google_ads'", "'tiktok'"), /ad_reports_platform_check/);

  const profile = (value, dimension = "") => `INSERT INTO market.business_profile_reports(business_id,period_start,period_end,metric,dimension,value,source,observed_at)
    VALUES('${B}','2026-10-01','2026-10-31','search_keyword_impressions','${dimension}',${value},'business_profile_api',${NOW})`;
  h.sql(profile(5, "turkish food")); fails(profile(5, "turkish food"), /business_profile_reports_unique/);
  h.sql(profile(7, "catering west haven")); h.sql(profile(9));
  h.sql(profile(6, "turkish food") + " ON CONFLICT ON CONSTRAINT business_profile_reports_unique DO UPDATE SET value=EXCLUDED.value");
  assert.equal(h.sql(`SELECT count(*) FROM market.business_profile_reports`), 3);

  // Deleting a matched lead only clears the link.
  h.sql(`DELETE FROM core.b2b_leads WHERE id='${lead}'`);
  assert.equal(h.sql(`SELECT count(*) FROM market.area_businesses WHERE place_id='place-a' AND b2b_lead_id IS NULL`), 1);
});

test("rollback refuses while data exists, then removes the schema cleanly", async () => {
  assert.match(h.raw(await lf(ROLLBACK)).stderr, /G8_ROLLBACK_DATA_PRESENT/);
  assert.equal(h.sql("SELECT to_regnamespace('market') IS NOT NULL"), true);
  h.sql(`DELETE FROM market.competitor_menu_items; DELETE FROM market.competitor_reviews; DELETE FROM market.competitor_ads;
    DELETE FROM market.area_businesses; DELETE FROM market.ad_reports; DELETE FROM market.business_profile_reports;
    DELETE FROM market.competitors; DELETE FROM market.imports;`);
  const r = h.raw(await lf(ROLLBACK)); assert.equal(r.status, 0, r.stderr);
  assert.equal(h.sql("SELECT to_regnamespace('market') IS NULL"), true);
  assert.deepEqual(coreSnapshot(), coreBefore);
  assert.equal(h.sql("SELECT count(*) FROM pg_proc WHERE proname='area_business_lead_scope_v1'"), 0);
  assert.match(h.raw(await lf(ROLLBACK)).stderr, /G8_NOT_APPLIED/);
  // The migration applies again after a clean rollback.
  const again = h.raw(await lf(MIGRATION)); assert.equal(again.status, 0, again.stderr);
});
