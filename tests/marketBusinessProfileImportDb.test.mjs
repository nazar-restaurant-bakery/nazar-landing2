// G13 Business Profile CSV -> market.business_profile_reports on an owned local PostgreSQL 18.6
// cluster: full reviewed baseline + G4 + G8 + G12 + G13 Ads + this migration. The header and data
// rows are the real 2026-10-31 download; the description row text is a stand-in (the function
// only checks that its first four cells are empty).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fixture, repo } from "./fixtures/customerTestClassificationNative.mjs";

const MIGRATION = "supabase/migrations/20261031000400_market_business_profile_import.sql";
const ROLLBACK = "supabase/rollbacks/20261031000400_market_business_profile_import_down.sql";
const NAZAR = "a358eba4-b197-4309-805b-46f43a718454";
const FILE = "GMB_insights_Performance_Report_-_2026-9-29_-_2026-10-28_-_a1b2c3d4e5f6.csv";
const HEADER = 'Store code,Business name,Address,Labels,"Google Search - Mobile","Google Search - Desktop","Google Maps - Mobile","Google Maps - Desktop",Calls,Messages,Bookings,Directions,Website clicks,Food orders,Food menu clicks,Hotel bookings';
const DESCRIPTION = ',,,,"Number of unique users who viewed your profile on Google Search, on mobile devices","Unique users, Search on desktop","Unique users, Maps on mobile","Unique users, Maps on desktop",Number of calls,Number of message conversations,Number of bookings,Number of direction requests,Number of website clicks,Number of food orders,"Number of ""menu"" clicks",Number of hotel bookings';
const DATA = '02541028812905381025,Nazar Restaurant&bakery,"39 Elm Street unit 1, West Haven, CT 06516",,2275,410,1292,51,69,0,0,85,113,0,32,0';
const csv = (rows, eol = "\r\n") => rows.join(eol) + eol;
const REAL = csv([HEADER, DESCRIPTION, DATA]);
const METRICS = ["search_mobile_views", "search_desktop_views", "maps_mobile_views", "maps_desktop_views", "calls", "messages",
  "bookings", "directions", "website_clicks", "food_orders", "food_menu_clicks", "hotel_bookings"];
const lf = async (path) => (await readFile(join(repo, path))).toString("utf8").replaceAll("\r\n", "\n");
const h = await fixture({ currentCouponSchema: true });
test.after(() => h.stop());
assert.equal(h.business, NAZAR);
const L = h.literal;
h.sql(await lf("supabase/migrations/20261029000100_go_outreach_tables.sql"));
h.sql(await lf("supabase/migrations/20261031000100_market_data_area.sql"));
h.sql(await lf("supabase/migrations/20261031000200_market_places.sql"));
h.sql(`CREATE SCHEMA cron; CREATE TABLE cron.job(jobid bigserial PRIMARY KEY,jobname text UNIQUE,schedule text,command text,active boolean NOT NULL DEFAULT true);
 CREATE FUNCTION cron.schedule(job_name text,schedule text,command text) RETURNS bigint LANGUAGE sql
  AS $$INSERT INTO cron.job(jobname,schedule,command) VALUES(job_name,schedule,command) RETURNING jobid$$;`);
h.sql(await lf("supabase/migrations/20261031000300_market_ads.sql"));
const load = (content, name = FILE, opts) => h.sql(`SELECT market.business_profile_import_v1('${NAZAR}'::uuid, ${L(name)}, ${L(content)})`, opts);
const reports = () => h.sql(`SELECT json_object_agg(metric, value ORDER BY metric) FROM market.business_profile_reports
  WHERE period_start='2026-09-29' AND period_end='2026-10-28' AND dimension=''`);

