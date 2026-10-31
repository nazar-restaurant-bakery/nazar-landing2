// G12 Places -> market on an owned local PostgreSQL 18.6 cluster: full reviewed baseline
// + G4 + G8 + this migration. Vault, pg_net and the Places API are local fakes; the Edge
// handler runs in Node and its RPC calls go to the local database as service_role.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fixture, repo } from "./fixtures/customerTestClassificationNative.mjs";
import { marketPlacesHandler } from "../supabase/functions/market-places/index.ts";
import { placesSignature, verifyTrigger } from "../supabase/functions/market-places/auth.ts";
import { machineSignature } from "../functions/_lib/dailySchedulerAuth.ts";
import { plannedCalls } from "../supabase/functions/market-places/plan.ts";

const MIGRATION = "supabase/migrations/20261031000200_market_places.sql";
const ROLLBACK = "supabase/rollbacks/20261031000200_market_places_down.sql";
const NAZAR = "a358eba4-b197-4309-805b-46f43a718454";
const NAZAR_PLACE = "ChIJKTmeJADZ54kRvLZoaDaB9J4";
const SECRET = "synthetic-local-scheduler-secret-0123456789abcdef";
const EDGE = "https://" + "a".repeat(20) + ".supabase.co/functions/v1/daily-ops-run";
const DB_URL = "https://" + "b".repeat(20) + ".supabase.co";
const KEY = "synthetic-places-key-never-real";
const lf = async (path) => (await readFile(join(repo, path))).toString("utf8").replaceAll("\r\n", "\n");
const h = await fixture({ currentCouponSchema: true });
test.after(() => h.stop());
assert.equal(h.business, NAZAR);
const L = h.literal;
h.sql(await lf("supabase/migrations/20261029000100_go_outreach_tables.sql"));
h.sql(await lf("supabase/migrations/20261031000100_market_data_area.sql"));
h.sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto;
 DO $$ BEGIN IF to_regprocedure('extensions.hmac(text,text,text)') IS NULL THEN
  EXECUTE format('CREATE FUNCTION extensions.hmac(text,text,text) RETURNS bytea LANGUAGE sql AS %L',
   'SELECT '||(SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto')||'.hmac($1,$2,$3)');
 END IF; END $$;
 CREATE SCHEMA vault; CREATE TABLE vault.decrypted_secrets(name text PRIMARY KEY,decrypted_secret text);
 CREATE SCHEMA net; CREATE TABLE net.calls(id bigserial PRIMARY KEY,url text,headers jsonb,body jsonb,timeout_ms integer);
 CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE sql
  AS $$INSERT INTO net.calls(url,headers,body,timeout_ms) VALUES(url,headers,body,timeout_milliseconds) RETURNING id$$;
 INSERT INTO core.b2b_leads(business_id,company_name,city,status) VALUES
  ('${NAZAR}','Synthetic Office, LLC','West Haven','new'),
  ('${NAZAR}','Twin Partners','Milford','new'),('${NAZAR}','Twin Partners Inc.','Milford','new');`);
const lastCall = () => h.sql("SELECT to_jsonb(c) FROM net.calls c ORDER BY id DESC LIMIT 1");
const run = (topic, dry = true, max = 150) => h.sql(`SELECT market.places_run_v1('${NAZAR}','${topic}',${dry},${max})`);

// RPC shim: PostgREST named arguments -> local function call as service_role.
async function rpcShim(name, args) {
  const types = h.sql(`SELECT json_object_agg(n,t) FROM (SELECT unnest(proargnames) n, unnest(proargtypes::oid[]::regtype[]::text[]) t
    FROM pg_proc WHERE proname=${L(name)} AND pronamespace='public'::regnamespace) s`);
  const list = Object.entries(args).map(([k, v]) => `${k}=>${v === null ? "NULL" : L(typeof v === "object" ? JSON.stringify(v) : String(v))}::${types[k]}`);
  const r = h.raw(`SELECT to_jsonb(public.${name}(${list.join(",")}))`, { service: true });
  if (r.status !== 0) return Response.json({ message: "rpc failed" }, { status: 400 });
  return new Response(r.stdout.trim() || "null", { headers: { "Content-Type": "application/json" } });
}
const comps = (extra) => [{ types: ["administrative_area_level_2"], longText: "New Haven County" },
  { types: ["administrative_area_level_1"], shortText: "CT", longText: "Connecticut" }, ...extra];
const place = (id, name, city, county = "New Haven County", loc = { latitude: 41.27, longitude: -72.95 }) => ({ id, displayName: { text: name },
  formattedAddress: `1 Synthetic St, ${city}, CT`, types: ["point_of_interest"], rating: 4.46, userRatingCount: 12, location: loc,
  websiteUri: "https://synthetic.test", nationalPhoneNumber: "(203) 555-0100",
  addressComponents: [{ types: ["locality"], longText: city }, ...comps([]).map(c => c.types[0] === "administrative_area_level_2" ? { ...c, longText: county } : c)] });
// Fake Places: catering in West Haven -> Nazar + 1 caterer; in Milford -> caterer outside county (Fairfield);
// offices in West Haven -> exact lead match; in Milford -> ambiguous (two leads).
function placesFake(log, { failAt = 0 } = {}) {
  return async (url, init) => {
    log.push({ url: String(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    if (failAt && log.length === failAt) return new Response("{}", { status: 500 });
    const u = String(url);
    if (u.endsWith("/places/" + NAZAR_PLACE)) return Response.json({ id: NAZAR_PLACE, location: { latitude: 41.2706, longitude: -72.9470 } });
    const body = log.at(-1).body;
    if (u.endsWith("places:searchText")) {
      const q = body.textQuery;
      if (q === "catering in West Haven, CT") return Response.json({ places: [place(NAZAR_PLACE, "Nazar Restaurant & Bakery", "West Haven"),
        place("caterer-west-haven-01", "Synthetic Catering", "West Haven")], nextPageToken: body.pageToken ? undefined : "page-2" });
      if (q === "catering in Milford, CT") return Response.json({ places: [place("caterer-bridgeport-1", "Outside Catering", "Bridgeport", "Fairfield County")] });
      if (q === "corporate office in West Haven, CT") return Response.json({ places: [place("office-west-haven-1", "Synthetic Office", "West Haven")] });
      if (q === "law firm in Milford, CT") return Response.json({ places: [place("office-milford-0001", "Twin Partners", "Milford")] });
      return Response.json({});
    }
    if (u.endsWith("places:searchNearby")) {
      const t = body.includedTypes[0];
      if (t === "bakery") return Response.json({ places: [place(NAZAR_PLACE, "Nazar Restaurant & Bakery", "West Haven", "New Haven County", { latitude: 41.2706, longitude: -72.947 }),
        place("bakery-near-000001", "Near Bakery", "West Haven", "New Haven County", { latitude: 41.28, longitude: -72.95 }),
        place("bakery-far-0000001", "Far Bakery", "Hartford", "Hartford County", { latitude: 41.76, longitude: -72.68 })] });
      return Response.json({});
    }
    throw Error("unexpected url " + u);
  };
}
function edge(placesLog, opts) {
  const fakePlaces = placesFake(placesLog, opts);
  const rpcLog = [];
  const fetcher = async (url, init) => {
    if (String(url).startsWith(DB_URL + "/rest/v1/rpc/")) { const name = String(url).split("/").at(-1); rpcLog.push(name); return rpcShim(name, JSON.parse(init.body)); }
    if (String(url).startsWith("https://places.googleapis.com/v1/")) return fakePlaces(url, init);
    throw Error("unexpected host " + url);
  };
  const env = { SUPABASE_URL: DB_URL, SUPABASE_SERVICE_ROLE_KEY: "synthetic-service", SCHEDULER_SIGNING_SECRET: SECRET, GOOGLE_PLACES_API_KEY: KEY };
  return { handler: marketPlacesHandler(fetcher), env, rpcLog };
}
// Replays the pg_net request the database queued.
const deliver = async (handler, env, call = lastCall()) => {
  const logs = [], original = console.info; console.info = (...a) => logs.push(a.join(" "));
  try {
    const r = await handler(new Request(call.url, { method: "POST", headers: call.headers, body: JSON.stringify(call.body) }), env);
    return { status: r.status, body: await r.json(), logs };
  } finally { console.info = original; }
};
const counts = () => h.sql(`SELECT json_build_object('c',(SELECT count(*) FROM market.competitors),'a',(SELECT count(*) FROM market.area_businesses))`);

test("migration: settings rows, private schema, postgres-only setup functions", async () => {
  const r = h.raw(await lf(MIGRATION)); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.sql(`SELECT json_agg(json_build_object('t',topic,'m',mode,'c',counties,'r',radius_miles,'e',enabled) ORDER BY topic) FROM market.area_settings`),
    [{ t: "catering", m: "county", c: ["New Haven County"], r: null, e: true }, { t: "restaurant", m: "radius", c: null, r: 5, e: true }]);
  for (const role of ["anon", "authenticated", "service_role"]) {
    assert.equal(h.sql(`SELECT has_schema_privilege('${role}','market','USAGE')`), false);
    for (const fn of ["market.places_run_v1(uuid,text,boolean,integer)", "market.area_settings_set_v1(uuid,text,text[],numeric,boolean)"])
      assert.equal(h.sql(`SELECT has_function_privilege('${role}','${fn}','EXECUTE')`), false, role + fn);
  }
  for (const fn of ["public.market_places_claim_v1(uuid,uuid,uuid)", "public.market_places_finish_v1(uuid,uuid,uuid,text,text,integer,integer,jsonb,jsonb)"]) {
    assert.equal(h.sql(`SELECT has_function_privilege('service_role','${fn}','EXECUTE')`), true);
    assert.equal(h.sql(`SELECT has_function_privilege('anon','${fn}','EXECUTE')`), false);
    assert.equal(h.sql(`SELECT has_function_privilege('authenticated','${fn}','EXECUTE')`), false);
    assert.deepEqual(h.sql(`SELECT json_build_array(prosecdef,proconfig) FROM pg_proc WHERE oid='${fn}'::regprocedure`), [true, ['search_path=""']]);
  }
  assert.equal(h.sql("SELECT bool_and(relrowsecurity) FROM pg_class WHERE relnamespace='market'::regnamespace AND relkind='r'"), true);
  assert.match(h.raw(await lf(MIGRATION)).stderr, /G12_ALREADY_APPLIED/);
  const bytes = await readFile(join(repo, MIGRATION));
  assert.equal(bytes.includes(13), false);
  console.log(JSON.stringify({ migration: MIGRATION, sha256: createHash("sha256").update(bytes).digest("hex"),
    rollbackSha256: createHash("sha256").update(await readFile(join(repo, ROLLBACK))).digest("hex") }));
});

test("one SQL line changes the area; invalid settings are refused", () => {
  const set = h.sql(`SELECT market.area_settings_set_v1('${NAZAR}','catering',ARRAY['New Haven County','Fairfield County'],NULL)`);
  assert.deepEqual(set.counties, ["New Haven County", "Fairfield County"]);
  assert.throws(() => h.sql(`SELECT market.area_settings_set_v1('${NAZAR}','catering',ARRAY['New Haven'],NULL)`), /check constraint/);
  assert.throws(() => h.sql(`SELECT market.area_settings_set_v1('${NAZAR}','restaurant',NULL,40)`), /check constraint/);
  assert.throws(() => h.sql(`SELECT market.area_settings_set_v1('${NAZAR}','catering',NULL,5)`), /check constraint/);
  assert.throws(() => h.sql(`SELECT market.area_settings_set_v1('${NAZAR}','catering',ARRAY['New Haven County'],NULL)`, { service: true }), /permission denied/);
  h.sql(`SELECT market.area_settings_set_v1('${NAZAR}','catering',ARRAY['New Haven County'],NULL)`);
});

test("run starter signs with the vault key and the market_places label, derives the URL strictly", async () => {
  assert.throws(() => run("catering"), /no rows/);
  h.sql(`INSERT INTO vault.decrypted_secrets VALUES('SCHEDULER_SIGNING_SECRET','${SECRET}'),('SCHEDULER_EDGE_URL','https://evil.example/functions/v1/daily-ops-run')`);
  assert.throws(() => run("catering"), /SCHEDULER_EDGE_URL_INVALID/);
  h.sql(`UPDATE vault.decrypted_secrets SET decrypted_secret='${EDGE}' WHERE name='SCHEDULER_EDGE_URL'`);
  assert.throws(() => run("catering", true, 0), /MARKET_PLACES_MAX_CALLS_INVALID/);
  assert.throws(() => run("catering", true, 501), /MARKET_PLACES_MAX_CALLS_INVALID/);
  assert.throws(() => h.sql(`SELECT market.places_run_v1('${NAZAR}','catering',true,150)`, { service: true }), /permission denied/);
  const started = run("catering");
  assert.deepEqual(Object.keys(started).sort(), ["dry_run", "max_calls", "request_id", "run_id", "topic"]);
  assert.ok(!JSON.stringify(started).includes(SECRET));
  const call = lastCall();
  assert.equal(call.url, "https://" + "a".repeat(20) + ".supabase.co/functions/v1/market-places");
  assert.equal(call.timeout_ms, 10000);
  assert.deepEqual(Object.keys(call.body).sort(), ["business_id", "issued_at", "nonce", "run_id"]);
  const sig = call.headers["X-Scheduler-Signature"];
  assert.equal(await verifyTrigger(call.body, sig, SECRET), true);
  assert.equal(sig, await placesSignature(call.body, SECRET));
  // The scheduler's purpose cannot be reused here.
  assert.notEqual(sig, await machineSignature("daily.dispatch.v1", call.body, SECRET));
  assert.throws(() => run("catering"), /MARKET_PLACES_RUN_ACTIVE/);
  h.sql("UPDATE market.places_runs SET status='failed',safe_code='test_reset'");
});

test("unsigned, wrong-label and replayed requests are refused before any Places call", async () => {
  run("catering", false);
  const call = lastCall(), places = [];
  const { handler, env, rpcLog } = edge(places);
  assert.equal((await deliver(handler, env, { ...call, headers: { "Content-Type": "application/json" } })).status, 401);
  const wrong = await machineSignature("daily.dispatch.v1", call.body, SECRET);
  assert.equal((await deliver(handler, env, { ...call, headers: { ...call.headers, "X-Scheduler-Signature": wrong } })).status, 401);
  assert.equal((await deliver(handler, env, { ...call, body: { ...call.body, nonce: randomUUID() } })).status, 401);
  assert.equal(rpcLog.length, 0); assert.equal(places.length, 0);
  // A validly signed request with a wrong nonce for the run cannot claim it.
  const forged = { ...call.body, nonce: randomUUID() };
  assert.equal((await deliver(handler, env, { ...call, body: forged, headers: { ...call.headers, "X-Scheduler-Signature": await placesSignature(forged, SECRET) } })).status, 409);
  assert.equal(places.length, 0);
  h.sql("UPDATE market.places_runs SET status='failed',safe_code='test_reset'");
});

test("dry run makes zero Places calls and records only the planned call count", async () => {
  for (const topic of ["catering", "restaurant"]) {
    run(topic, true);
    const places = [], { handler, env } = edge(places);
    const r = await deliver(handler, env);
    assert.equal(r.status, 200); assert.equal(places.length, 0);
    assert.equal(r.body.code, "dry_run"); assert.equal(r.body.planned_calls, topic === "catering" ? 108 : 112);
    const row = h.sql(`SELECT to_jsonb(r) FROM market.places_runs r WHERE topic='${topic}' ORDER BY created_at DESC LIMIT 1`);
    assert.deepEqual([row.status, row.safe_code, row.calls_used, row.planned_calls, row.competitors_written], ["succeeded", "dry_run", 0, r.body.planned_calls, 0]);
    assert.equal(h.sql(`SELECT to_jsonb(kind||':'||status||':'||row_count) FROM market.imports WHERE id='${row.import_id}'`), `places_${topic}:succeeded:0`);
  }
  assert.deepEqual(counts(), { c: 0, a: 0 });
});

test("catering run: county filter, Nazar excluded, exact single lead match only, field mask only", async () => {
  run("catering", false);
  const places = [], { handler, env } = edge(places);
  const r = await deliver(handler, env);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // 108 first pages + 1 second page for the paged query = 109, below the 150 cap.
  assert.equal(places.length, 109); assert.equal(r.body.calls_used, 109);
  for (const p of places) {
    assert.equal(p.headers["X-Goog-Api-Key"], KEY);
    assert.equal(p.headers["X-Goog-FieldMask"], "places.id,places.displayName,places.formattedAddress,places.types,places.rating,places.userRatingCount,places.location,places.websiteUri,places.addressComponents,nextPageToken");
  }
  assert.deepEqual(h.sql("SELECT json_agg(place_id||':'||county||':'||array_to_string(topics,',') ORDER BY place_id) FROM market.competitors"),
    ["caterer-west-haven-01:New Haven County:catering"]);
  assert.equal(h.sql(`SELECT count(*) FROM market.competitors WHERE place_id='${NAZAR_PLACE}'`), 0);
  const area = h.sql(`SELECT json_agg(json_build_object('p',a.place_id,'lead',l.company_name,'city',a.city) ORDER BY a.place_id)
    FROM market.area_businesses a LEFT JOIN core.b2b_leads l ON l.id=a.b2b_lead_id`);
  assert.deepEqual(area, [{ p: "office-milford-0001", lead: null, city: "Milford" }, { p: "office-west-haven-1", lead: "Synthetic Office, LLC", city: "West Haven" }]);
  // No personal or provider-extra data: the phone in the fake response is not stored anywhere.
  assert.equal(h.sql("SELECT count(*) FROM market.competitors c, market.area_businesses a WHERE (to_jsonb(c)||to_jsonb(a))::text LIKE '%555-0100%'"), 0);
  assert.ok(!r.logs.join("").includes(KEY) && !r.logs.join("").includes(SECRET));
  const leadsBefore = h.sql("SELECT to_jsonb(md5(json_agg(l ORDER BY id)::text)) FROM core.b2b_leads l");
  // A second run updates in place: no duplicates, same lead links, core.b2b_leads unchanged.
  run("catering", false);
  const again = await deliver(edge([]).handler, env);
  assert.equal(again.status, 200);
  assert.deepEqual(counts(), { c: 1, a: 2 });
  assert.equal(h.sql("SELECT to_jsonb(md5(json_agg(l ORDER BY id)::text)) FROM core.b2b_leads l"), leadsBefore);
  assert.equal(h.sql("SELECT count(*) FROM market.imports WHERE kind='places_catering' AND status='succeeded' AND row_count=3"), 2);
});

test("restaurant run: 5-mile radius around Nazar, Nazar excluded, topics merge without duplicates", async () => {
  run("restaurant", false);
  const places = [], { handler, env } = edge(places);
  const r = await deliver(handler, env);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(places.length, 112);
  assert.ok(places[0].url.endsWith("/places/" + NAZAR_PLACE)); assert.equal(places[0].headers["X-Goog-FieldMask"], "id,location");
  assert.ok(places.slice(1).every(p => p.body.locationRestriction.circle.radius > 0 && p.body.rankPreference === "DISTANCE"));
  assert.deepEqual(h.sql("SELECT json_agg(place_id||':'||array_to_string(topics,',') ORDER BY place_id) FROM market.competitors"),
    ["bakery-near-000001:restaurant", "caterer-west-haven-01:catering"]);
  // The same caterer later found by the restaurant scan keeps one row with both topics.
  h.sql(`UPDATE market.competitors SET topics='{catering}' WHERE place_id='bakery-near-000001'`);
  run("restaurant", false);
  assert.equal((await deliver(edge([]).handler, env)).status, 200);
  assert.deepEqual(h.sql("SELECT json_agg(place_id||':'||array_to_string(topics,',') ORDER BY place_id) FROM market.competitors"),
    ["bakery-near-000001:catering,restaurant", "caterer-west-haven-01:catering"]);
});

test("call cap stops the scan and records a partial run; a Places error never leaks the key", async () => {
  run("catering", false, 5);
  const places = [], { handler, env } = edge(places);
  const r = await deliver(handler, env);
  assert.equal(places.length, 5);
  const row = h.sql("SELECT to_jsonb(r) FROM market.places_runs r ORDER BY created_at DESC LIMIT 1");
  assert.deepEqual([row.calls_used, row.planned_calls, row.max_calls], [5, plannedCalls({ mode: "county", state: "CT", counties: ["New Haven County"] }), 5]);
  assert.ok(["partial", "failed"].includes(row.status)); assert.equal(row.safe_code, "call_cap_reached");
  assert.ok(r.status === 200 || r.status === 503);
  run("restaurant", false);
  const failing = [], e = edge(failing, { failAt: 3 });
  const f = await deliver(e.handler, e.env);
  assert.equal(failing.length, 3);
  assert.equal(h.sql("SELECT to_jsonb(safe_code) FROM market.places_runs ORDER BY created_at DESC LIMIT 1"), "places_http_500");
  assert.ok(!JSON.stringify([f.body, f.logs]).includes(KEY));
});

test("finish refuses out-of-area rows, writes from dry runs and unclaimed runs", () => {
  run("catering", false);
  const call = lastCall();
  const claim = h.sql(`SELECT public.market_places_claim_v1('${NAZAR}','${call.body.run_id}','${call.body.nonce}')`, { service: true });
  assert.equal(h.sql(`SELECT public.market_places_claim_v1('${NAZAR}','${call.body.run_id}','${call.body.nonce}')`, { service: true }), null);
  const row = { place_id: "outside-place-0001", name: "Outside", city: "Hartford", county: "Hartford County", types: [] };
  const finish = (token, comps) => `SELECT public.market_places_finish_v1('${NAZAR}','${call.body.run_id}','${token}','succeeded','completed',1,1,${L(JSON.stringify(comps))}::jsonb,'[]'::jsonb)`;
  assert.throws(() => h.sql(finish(claim.claim_token, [row]), { service: true }), /MARKET_PLACES_OUTSIDE_AREA/);
  assert.throws(() => h.sql(finish(randomUUID(), []), { service: true }), /MARKET_PLACES_RUN_NOT_CLAIMED/);
  assert.throws(() => h.sql(finish(claim.claim_token, []), { role: "authenticated" }), /permission denied/);
  h.sql(finish(claim.claim_token, []), { service: true });
  run("catering", true);
  const dry = lastCall();
  const dryClaim = h.sql(`SELECT public.market_places_claim_v1('${NAZAR}','${dry.body.run_id}','${dry.body.nonce}')`, { service: true });
  assert.throws(() => h.sql(`SELECT public.market_places_finish_v1('${NAZAR}','${dry.body.run_id}','${dryClaim.claim_token}','succeeded','dry_run',108,1,'[]'::jsonb,'[]'::jsonb)`, { service: true }),
    /MARKET_PLACES_DRY_RUN_WROTE/);
});

test("rollback refuses while Places data exists, then restores G8 exactly", async () => {
  assert.match(h.raw(await lf(ROLLBACK)).stderr, /G12_ROLLBACK_DATA_PRESENT/);
  h.sql(`DELETE FROM market.area_businesses; DELETE FROM market.competitors; DELETE FROM market.places_runs; DELETE FROM market.imports;`);
  const r = h.raw(await lf(ROLLBACK)); assert.equal(r.status, 0, r.stderr);
  assert.equal(h.sql("SELECT to_regclass('market.area_settings') IS NULL AND to_regclass('market.places_runs') IS NULL"), true);
  assert.equal(h.sql("SELECT count(*) FROM information_schema.columns WHERE table_schema='market' AND column_name IN ('topics','city','county')"), 0);
  assert.equal(h.sql("SELECT count(*) FROM pg_proc WHERE proname LIKE 'market\\_places\\_%' OR pronamespace='market'::regnamespace AND proname<>'area_business_lead_scope_v1'"), 0);
  assert.doesNotMatch(h.sql("SELECT to_jsonb(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conname='imports_kind_check'"), /places_/);
  assert.match(h.raw(await lf(ROLLBACK)).stderr, /G12_NOT_APPLIED/);
  const again = h.raw(await lf(MIGRATION)); assert.equal(again.status, 0, again.stderr);
});
