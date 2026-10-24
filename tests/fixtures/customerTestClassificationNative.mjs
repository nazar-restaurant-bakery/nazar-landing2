// Owned local PG18.6 only. Loads the full reviewed baseline and actual K3/K4/K5
// migrations; never connects to hosted DBs or reads inherited database settings.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,realpath,rm} from 'node:fs/promises';
import {randomInt,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {dirname,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export const migrationPath='supabase/migrations/20261023000100_customer_test_classification.sql';
export const literal=value=>value===null?'NULL':"'"+String(value).replaceAll("'","''")+"'";
export async function fixture({currentCouponSchema=false}={}){
 const bin=await realpath(process.env.CUSTOMER_MARKER_PG_BIN||join(process.env.USERPROFILE,'scoop/apps/postgresql/18.6-4/bin'));
 const exe=name=>join(bin,name+(process.platform==='win32'?'.exe':''));
 const run=await mkdtemp(join(repo,'.customer-marker-native-'));
 const data=join(run,'data'),port=randomInt(56000,62000),database='customer_marker_'+randomUUID().replaceAll('-','').slice(0,12);
 const clean=Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','LOCALAPPDATA','APPDATA','USERPROFILE','COMSPEC','PATHEXT'].includes(k.toUpperCase())));
 const options={windowsHide:true,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,
  env:{...clean,PGCLIENTENCODING:'UTF8',PGCONNECT_TIMEOUT:'2',PGPASSFILE:join(run,'nonexistent-password-file'),
   PGOPTIONS:'-c statement_timeout=20000 -c lock_timeout=5000'}};
 function command(name,args,input){
  const result=spawnSync(exe(name),args,{...options,input,...(name==='pg_ctl'?{stdio:['ignore','ignore','ignore']}:{})});
  if(result.status!==0)throw Error(name+': '+(result.stderr||result.stdout||result.error?.message||'failed'));
  return result.stdout||'';
 }
 let started=false;
 const args=['-X','-q','-w','-h','127.0.0.1','-p',String(port),'-U','postgres','-d',database,'-v','ON_ERROR_STOP=1','-At'];
 function raw(text,{service=false,role=null}={}){
  const prefix=service?"SET request.jwt.claim.role='service_role';SET ROLE service_role;":role?`SET ROLE ${role};`:'';
  return spawnSync(exe('psql'),args,{...options,input:prefix+text});
 }
 function sql(text,opt={}){
  const result=raw(text,opt);if(result.status!==0)throw Error(result.stderr||result.error?.message||'local query failed');
  const value=result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  return value===undefined?null:value==='t'?true:value==='f'?false:JSON.parse(value);
 }
 async function stop(){
  if(started){command('pg_ctl',['-D',data,'-m','fast','-w','stop']);started=false;}
  const target=await realpath(run),child=relative(await realpath(repo),target);
  assert.ok(child.startsWith('.customer-marker-native-')&&!child.includes(sep));
  await rm(target,{recursive:true,force:true});
 }
 try{
  assert.match(command('psql',['--version']),/18\.6\b/);
  command('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','--encoding=UTF8']);
  command('pg_ctl',['-D',data,'-l',join(run,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1 -c max_connections=8`,'-w','start']);started=true;
  command('createdb',['-h','127.0.0.1','-p',String(port),'-U','postgres','-w',database]);
  const identity=sql("SELECT jsonb_build_object('host',host(inet_server_addr()),'port',inet_server_port(),'database',current_database(),'data',current_setting('data_directory'),'version',current_setting('server_version'))");
  assert.equal(identity.host,'127.0.0.1');assert.equal(identity.port,port);assert.equal(identity.database,database);
  assert.equal(resolve(identity.data),resolve(data));assert.match(identity.version,/^18\.6\b/);
  sql(`CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;
   CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE SCHEMA extensions;
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;
   GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;`);
  const baseline=await readFile(join(repo,'supabase/baselines/20261019_application_schema.sql'),'utf8');
  sql(baseline); // Exact full dump, including real submit_signup_once/submit_signup and triggers.
  for(const path of ['20261019000100_test_record_markers.sql','20261019000200_suppression_consent_offers.sql','20261019000300_klaviyo_profile_sync.sql'])
   sql(await readFile(join(repo,'supabase/migrations',path),'utf8'));
  const business=baseline.match(/CONSTRAINT businesses_id_check CHECK \(\(id = '([0-9a-f-]+)'::uuid\)\)/)[1];
  sql(`INSERT INTO core.businesses(id,name,intake_enabled,is_test) VALUES('${business}','Synthetic local marker fixture',true,true)`);
  const applied=[];
  if(currentCouponSchema){
   // Actual full tables/functions, no K9 bootstrap or substitute gate tables.
   // Ops supports an explicit installation setting: use a LOCAL declaration,
   // never a hosted URL/ref as a connection target or a production guard bypass.
   sql("INSERT INTO core.installation(version,declared_project_ref) VALUES('local-native-only','local_native_customer_marker')");
   // Supabase-owned platform surface required by the actual Ops storage policy.
   // Only platform Auth/Storage are facades; every core application object below
   // is created from the full baseline / original migration, never a stub.
   sql(`CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean NOT NULL DEFAULT false,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text REFERENCES storage.buckets(id),name text);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;`);
   for(const path of ['20261020000100_ops_panel.sql','20261020000700_clover_order_core.sql',
    '20261020000800_message_send_gate.sql','20261020000900_clover_optional_scope_status.sql',
    '20261020001000_clover_payment_day_totals.sql','20261021000100_clover_webhook.sql',
    '20261021000200_campaign_engine.sql','20261021000600_campaign_eligibility_check.sql',
    '20261021000800_signup_reward_coupons.sql','20261021000825_coupon_delivery_reconciliation.sql']){
    const bytes=await readFile(join(repo,'supabase/migrations',path));
    const text=bytes.toString('utf8').replaceAll('\r\n','\n');
    sql((path==='20261020000100_ops_panel.sql'?"SET app.ops_project_ref='local_native_customer_marker';\n":'')+text);
    applied.push({path:'supabase/migrations/'+path,canonicalLf:text});
   }
  }
  return{raw,sql,stop,business,literal,identity,applied,apply:async()=>sql(await readFile(join(repo,migrationPath),'utf8'))};
 }catch(error){await stop();throw error;}
}