test("migration: postgres-only import function, private schema, re-apply refused", async () => {
  const r = h.raw(await lf(MIGRATION)); assert.equal(r.status, 0, r.stderr);
  for (const role of ["anon", "authenticated", "service_role"]) {
    assert.equal(h.sql(`SELECT has_function_privilege('${role}','market.business_profile_import_v1(uuid,text,text)','EXECUTE')`), false);
    assert.equal(h.sql(`SELECT has_schema_privilege('${role}','market','USAGE')`), false);
  }
  assert.deepEqual(h.sql(`SELECT json_build_array(prosecdef,proconfig) FROM pg_proc WHERE oid='market.business_profile_import_v1(uuid,text,text)'::regprocedure`),
    [true, ['search_path=""']]);
  assert.throws(() => load(REAL, FILE, { service: true }), /permission denied/);
  assert.equal(h.sql("SELECT bool_and(relrowsecurity) FROM pg_class WHERE relnamespace='market'::regnamespace AND relkind='r'"), true);
  assert.match(h.raw(await lf(MIGRATION)).stderr, /G13_BP_ALREADY_APPLIED/);
  const bytes = await readFile(join(repo, MIGRATION));
  assert.equal(bytes.includes(13), false);
  console.log(JSON.stringify({ migration: MIGRATION, sha256: createHash("sha256").update(bytes).digest("hex"),
    rollbackSha256: createHash("sha256").update(await readFile(join(repo, ROLLBACK))).digest("hex") }));
});

test("bad file names and an end before the start are refused before anything is written", () => {
  for (const name of ["report.csv", "GMB_insights_Performance_Report_-_2026-09-29_-_2026-10-28.csv",
    "GMB_insights_Performance_Report_-_2026-13-1_-_2026-10-28_-_abc.csv", "GMB_insights_Performance_Report_-_2026-2-30_-_2026-10-28_-_abc.csv",
    "GMB_insights_Performance_Report_-_2026-9-29_-_2026-10-28_-_abc.xlsx"])
    assert.throws(() => load(REAL, name), /BUSINESS_PROFILE_FILE_NAME_INVALID/, name);
  assert.throws(() => load(REAL, "GMB_insights_Performance_Report_-_2026-10-28_-_2026-9-29_-_abc.csv"), /BUSINESS_PROFILE_PERIOD_INVALID/);
  assert.equal(h.sql("SELECT count(*) FROM market.imports WHERE source='business_profile_csv'"), 0);
});

test("header changes, extra data rows and malformed values are refused", () => {
  assert.throws(() => load(csv([HEADER.replace("Calls", "Phone calls"), DESCRIPTION, DATA])), /BUSINESS_PROFILE_HEADER_MISMATCH/);
  assert.throws(() => load(csv([HEADER + ",Extra", DESCRIPTION, DATA + ",1"])), /BUSINESS_PROFILE_HEADER_MISMATCH/);
  const swapped = HEADER.replace('"Google Maps - Mobile","Google Maps - Desktop"', '"Google Maps - Desktop","Google Maps - Mobile"');
  assert.throws(() => load(csv([swapped, DESCRIPTION, DATA])), /BUSINESS_PROFILE_HEADER_MISMATCH/);
  assert.throws(() => load(csv([HEADER, DESCRIPTION, DATA, DATA.replace("02541028812905381025", "11111111111111111111")])), /BUSINESS_PROFILE_ROW_COUNT_INVALID: .* 2 bulundu/);
  assert.throws(() => load(csv([HEADER, DESCRIPTION])), /BUSINESS_PROFILE_ROW_COUNT_INVALID/);
  assert.throws(() => load(csv([HEADER, DESCRIPTION, DATA.replace(",2275,", ",12.5,")])), /BUSINESS_PROFILE_VALUE_INVALID: "Google Search - Mobile"/);
  assert.throws(() => load(csv([HEADER, DESCRIPTION, DATA + ',"unterminated'])), /BUSINESS_PROFILE_CSV_INVALID/);
  assert.equal(h.sql("SELECT count(*) FROM market.imports WHERE source='business_profile_csv'"), 0);
  assert.equal(h.sql("SELECT count(*) FROM market.business_profile_settings"), 0);
});

