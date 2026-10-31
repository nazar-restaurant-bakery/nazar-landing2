// G13 Google Ads -> market.ad_reports on an owned local PostgreSQL 18.6 cluster: full reviewed
// baseline + G4 + G8 + G12 + this migration. Vault, pg_net, pg_cron, Google (OAuth + Ads API) and
// Resend are local fakes; the Edge handler runs in Node and its RPC calls go to the local
// database as service_role.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fixture, repo } from "./fixtures/customerTestClassificationNative.mjs";
import { marketAdsHandler } from "../supabase/functions/market-ads/index.ts";
import { adsSignature, verifyTrigger } from "../supabase/functions/market-ads/auth.ts";
import { placesSignature } from "../supabase/functions/market-places/auth.ts";
import { machineSignature } from "../functions/_lib/dailySchedulerAuth.ts";
import { ALERT_SUBJECT, ALERT_TO } from "../supabase/functions/market-ads/alert.ts";

const MIGRATION = "supabase/migrations/20261031000300_market_ads.sql";
const ROLLBACK = "supabase/rollbacks/20261031000300_market_ads_down.sql";
const NAZAR = "a358eba4-b197-4309-805b-46f43a718454";
const SECRET = "synthetic-local-scheduler-secret-0123456789abcdef";
const EDGE = "https://" + "a".repeat(20) + ".supabase.co/functions/v1/daily-ops-run";
const DB_URL = "https://" + "b".repeat(20) + ".supabase.co";
const ADS_SECRETS = { GOOGLE_ADS_CLIENT_ID: "synthetic-client-id", GOOGLE_ADS_CLIENT_SECRET: "synthetic-client-secret-never-real",
  GOOGLE_ADS_REFRESH_TOKEN: "synthetic-refresh-token-never-real", GOOGLE_ADS_CUSTOMER_ID: "647-847-7284" };
