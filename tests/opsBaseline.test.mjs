import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const { PGlite } = await import(process.env.PGLITE_MODULE);
const read = name => readFile(new URL(name, import.meta.url), 'utf8');

test('Ops installs after actual baseline/K3/K4/K5; count and private boundaries remain valid', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE SCHEMA extensions;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;
      GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
      CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid(),bucket_id text,name text); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;`);
    const baseline = await read('../supabase/baselines/20261019_application_schema.sql');
    await db.exec(baseline.replace(/^\\(?:un)?restrict\s+\S+\r?$/gm, ''));
    for (const file of ['20261019000100_test_record_markers.sql','20261019000200_suppression_consent_offers.sql','20261019000300_klaviyo_profile_sync.sql']) await db.exec(await read('../supabase/migrations/'+file));
    const business = baseline.match(/CONSTRAINT businesses_id_check CHECK \(\(id = '([0-9a-f-]+)'::uuid\)\)/)[1];
    await db.query("INSERT INTO core.businesses(id,name,intake_enabled) VALUES($1,'Synthetic Ops baseline',true)",[business]);
    const ref = 's'.repeat(20);
    await db.query('INSERT INTO core.installation(version,declared_project_ref) VALUES($1,$2)',['synthetic',ref]);
    const staff = randomUUID(), guest = randomUUID();
    await db.query('INSERT INTO auth.users(id) VALUES($1),($2)',[staff,guest]);
    await db.query("INSERT INTO core.crm_staff(auth_user_id,role) VALUES($1,'staff')",[staff]);
    const sql = await read('../supabase/migrations/20261020000100_ops_panel.sql');
    await assert.rejects(()=>db.exec(sql), /expected Nazar installation/);
    await db.exec('ROLLBACK');
    await db.query("SELECT set_config('app.ops_project_ref',$1,false)",[ref]);
    await db.exec(sql);
    await db.exec(await read('../tools/test-env/k1c-verify.sql'));
    const result = (await db.query('SELECT public.ops_internal_snapshot_v() AS data')).rows[0].data;
    assert.equal(result.metrics.find(m=>m.metric==='form_submissions_7d').value_num,0);
    assert.equal((await db.query("SELECT has_schema_privilege('authenticated','core','USAGE') AS allowed")).rows[0].allowed,false);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[guest]);
    await db.exec('SET ROLE authenticated');
    await assert.rejects(()=>db.query('SELECT public.ops_dashboard_v()'), /Access denied/);
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[staff]);
    await db.exec('SET ROLE authenticated');
    assert.equal((await db.query('SELECT public.ops_dashboard_v() AS data')).rows[0].data.business_id,business);
  } finally { await db.close(); }
});