test("the real file imports 12 metrics for 2026-09-29..2026-10-28 and binds the store code", () => {
  const r = load(REAL);
  assert.deepEqual([r.period_start, r.period_end, r.metrics_written, r.skipped, r.store_code],
    ["2026-09-29", "2026-10-28", 12, [], "02541028812905381025"]);
  // sha256 of the pasted text as the database receives it (the same literal, hashed in SQL).
  assert.equal(r.file_sha256, h.sql(`SELECT to_jsonb(encode(sha256(convert_to(${L(REAL)},'UTF8')),'hex'))`));
  assert.deepEqual(Object.keys(r).sort(), ["file_sha256", "import_id", "metrics_written", "period_end", "period_start", "skipped", "store_code"]);
  assert.deepEqual(reports(), { bookings: 0, calls: 69, directions: 85, food_menu_clicks: 32, food_orders: 0, hotel_bookings: 0,
    maps_desktop_views: 51, maps_mobile_views: 1292, messages: 0, search_desktop_views: 410, search_mobile_views: 2275, website_clicks: 113 });
  assert.deepEqual(h.sql(`SELECT json_agg(DISTINCT source||':'||import_id) FROM market.business_profile_reports`), ["business_profile_csv:" + r.import_id]);
  assert.deepEqual(h.sql(`SELECT json_build_array(kind,source,file_name,file_sha256,period_start,period_end,row_count,status) FROM market.imports WHERE id='${r.import_id}'`),
    ["business_profile_reports", "business_profile_csv", FILE, r.file_sha256, "2026-09-29", "2026-10-28", 12, "succeeded"]);
  assert.deepEqual(h.sql("SELECT json_build_array(business_id,store_code) FROM market.business_profile_settings"), [NAZAR, "02541028812905381025"]);
});

test("the same file again is refused with a clear message and writes nothing", () => {
  const before = h.sql("SELECT count(*) FROM market.imports");
  assert.throws(() => load(REAL), /BUSINESS_PROFILE_FILE_ALREADY_IMPORTED: bu dosya zaten yuklenmis/);
  // Same bytes under a browser-renamed copy are still the same file.
  assert.throws(() => load(REAL, FILE.replace(".csv", " (1).csv")), /bu dosya zaten yuklenmis/);
  assert.equal(h.sql("SELECT count(*) FROM market.imports"), before);
});

test("the same period from a different file updates in place; *** and empty values are skipped, not invented", () => {
  const changed = DATA.replace(",2275,410,", ",2300,***,").replace(",113,0,32,0", ",120,,32,0");
  const r = load(csv([HEADER, DESCRIPTION, changed], "\n"), FILE.replace("a1b2c3d4e5f6", "f6e5d4c3b2a1"));
  assert.equal(r.metrics_written, 10);
  assert.deepEqual(r.skipped, ["search_desktop_views", "food_orders"]);
  const now = reports();
  assert.equal(now.search_mobile_views, 2300); assert.equal(now.website_clicks, 120);
  // Skipped metrics keep the earlier file's value; nothing is written as zero.
  assert.equal(now.search_desktop_views, 410); assert.equal(now.food_orders, 0);
  assert.equal(h.sql("SELECT count(*) FROM market.business_profile_reports"), 12);
  assert.equal(h.sql("SELECT count(*) FROM (SELECT 1 FROM market.business_profile_reports GROUP BY business_id,metric,dimension,period_start,period_end HAVING count(*)>1) d"), 0);
  assert.deepEqual(h.sql(`SELECT json_build_array(row_count,status) FROM market.imports WHERE id='${r.import_id}'`), [10, "partial"]);
  // A new period with only *** writes nothing and records a failed import.
  // The quoted address holds two commas, so split fields 6.. are the 12 metric columns.
  const empty = DATA.split(",").map((v, i) => (i >= 6 ? "***" : v)).join(",");
  const none = load(csv([HEADER, DESCRIPTION, empty]), "GMB_insights_Performance_Report_-_2026-10-22_-_2026-10-28_-_x9.csv");
  assert.equal(none.metrics_written, 0); assert.equal(none.skipped.length, 12);
  assert.equal(h.sql("SELECT count(*) FROM market.business_profile_reports WHERE period_start='2026-10-22'"), 0);
  assert.equal(h.sql(`SELECT to_jsonb(status) FROM market.imports WHERE id='${none.import_id}'`), "failed");
  // BOM, LF-only line ends and a 7-day period also parse.
  const week = load("﻿" + csv([HEADER, DESCRIPTION, DATA.replace(",2275,", ",500,")], "\n"), "GMB_insights_Performance_Report_-_2026-10-22_-_2026-10-28_-_x10.csv");
  assert.equal(week.metrics_written, 12);
});

