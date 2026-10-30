// Daily Clover activation on an owned local PostgreSQL 18.6 cluster: full reviewed
// baseline + actual Ops/K7/K8/K12 migrations. Only Supabase platform surfaces
// (Vault, pg_net) are local facades; no hosted connection, no real secret.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fixture, repo } from "./fixtures/customerTestClassificationNative.mjs";
import { verifyMachine } from "../functions/_lib/dailySchedulerAuth.ts";

const MIGRATION = "supabase/migrations/20261030000300_daily_clover_activation.sql";
const ROLLBACK = "supabase/rollbacks/20261030000300_daily_clover_activation_down.sql";
const NAZAR = "a358eba4-b197-4309-805b-46f43a718454";
const URL_ = "https://www.nazarrestaurantandbakery.com/api/internal/daily-clover-pull";
const SECRET = "synthetic-local-scheduler-secret-0123456789abcdef";
const EDGE = "https://" + "a".repeat(20) + ".supabase.co/functions/v1/daily-ops-run";
const lf = async (path) => (await readFile(join(repo, path))).toString("utf8").replaceAll("\r\n", "\n");
const h = await fixture({ currentCouponSchema: true });
test.after(() => h.stop());
assert.equal(h.business, NAZAR);
h.sql(await lf("supabase/migrations/20261021000700_daily_scheduler.sql"));
h.sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto;
 DO $$ BEGIN IF to_regprocedure('extensions.hmac(text,text,text)') IS NULL THEN
  EXECUTE format('CREATE FUNCTION extensions.hmac(text,text,text) RETURNS bytea LANGUAGE sql AS %L',
   'SELECT '||(SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto')||'.hmac($1,$2,$3)');
 END IF; END $$;
 CREATE SCHEMA vault; CREATE TABLE vault.decrypted_secrets(name text PRIMARY KEY,decrypted_secret text);
 CREATE SCHEMA net; CREATE TABLE net.calls(id bigserial PRIMARY KEY,url text,headers jsonb,body jsonb,timeout_ms integer);
 CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE sql
  AS $$INSERT INTO net.calls(url,headers,body,timeout_ms) VALUES(url,headers,body,timeout_milliseconds) RETURNING id$$;`);
const runToday = () => h.sql(`SELECT core.daily_scheduler_run_today_v1('${NAZAR}')`);
const lastCall = () => h.sql("SELECT to_jsonb(c) FROM net.calls c ORDER BY id DESC LIMIT 1");
const nyToday = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/New_York" }).format(new Date());
const constraints = () => h.sql(`SELECT json_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint
  WHERE conrelid='core.daily_scheduler_runs'::regclass AND contype='c'`);
const original = constraints();

test("migration adds Nazar's disabled settings row and keeps existing functions", async () => {
  const defs = () => h.sql(`SELECT json_agg(md5(pg_get_functiondef(p.oid))||coalesce(p.proacl::text,'') ORDER BY p.oid) FROM pg_proc p
    WHERE p.oid IN ('core.daily_scheduler_tick(timestamptz)'::regprocedure,'public.daily_scheduler_start(uuid,uuid,uuid)'::regprocedure,
    'public.daily_clover_claim(uuid,uuid,uuid)'::regprocedure,'public.clover_order_ingest_v1(uuid,text,jsonb)'::regprocedure)`);
  const before = defs();
  const r = h.raw(await lf(MIGRATION)); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(defs(), before);
  assert.deepEqual(h.sql("SELECT json_agg(json_build_object('b',business_id,'e',enabled,'u',clover_url)) FROM core.daily_scheduler_settings"),
    [{ b: NAZAR, e: false, u: URL_ }]);
  assert.match(h.raw(await lf(MIGRATION)).stderr, /DAILY_CLOVER_ALREADY_INSTALLED/);
  const bytes = await readFile(join(repo, MIGRATION));
  assert.equal(bytes.includes(13), false);
  console.log(JSON.stringify({ migration: MIGRATION, sha256: createHash("sha256").update(bytes).digest("hex"),
    rollbackSha256: createHash("sha256").update(await readFile(join(repo, ROLLBACK))).digest("hex") }));
});

test("one-time run refuses while the tenant is disabled or Vault is incomplete", () => {
  assert.throws(runToday, /SCHEDULER_TENANT_NOT_ENABLED/);
  h.sql(`UPDATE core.daily_scheduler_settings SET enabled=true WHERE business_id='${NAZAR}'`);
  assert.throws(runToday, /query returned no rows|no rows/);
  h.sql(`INSERT INTO vault.decrypted_secrets VALUES('SCHEDULER_SIGNING_SECRET','${SECRET}'),('SCHEDULER_EDGE_URL','https://evil.example/functions/v1/daily-ops-run')`);
  assert.throws(runToday, /SCHEDULER_EDGE_URL_INVALID/);
  h.sql(`UPDATE vault.decrypted_secrets SET decrypted_secret='${EDGE}' WHERE name='SCHEDULER_EDGE_URL'`);
  assert.equal(h.sql("SELECT count(*) FROM core.daily_scheduler_runs"), 0);
  assert.equal(h.sql("SELECT count(*) FROM net.calls"), 0);
});

test("one-time run dispatches today's window through the signed scheduler path once", async () => {
  const run = runToday();
  assert.equal(run.job_type, "manual_today"); assert.equal(run.target_date, nyToday()); assert.equal(run.local_date, nyToday());
  const call = lastCall();
  assert.equal(call.url, EDGE); assert.equal(call.timeout_ms, 10000); assert.equal(run.request_id, call.id);
  assert.deepEqual(Object.keys(call.body).sort(), ["business_id", "issued_at", "nonce", "run_id"]);
  // The Edge function's own verifier accepts the database signature.
  assert.equal(await verifyMachine("daily.dispatch.v1", call.body, call.headers["X-Scheduler-Signature"], SECRET), true);
  assert.throws(runToday, /MANUAL_RUN_ALREADY_ACTIVE_OR_DONE_TODAY/);
  // Edge's start RPC hands the Cloudflare pull exactly today's New York window.
  const started = h.sql(`SELECT public.daily_scheduler_start('${NAZAR}','${call.body.run_id}','${call.body.nonce}')`, { service: true });
  assert.equal(started.clover_url, URL_);
  const midnight = (day) => h.sql(`SELECT (extract(epoch FROM ('${day}'::date::timestamp AT TIME ZONE 'America/New_York'))*1000)::bigint`);
  assert.equal(started.start_ms, midnight(nyToday()));
  assert.equal(started.end_ms - started.start_ms <= 25 * 3600000, true);
  assert.equal(h.sql(`SELECT public.daily_clover_claim('${NAZAR}','${started.id}','${started.claim_token}')`, { service: true }), true);
  assert.equal(h.sql(`SELECT public.daily_clover_finish('${NAZAR}','${started.id}','${started.claim_token}','succeeded')`, { service: true }), true);
  assert.equal(h.sql(`SELECT public.daily_scheduler_finish('${NAZAR}','${started.id}','${started.claim_token}','succeeded','collected')`, { service: true }).status, "succeeded");
  assert.throws(runToday, /MANUAL_RUN_ALREADY_ACTIVE_OR_DONE_TODAY/);
});

test("a failed one-time run may be dispatched again with a fresh nonce", () => {
  const first = h.sql("SELECT to_jsonb(r) FROM core.daily_scheduler_runs r WHERE job_type='manual_today'");
  h.sql("UPDATE core.daily_scheduler_runs SET status='failed',safe_code='clover_failed' WHERE job_type='manual_today'");
  const again = runToday();
  assert.equal(again.run_id, first.id);
  assert.notEqual(lastCall().body.nonce, first.nonce);
  assert.equal(h.sql("SELECT to_jsonb(status) FROM core.daily_scheduler_runs WHERE job_type='manual_today'"), "queued");
});

test("the 07:00 daily_collect schedule is unaffected and coexists with today's manual run", () => {
  const seven = h.sql(`SELECT to_jsonb((('${nyToday()}'::date + time '07:00') AT TIME ZONE 'America/New_York'))`);
  assert.equal(h.sql(`SELECT core.daily_scheduler_tick('${seven}'::timestamptz)`), 1);
  const rows = h.sql(`SELECT json_agg(json_build_object('t',job_type,'target',target_date) ORDER BY job_type) FROM core.daily_scheduler_runs WHERE local_date='${nyToday()}'`);
  const yesterday = h.sql(`SELECT to_jsonb('${nyToday()}'::date-1)`);
  assert.deepEqual(rows, [{ t: "daily_collect", target: yesterday }, { t: "manual_today", target: nyToday() }]);
  assert.throws(() => h.sql(`INSERT INTO core.daily_scheduler_runs(business_id,local_date,job_type,target_date,status) VALUES('${NAZAR}','2026-01-02','daily_collect','2026-01-02','queued')`), /check/i);
});

test("only the database owner may dispatch; status SQL is read-only", async () => {
  for (const role of ["anon", "authenticated", "service_role"])
    assert.notEqual(h.raw(`SELECT core.daily_scheduler_run_today_v1('${NAZAR}')`, { role }).status, 0, role);
  const status = h.raw("BEGIN READ ONLY;\n" + await lf("tools/daily-clover/01_status_readonly.sql") + "\nCOMMIT;");
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /"imza_anahtari_var": true/);
  assert.match(status.stdout, /"cron_isi": null/);
  assert.ok(!status.stdout.includes(SECRET));
  // With the platform tables present the same file still runs read-only.
  h.sql(`CREATE SCHEMA cron; CREATE TABLE cron.job(jobname text,schedule text,command text,active boolean);
    INSERT INTO cron.job VALUES('platform-daily-ops','* * * * *','SELECT core.daily_scheduler_tick();',false);
    CREATE TABLE net._http_response(id bigint,status_code integer,error_msg text,created timestamptz);`);
  const withCron = h.raw("BEGIN READ ONLY;\n" + await lf("tools/daily-clover/01_status_readonly.sql") + "\nCOMMIT;");
  assert.equal(withCron.status, 0, withCron.stderr);
  assert.match(withCron.stdout, /platform-daily-ops/);
});

test("rollback refuses while enabled or running, then restores constraints exactly", async () => {
  assert.match(h.raw(await lf(ROLLBACK)).stderr, /DAILY_CLOVER_MANUAL_RUN_ACTIVE/);
  h.sql("UPDATE core.daily_scheduler_runs SET status='failed' WHERE status IN ('queued','running')");
  assert.match(h.raw(await lf(ROLLBACK)).stderr, /DAILY_CLOVER_DISABLE_SCHEDULER_FIRST/);
  h.sql(`UPDATE core.daily_scheduler_settings SET enabled=false WHERE business_id='${NAZAR}'`);
  const r = h.raw(await lf(ROLLBACK)); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(constraints().sort(), original.sort());
  assert.equal(h.sql("SELECT count(*) FROM core.daily_scheduler_runs WHERE job_type<>'daily_collect'"), 0);
  assert.equal(h.sql("SELECT count(*) FROM core.daily_scheduler_settings"), 0);
  const again = h.raw(await lf(MIGRATION)); assert.equal(again.status, 0, again.stderr);
});