const RESEND_KEY = "re_synthetic_alert_key_never_real";
const lf = async (path) => (await readFile(join(repo, path))).toString("utf8").replaceAll("\r\n", "\n");
const h = await fixture({ currentCouponSchema: true });
test.after(() => h.stop());
assert.equal(h.business, NAZAR);
const L = h.literal;
h.sql(await lf("supabase/migrations/20261029000100_go_outreach_tables.sql"));
h.sql(await lf("supabase/migrations/20261031000100_market_data_area.sql"));
h.sql(await lf("supabase/migrations/20261031000200_market_places.sql"));
h.sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto;
 DO $$ BEGIN IF to_regprocedure('extensions.hmac(text,text,text)') IS NULL THEN
  EXECUTE format('CREATE FUNCTION extensions.hmac(text,text,text) RETURNS bytea LANGUAGE sql AS %L',
   'SELECT '||(SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto')||'.hmac($1,$2,$3)');
 END IF; END $$;
 CREATE SCHEMA vault; CREATE TABLE vault.decrypted_secrets(name text PRIMARY KEY,decrypted_secret text);
 CREATE SCHEMA net; CREATE TABLE net.calls(id bigserial PRIMARY KEY,url text,headers jsonb,body jsonb,timeout_ms integer);
 CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE sql
  AS $$INSERT INTO net.calls(url,headers,body,timeout_ms) VALUES(url,headers,body,timeout_milliseconds) RETURNING id$$;
 CREATE SCHEMA cron; CREATE TABLE cron.job(jobid bigserial PRIMARY KEY,jobname text UNIQUE,schedule text,command text,active boolean NOT NULL DEFAULT true);
 CREATE FUNCTION cron.schedule(job_name text,schedule text,command text) RETURNS bigint LANGUAGE sql
  AS $$INSERT INTO cron.job(jobname,schedule,command) VALUES(job_name,schedule,command) RETURNING jobid$$;
 CREATE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean LANGUAGE sql AS $$DELETE FROM cron.job WHERE jobid=job_id RETURNING true$$;
 INSERT INTO cron.job(jobname,schedule,command,active) VALUES('platform-daily-ops','* * * * *','SELECT core.daily_scheduler_tick();',true);`);
const otherJobs = () => h.sql("SELECT json_agg(json_build_array(jobname,schedule,command,active) ORDER BY jobid) FROM cron.job WHERE jobname<>'market-ads-daily'");
const OTHER_JOBS = otherJobs();
const lastCall = () => h.sql("SELECT to_jsonb(c) FROM net.calls c ORDER BY id DESC LIMIT 1");
const start = (days = 30, dry = false, max = 10) => h.sql(`SELECT market.ads_run_v1('${NAZAR}',${days},${dry},${max})`);
const lastRun = () => h.sql("SELECT to_jsonb(r) FROM market.ads_runs r ORDER BY created_at DESC LIMIT 1");
const reset = () => h.sql("UPDATE market.ads_runs SET status='failed',safe_code='test_reset' WHERE status IN ('queued','running')");

async function rpcShim(name, args) {
  const types = h.sql(`SELECT json_object_agg(n,t) FROM (SELECT unnest(proargnames) n, unnest(proargtypes::oid[]::regtype[]::text[]) t
    FROM pg_proc WHERE proname=${L(name)} AND pronamespace='public'::regnamespace) s`);
  const list = Object.entries(args).map(([k, v]) => `${k}=>${v === null ? "NULL" : L(typeof v === "object" ? JSON.stringify(v) : String(v))}::${types[k]}`);
  const r = h.raw(`SELECT to_jsonb(public.${name}(${list.join(",")}))`, { service: true });
  if (r.status !== 0) return Response.json({ message: "rpc failed" }, { status: 400 });
  return new Response(r.stdout.trim() || "null", { headers: { "Content-Type": "application/json" } });
}
const days = (from, to) => { const out = []; for (let d = new Date(from + "T12:00:00Z"); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10)); return out; };
// Campaign 111 has a row every day; 222 only on even days and without clicks (proto3 omits zeros).
// Days without a row stay absent in the database.
const expectedRows = (from, to) => days(from, to).reduce((n, d) => n + 1 + (Number(d.slice(8)) % 2 === 0 ? 1 : 0), 0);
function googleFake(log, { tokenError = null, currency = "USD", timeZone = "America/New_York", empty = false, impressions = "100" } = {}) {
  return async (url, init) => {
    const u = String(url);
    log.push({ url: u, headers: init.headers, body: String(init.body ?? "") });
    if (u === "https://oauth2.googleapis.com/token") {
      if (tokenError) return Response.json({ error: tokenError, error_description: "Token has been expired or revoked." }, { status: 400 });
      return Response.json({ access_token: "synthetic-access-token", expires_in: 3599, token_type: "Bearer" });
    }
    if (u === "https://googleads.googleapis.com/v26/customers/6478477284/googleAds:searchStream") {
      const q = JSON.parse(init.body).query;
      if (q.includes("FROM customer")) return Response.json([{ results: [{ customer: { resourceName: "customers/6478477284", id: "6478477284", currencyCode: currency, timeZone } }] }]);
      if (empty) return Response.json([]);
      const [, from, to] = q.match(/BETWEEN '([\d-]+)' AND '([\d-]+)'$/);
      const results = days(from, to).flatMap(date => [
        { campaign: { resourceName: "customers/6478477284/campaigns/111", id: "111", name: "Catering Search" }, segments: { date },
          metrics: { impressions, clicks: "7", costMicros: "12345678", conversions: 1.5 } },
        ...(Number(date.slice(8)) % 2 === 0 ? [{ campaign: { id: "222", name: "Bakery Local" }, segments: { date },
          metrics: { impressions: "40", costMicros: "500000" } }] : [])]);
      return Response.json([{ results, fieldMask: "campaign.id,campaign.name,segments.date,metrics.impressions,metrics.clicks,metrics.costMicros,metrics.conversions" }]);
    }
    if (u === "https://api.resend.com/emails") return Response.json({ id: "synthetic-email-" + log.length });
    throw Error("unexpected url " + u);
  };
}
function edge(log, opts = {}, envExtra = {}) {
  const google = googleFake(log, opts);
  const fetcher = async (url, init) => String(url).startsWith(DB_URL + "/rest/v1/rpc/")
    ? rpcShim(String(url).split("/").at(-1), JSON.parse(init.body)) : google(url, init);
  const env = { SUPABASE_URL: DB_URL, SUPABASE_SERVICE_ROLE_KEY: "synthetic-service", SCHEDULER_SIGNING_SECRET: SECRET, ...ADS_SECRETS, ...envExtra };
  return { handler: marketAdsHandler(fetcher), env };
}
const deliver = async (handler, env, call = lastCall()) => {
  const logs = [], original = console.info; console.info = (...a) => logs.push(a.join(" "));
  try {
    const r = await handler(new Request(call.url, { method: "POST", headers: call.headers, body: JSON.stringify(call.body) }), env);
    return { status: r.status, body: await r.json(), logs };
  } finally { console.info = original; }
};
const secretsIn = (text) => [SECRET, RESEND_KEY, "synthetic-access-token", ...Object.values(ADS_SECRETS).slice(0, 3)].filter(s => text.includes(s));
const adRows = () => h.sql("SELECT count(*) FROM market.ad_reports");

test("migration: private schema, postgres-only starters, separate cron job, existing jobs untouched", async () => {
  const r = h.raw(await lf(MIGRATION)); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(h.sql("SELECT json_agg(json_build_array(business_id,daily_enabled)) FROM market.ads_settings"), [[NAZAR, true]]);
  assert.deepEqual(h.sql("SELECT json_build_array(schedule,command,active) FROM cron.job WHERE jobname='market-ads-daily'"),
    ["30 * * * *", "SELECT market.ads_cron_tick_v1();", true]);
  assert.deepEqual(otherJobs(), OTHER_JOBS);
  for (const role of ["anon", "authenticated", "service_role"]) {
    assert.equal(h.sql(`SELECT has_schema_privilege('${role}','market','USAGE')`), false);
    for (const fn of ["market.ads_run_v1(uuid,integer,boolean,integer)", "market.ads_cron_tick_v1(timestamptz)", "market.ads_expire_v1(uuid)"])
      assert.equal(h.sql(`SELECT has_function_privilege('${role}','${fn}','EXECUTE')`), false, role + fn);
  }
  for (const fn of ["public.market_ads_claim_v1(uuid,uuid,uuid)", "public.market_ads_finish_v1(uuid,uuid,uuid,text,text,integer,jsonb)",
    "public.market_ads_alert_v1(uuid,uuid,uuid,text)"]) {
    assert.equal(h.sql(`SELECT has_function_privilege('service_role','${fn}','EXECUTE')`), true);
    assert.equal(h.sql(`SELECT has_function_privilege('anon','${fn}','EXECUTE')`), false);
    assert.equal(h.sql(`SELECT has_function_privilege('authenticated','${fn}','EXECUTE')`), false);
    assert.deepEqual(h.sql(`SELECT json_build_array(prosecdef,proconfig) FROM pg_proc WHERE oid='${fn}'::regprocedure`), [true, ['search_path=""']]);
  }
  assert.equal(h.sql("SELECT bool_and(relrowsecurity) FROM pg_class WHERE relnamespace='market'::regnamespace AND relkind='r'"), true);
  assert.match(h.sql("SELECT to_jsonb(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conname='imports_kind_check'"), /ads_google/);
  assert.match(h.raw(await lf(MIGRATION)).stderr, /G13_ALREADY_APPLIED/);
  const bytes = await readFile(join(repo, MIGRATION));
  assert.equal(bytes.includes(13), false);
  console.log(JSON.stringify({ migration: MIGRATION, sha256: createHash("sha256").update(bytes).digest("hex"),
    rollbackSha256: createHash("sha256").update(await readFile(join(repo, ROLLBACK))).digest("hex") }));
});

test("run starter signs with the vault key and the market_ads label, derives the URL strictly", async () => {
  assert.throws(() => start(), /no rows/);
  h.sql(`INSERT INTO vault.decrypted_secrets VALUES('SCHEDULER_SIGNING_SECRET','${SECRET}'),('SCHEDULER_EDGE_URL','https://evil.example/functions/v1/daily-ops-run')`);
  assert.throws(() => start(), /SCHEDULER_EDGE_URL_INVALID/);
  h.sql(`UPDATE vault.decrypted_secrets SET decrypted_secret='${EDGE}' WHERE name='SCHEDULER_EDGE_URL'`);
  assert.throws(() => start(0), /MARKET_ADS_DAYS_INVALID/);
  assert.throws(() => start(91), /MARKET_ADS_DAYS_INVALID/);
  assert.throws(() => start(30, false, 0), /MARKET_ADS_MAX_CALLS_INVALID/);
  assert.throws(() => start(30, false, 51), /MARKET_ADS_MAX_CALLS_INVALID/);
  assert.throws(() => h.sql(`SELECT market.ads_run_v1('${NAZAR}')`, { service: true }), /permission denied/);
  const started = h.sql(`SELECT market.ads_run_v1('${NAZAR}')`);
  assert.deepEqual(Object.keys(started).sort(), ["days", "dry_run", "max_calls", "request_id", "run_id"]);
  assert.deepEqual([started.days, started.dry_run, started.max_calls], [30, false, 10]);
  assert.ok(!JSON.stringify(started).includes(SECRET));
  const call = lastCall();
  assert.equal(call.url, "https://" + "a".repeat(20) + ".supabase.co/functions/v1/market-ads");
  assert.deepEqual(Object.keys(call.body).sort(), ["business_id", "issued_at", "nonce", "run_id"]);
  const sig = call.headers["X-Scheduler-Signature"];
  assert.equal(await verifyTrigger(call.body, sig, SECRET), true);
  assert.equal(sig, await adsSignature(call.body, SECRET));
  assert.notEqual(sig, await placesSignature(call.body, SECRET));
  assert.notEqual(sig, await machineSignature("daily.dispatch.v1", call.body, SECRET));
  assert.throws(() => start(), /MARKET_ADS_RUN_ACTIVE/);
  reset();
});

test("unsigned, wrong-label and replayed requests are refused before any Google call", async () => {
  start();
  const call = lastCall(), log = [], { handler, env } = edge(log);
  assert.equal((await deliver(handler, env, { ...call, headers: { "Content-Type": "application/json" } })).status, 401);
  for (const wrong of [await placesSignature(call.body, SECRET), await machineSignature("daily.dispatch.v1", call.body, SECRET)])
    assert.equal((await deliver(handler, env, { ...call, headers: { ...call.headers, "X-Scheduler-Signature": wrong } })).status, 401);
  assert.equal((await deliver(handler, env, { ...call, body: { ...call.body, nonce: randomUUID() } })).status, 401);
  const forged = { ...call.body, nonce: randomUUID() };
  assert.equal((await deliver(handler, env, { ...call, body: forged, headers: { ...call.headers, "X-Scheduler-Signature": await adsSignature(forged, SECRET) } })).status, 409);
  assert.equal(log.length, 0);
  // The real request is accepted once; the replay of the same signed body is refused.
  assert.equal((await deliver(handler, env, call)).status, 200);
  assert.equal((await deliver(handler, env, call)).status, 409);
  h.sql("DELETE FROM market.ad_reports");
});

test("dry run makes zero Google calls; the period is yesterday back p_days (New York), today excluded", async () => {
  start(90, true);
  const log = [], { handler, env } = edge(log);
  const r = await deliver(handler, env);
  assert.equal(r.status, 200); assert.equal(r.body.code, "dry_run"); assert.equal(r.body.planned_calls, 3); assert.equal(log.length, 0);
  const row = lastRun();
  assert.deepEqual([row.status, row.safe_code, row.calls_used, row.rows_written, row.alert_status], ["succeeded", "dry_run", 0, 0, null]);
  assert.equal(h.sql(`SELECT period_end = (now() AT TIME ZONE 'America/New_York')::date - 1 AND period_start = period_end - 89
    FROM market.ads_runs WHERE id='${row.id}'`), true);
  assert.equal(h.sql(`SELECT to_jsonb(source||':'||kind||':'||status||':'||row_count) FROM market.imports WHERE id='${row.import_id}'`), "google_ads_api:ads_google:succeeded:0");
  assert.equal(adRows(), 0);
});

test("90-day first run, then 30-day reruns rewrite in place: no duplicates, no invented zero days", async () => {
  start(90);
  const log = [], { handler, env } = edge(log);
  const r = await deliver(handler, env);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const first = lastRun();
  const expected = expectedRows(first.period_start, first.period_end);
  assert.deepEqual([first.status, first.safe_code, first.calls_used, first.rows_written], ["succeeded", "completed", 3, expected]);
  assert.equal(adRows(), expected);
  assert.equal(log.length, 3);
  assert.equal(log[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(JSON.parse(log[2].body).query, `SELECT campaign.id, campaign.name, segments.date, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE segments.date BETWEEN '${first.period_start}' AND '${first.period_end}'`);
  assert.ok(!("developer-token" in log[1].headers));
  // Campaign 222 has no odd-day rows: nothing is invented for those days; its missing clicks are 0.
  assert.equal(h.sql("SELECT count(*) FROM market.ad_reports WHERE campaign_id='222' AND extract(day FROM report_date)::int % 2 = 1"), 0);
  assert.deepEqual(h.sql(`SELECT json_build_array(impressions,clicks,spend,conversions,currency,platform) FROM market.ad_reports
    WHERE campaign_id='111' AND report_date='${first.period_end}'`), [100, 7, 12.35, 1.5, "USD", "google_ads"]);
  assert.deepEqual(h.sql(`SELECT json_build_array(clicks,spend) FROM market.ad_reports WHERE campaign_id='222' ORDER BY report_date DESC LIMIT 1`), [0, 0.5]);
  assert.equal(r.logs.length, 1); assert.deepEqual(secretsIn(JSON.stringify([r.body, r.logs])), []);

  // Two reruns of the last 30 days with changed numbers: same row count, values updated.
  for (const impressions of ["150", "175"]) {
    start(30);
    const again = await deliver(edge([], { impressions }).handler, env);
    assert.equal(again.status, 200);
    const rerun = lastRun();
    assert.equal(rerun.rows_written, expectedRows(rerun.period_start, rerun.period_end));
    assert.equal(adRows(), expected);
    assert.equal(h.sql("SELECT count(*) FROM (SELECT 1 FROM market.ad_reports GROUP BY business_id,platform,campaign_id,report_date HAVING count(*)>1) d"), 0);
    assert.equal(h.sql(`SELECT impressions FROM market.ad_reports WHERE campaign_id='111' AND report_date='${rerun.period_end}'`), Number(impressions));
  }
  // Days older than the 30-day window keep the first run's values.
  assert.equal(h.sql(`SELECT impressions FROM market.ad_reports WHERE campaign_id='111' AND report_date='${first.period_start}'`), 100);
});

test("empty report writes nothing and is not recorded as zeros", async () => {
  const before = h.sql("SELECT to_jsonb(md5(json_agg(a ORDER BY id)::text)) FROM market.ad_reports a");
  start(30);
  const r = await deliver(edge([], { empty: true }).handler, edge([]).env);
  assert.equal(r.status, 200);
  assert.deepEqual([lastRun().status, lastRun().safe_code, lastRun().rows_written], ["succeeded", "no_data", 0]);
  assert.equal(h.sql("SELECT to_jsonb(md5(json_agg(a ORDER BY id)::text)) FROM market.ad_reports a"), before);
});

test("currency or time zone mismatch writes nothing and returns the error code", async () => {
  const before = adRows();
  for (const [opts, code] of [[{ currency: "TRY" }, "ads_currency_mismatch"], [{ timeZone: "Europe/Istanbul" }, "ads_timezone_mismatch"]]) {
    start(30);
    const log = [], { handler, env } = edge(log, opts);
    const r = await deliver(handler, env);
    assert.equal(r.status, 503); assert.equal(r.body.code, code);
    assert.equal(log.filter(l => l.url.includes("googleads")).length, 1); // report query never sent
    const row = lastRun();
    assert.deepEqual([row.status, row.safe_code, row.rows_written, row.alert_status], ["failed", code, 0, "alert_not_configured"]);
  }
  assert.equal(adRows(), before);
});

test("call cap: the run stops at max_calls, fails with call_cap_reached and writes nothing", async () => {
  const before = adRows();
  start(30, false, 2);
  const log = [], { handler, env } = edge(log);
  const r = await deliver(handler, env);
  assert.equal(log.length, 2); assert.equal(r.body.code, "call_cap_reached");
  assert.deepEqual([lastRun().status, lastRun().calls_used, lastRun().max_calls, lastRun().rows_written], ["failed", 2, 2, 0]);
  assert.equal(adRows(), before);
});

test("OAuth rejection: alert email once per code per New York day; missing key is recorded, run still ends", async () => {
  // No alert key: the alert is skipped and recorded.
  start(30);
  const noKey = await deliver(edge([], { tokenError: "invalid_client" }).handler, edge([]).env);
  assert.equal(noKey.body.code, "oauth_invalid_client");
  assert.deepEqual([lastRun().status, lastRun().alert_status], ["failed", "alert_not_configured"]);
  // With the key: first invalid_grant sends one email.
  start(30);
  const log = [], { handler, env } = edge(log, { tokenError: "invalid_grant" }, { RESEND_ALERTS_API_KEY: RESEND_KEY });
  const first = await deliver(handler, env);
  assert.equal(first.body.code, "oauth_invalid_grant"); assert.equal(first.body.alert, "sent");
  const mails = log.filter(l => l.url === "https://api.resend.com/emails");
  assert.equal(mails.length, 1);
  const mail = JSON.parse(mails[0].body);
  assert.deepEqual(mail.to, [ALERT_TO]); assert.equal(mail.subject, ALERT_SUBJECT);
  assert.match(mail.from, /@mail\.nazarrestaurantandbakery\.com>$/);
  assert.match(mail.text, /Hata kodu: oauth_invalid_grant/); assert.match(mail.text, /Tarih \(New York\): \d{4}-\d{2}-\d{2}/);
  assert.match(mail.text, /GOOGLE_ADS_REFRESH_TOKEN/);
  assert.equal(mails[0].headers.Authorization, "Bearer " + RESEND_KEY);
  assert.equal(mails[0].headers["Idempotency-Key"], "market-ads-alert-" + lastRun().id);
  assert.deepEqual(secretsIn(mail.text + JSON.stringify([first.body, first.logs])), []);
  assert.equal(lastRun().alert_status, "sent");
  // Same code again the same day: no email.
  start(30);
  const second = await deliver(edge(log, { tokenError: "invalid_grant" }, { RESEND_ALERTS_API_KEY: RESEND_KEY }).handler, env);
  assert.equal(second.body.code, "oauth_invalid_grant"); assert.equal(second.body.alert, "already_sent_today");
  assert.equal(log.filter(l => l.url === "https://api.resend.com/emails").length, 1);
  assert.equal(lastRun().alert_status, "already_sent_today");
  assert.equal(h.sql("SELECT count(*) FROM market.ads_alerts WHERE safe_code='oauth_invalid_grant'"), 1);
  // A different failure the same day gets its own email.
  start(30, false, 1);
  await deliver(edge(log, {}, { RESEND_ALERTS_API_KEY: RESEND_KEY }).handler, env);
  assert.equal(log.filter(l => l.url === "https://api.resend.com/emails").length, 1, "call_cap_reached already alerted today (no key then)");
  start(30);
  await deliver(edge(log, { tokenError: "unauthorized_client" }, { RESEND_ALERTS_API_KEY: RESEND_KEY }).handler, env);
  assert.equal(log.filter(l => l.url === "https://api.resend.com/emails").length, 2);
  // A succeeded run never alerts.
  start(30);
  const ok = await deliver(edge(log, {}, { RESEND_ALERTS_API_KEY: RESEND_KEY }).handler, env);
  assert.equal(ok.status, 200); assert.equal(ok.body.alert, null);
  assert.equal(log.filter(l => l.url === "https://api.resend.com/emails").length, 2);
  // The alert status RPC is service_role only and only for a pending alert.
  const run = lastRun();
  assert.throws(() => h.sql(`SELECT public.market_ads_alert_v1('${NAZAR}','${run.id}','${run.claim_token}','sent')`, { role: "authenticated" }), /permission denied/);
  assert.equal(h.sql(`SELECT public.market_ads_alert_v1('${NAZAR}','${run.id}','${run.claim_token}','sent')`, { service: true }), false);
});

test("a stuck run expires: the next start closes it as failed / expired and its claim is refused", async () => {
  start(30);
  const stuck = lastCall();
  h.sql(`UPDATE market.ads_runs SET created_at = now() - interval '16 minutes' WHERE id='${stuck.body.run_id}'`);
  start(30, true);
  assert.deepEqual(h.sql(`SELECT json_build_array(status,safe_code,finished_at IS NOT NULL) FROM market.ads_runs WHERE id='${stuck.body.run_id}'`),
    ["failed", "expired", true]);
  assert.equal((await deliver(edge([]).handler, edge([]).env, stuck)).status, 409);
  // A claimed run that never finishes also expires, and its import is closed as failed.
  const dry = lastCall();
  const claim = h.sql(`SELECT public.market_ads_claim_v1('${NAZAR}','${dry.body.run_id}','${dry.body.nonce}')`, { service: true });
  assert.ok(claim.claim_token);
  h.sql(`UPDATE market.ads_runs SET created_at = now() - interval '20 minutes' WHERE id='${dry.body.run_id}'`);
  assert.equal(h.sql(`SELECT market.ads_expire_v1('${NAZAR}')`), 1);
  assert.deepEqual(h.sql(`SELECT json_build_array(r.status,r.safe_code,i.status) FROM market.ads_runs r JOIN market.imports i ON i.id=r.import_id WHERE r.id='${dry.body.run_id}'`),
    ["failed", "expired", "failed"]);
  assert.throws(() => h.sql(`SELECT public.market_ads_finish_v1('${NAZAR}','${dry.body.run_id}','${claim.claim_token}','succeeded','dry_run',0,'[]'::jsonb)`, { service: true }),
    /MARKET_ADS_RUN_NOT_CLAIMED/);
  assert.equal(h.sql("SELECT count(*) FROM market.ads_runs WHERE status IN ('queued','running')"), 0);
});

test("cron tick: only 08:30-08:59 New York, once per day, 30 days, honours daily_enabled", () => {
  const at = (time) => `((now() AT TIME ZONE 'America/New_York')::date + time '${time}') AT TIME ZONE 'America/New_York'`;
  const tick = (time) => h.sql(`SELECT market.ads_cron_tick_v1(${at(time)})`);
  assert.equal(tick("07:00"), 0); assert.equal(tick("08:29"), 0); assert.equal(tick("09:30"), 0);
  assert.equal(h.sql("SELECT count(*) FROM market.ads_runs WHERE trigger='cron'"), 0);
  assert.equal(tick("08:30"), 1);
  assert.deepEqual([lastRun().trigger, lastRun().days, lastRun().dry_run, lastRun().max_calls], ["cron", 30, false, 10]);
  assert.equal(lastCall().url, "https://" + "a".repeat(20) + ".supabase.co/functions/v1/market-ads");
  reset();
  assert.equal(tick("08:45"), 0); // already ran today
  h.sql("DELETE FROM market.ads_runs WHERE trigger='cron'");
  h.sql(`UPDATE market.ads_settings SET daily_enabled=false`);
  assert.equal(tick("08:30"), 0);
  h.sql(`UPDATE market.ads_settings SET daily_enabled=true`);
  assert.throws(() => h.sql(`SELECT market.ads_cron_tick_v1()`, { service: true }), /permission denied/);
});

test("finish refuses rows outside the period, duplicates, rows on failure and unclaimed runs", () => {
  start(30);
  const call = lastCall();
  const claim = h.sql(`SELECT public.market_ads_claim_v1('${NAZAR}','${call.body.run_id}','${call.body.nonce}')`, { service: true });
  assert.equal(h.sql(`SELECT public.market_ads_claim_v1('${NAZAR}','${call.body.run_id}','${call.body.nonce}')`, { service: true }), null);
  const row = (date, id = "111") => ({ campaign_id: id, campaign_name: "X", report_date: date, impressions: 1, clicks: 0, spend: 0, conversions: 0 });
  const finish = (token, status, rows) => `SELECT public.market_ads_finish_v1('${NAZAR}','${call.body.run_id}','${token}','${status}','completed',3,${L(JSON.stringify(rows))}::jsonb)`;
  const today = h.sql("SELECT to_jsonb((now() AT TIME ZONE 'America/New_York')::date)");
  assert.throws(() => h.sql(finish(claim.claim_token, "succeeded", [row(today)]), { service: true }), /MARKET_ADS_RESULT_INVALID/);
  assert.throws(() => h.sql(finish(claim.claim_token, "succeeded", [row(claim.period_end), row(claim.period_end)]), { service: true }), /MARKET_ADS_RESULT_INVALID/);
  assert.throws(() => h.sql(finish(claim.claim_token, "failed", [row(claim.period_end)]), { service: true }), /MARKET_ADS_RESULT_INVALID/);
  assert.throws(() => h.sql(finish(randomUUID(), "succeeded", []), { service: true }), /MARKET_ADS_RUN_NOT_CLAIMED/);
  assert.throws(() => h.sql(finish(claim.claim_token, "succeeded", []), { role: "authenticated" }), /permission denied/);
  h.sql(finish(claim.claim_token, "succeeded", [row(claim.period_end, "333")]), { service: true });
  h.sql("DELETE FROM market.ad_reports WHERE campaign_id='333'");
});

test("rollback refuses while Ads data exists, removes only its cron job, then restores G12 exactly", async () => {
  assert.match(h.raw(await lf(ROLLBACK)).stderr, /G13_ROLLBACK_DATA_PRESENT/);
  h.sql(`DELETE FROM market.ad_reports; DELETE FROM market.ads_alerts; DELETE FROM market.ads_runs; DELETE FROM market.imports WHERE kind='ads_google';`);
  const r = h.raw(await lf(ROLLBACK)); assert.equal(r.status, 0, r.stderr);
  assert.equal(h.sql("SELECT to_regclass('market.ads_runs') IS NULL AND to_regclass('market.ads_settings') IS NULL AND to_regclass('market.ads_alerts') IS NULL"), true);
  assert.equal(h.sql("SELECT count(*) FROM pg_proc WHERE proname LIKE 'market\\_ads\\_%' OR (pronamespace='market'::regnamespace AND proname LIKE 'ads\\_%')"), 0);
  assert.equal(h.sql("SELECT count(*) FROM cron.job WHERE jobname='market-ads-daily'"), 0);
  assert.deepEqual(otherJobs(), OTHER_JOBS);
  assert.doesNotMatch(h.sql("SELECT to_jsonb(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conname='imports_kind_check'"), /ads_google/);
  assert.match(h.sql("SELECT to_jsonb(pg_get_constraintdef(oid)) FROM pg_constraint WHERE conname='imports_kind_check'"), /places_restaurant/);
  assert.equal(h.sql("SELECT to_regclass('market.places_runs') IS NOT NULL"), true);
  assert.match(h.raw(await lf(ROLLBACK)).stderr, /G13_NOT_APPLIED/);
  const again = h.raw(await lf(MIGRATION)); assert.equal(again.status, 0, again.stderr);
});