test("CRLF line ends built inside SQL (psql may drop raw CR characters) parse the same way", () => {
  const text = csv([HEADER, DESCRIPTION, DATA.replace(",2275,", ",777,")], "\n");
  const name = "GMB_insights_Performance_Report_-_2026-10-15_-_2026-10-21_-_crlf.csv";
  const r = h.sql(`SELECT market.business_profile_import_v1('${NAZAR}'::uuid, ${L(name)}, replace(${L(text)}, chr(10), chr(13)||chr(10)))`);
  assert.equal(r.metrics_written, 12);
  assert.equal(h.sql("SELECT value FROM market.business_profile_reports WHERE period_start='2026-10-15' AND metric='search_mobile_views'"), 777);
  assert.equal(h.sql("SELECT value FROM market.business_profile_reports WHERE period_start='2026-10-15' AND metric='hotel_bookings'"), 0);
  // The CRs really reached the parser: the stored hash is of the CRLF text.
  assert.equal(h.sql(`SELECT to_jsonb(file_sha256 = encode(sha256(convert_to(replace(${L(text)}, chr(10), chr(13)||chr(10)),'UTF8')),'hex')) FROM market.imports WHERE id='${r.import_id}'`), true);
  assert.notEqual(r.file_sha256, h.sql(`SELECT to_jsonb(encode(sha256(convert_to(${L(text)},'UTF8')),'hex'))`));
});

test("a different store code is refused", () => {
  const other = DATA.replace("02541028812905381025", "99999999999999999999");
  assert.throws(() => load(csv([HEADER, DESCRIPTION, other]), FILE.replace("a1b2c3d4e5f6", "other")), /BUSINESS_PROFILE_STORE_CODE_MISMATCH/);
  assert.equal(h.sql("SELECT to_jsonb(store_code) FROM market.business_profile_settings"), "02541028812905381025");
});

test("rollback refuses while imported data exists, then removes only this step", async () => {
  assert.match(h.raw(await lf(ROLLBACK)).stderr, /G13_BP_ROLLBACK_DATA_PRESENT/);
  h.sql(`DELETE FROM market.business_profile_reports; DELETE FROM market.business_profile_settings; DELETE FROM market.imports WHERE source='business_profile_csv';`);
  const r = h.raw(await lf(ROLLBACK)); assert.equal(r.status, 0, r.stderr);
  assert.equal(h.sql("SELECT to_regclass('market.business_profile_settings') IS NULL"), true);
  assert.equal(h.sql("SELECT to_regprocedure('market.business_profile_import_v1(uuid,text,text)') IS NULL AND to_regprocedure('market.csv_rows_v1(text)') IS NULL"), true);
  assert.equal(h.sql("SELECT to_regclass('market.business_profile_reports') IS NOT NULL AND to_regclass('market.ads_runs') IS NOT NULL"), true);
  assert.match(h.sql("SELECT to_jsonb(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conname='imports_kind_check'"), /ads_google/);
  assert.match(h.raw(await lf(ROLLBACK)).stderr, /G13_BP_NOT_APPLIED/);
  const again = h.raw(await lf(MIGRATION)); assert.equal(again.status, 0, again.stderr);
});
