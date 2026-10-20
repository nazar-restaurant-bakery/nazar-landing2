"""Fresh loopback-only PostgreSQL, synthetic identities only. Leaves logs for review."""
import concurrent.futures,json,os,pathlib,shutil,socket,subprocess,sys,tempfile,uuid,hashlib
root=pathlib.Path(__file__).resolve().parents[1]
binary=pathlib.Path(shutil.which('psql')).parent
folder=pathlib.Path(tempfile.mkdtemp(prefix='daily-scheduler-local-'))
sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
flags=getattr(subprocess,'CREATE_NO_WINDOW',0)
def run(name,*args):
 command=[str(binary/(name+'.exe' if os.name=='nt' else name)),*map(str,args)]
 if name=='pg_ctl':
  with (folder/'pg_ctl.log').open('a',encoding='utf-8') as log:
   r=subprocess.run(command,stdout=log,stderr=log,text=True,creationflags=flags,timeout=45)
  if r.returncode:raise RuntimeError((folder/'pg_ctl.log').read_text(encoding='utf-8'))
  return ''
 r=subprocess.run(command,capture_output=True,text=True,creationflags=flags,timeout=45)
 if r.returncode: raise RuntimeError(r.stdout+r.stderr)
 return r.stdout.strip()
def sql(text):return run('psql','-X','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At','-c',text)
manifest={'businesses':{k:str(uuid.uuid4()) for k in ['a','b']},'users':{k:str(uuid.uuid4()) for k in ['platformOnly','platformMember','ownerA','managerA','staffA','inactiveA','staffB','legacyOnly','inactivePlatform']}}
(folder/'fixture-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
variables=[]
for group,values in manifest.items():
 for key,value in values.items():variables+=['-v',('business_' if group=='businesses' else 'user_')+key+'='+value]
started=False
try:
 run('initdb','-D',folder/'data','-U','postgres','-A','trust','--encoding=UTF8','--locale=C')
 run('pg_ctl','-D',folder/'data','-l',folder/'server.log','-o',f'-h 127.0.0.1 -p {port}','-w','start');started=True
 sql("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA core;CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE core.businesses(id uuid PRIMARY KEY);CREATE TABLE core.ops_api_budget(day_ny date PRIMARY KEY,requests integer);INSERT INTO core.ops_api_budget VALUES((clock_timestamp() AT TIME ZONE 'America/New_York')::date,3);CREATE TABLE core.ops_metrics(business_id uuid,source text,metric text,value_num numeric,value_text text,period_start date,period_end date,collected_at timestamptz,collector text,is_test boolean);CREATE TABLE core.ops_connections(business_id uuid,source text,status text,last_ok_at timestamptz,last_error text,note text,capabilities jsonb,PRIMARY KEY(business_id,source));CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.role',true),'') $$;GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role;CREATE FUNCTION public.ops_reserve_external_request() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;GRANT EXECUTE ON FUNCTION public.ops_reserve_external_request() TO service_role;CREATE FUNCTION public.ops_internal_snapshot_v() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;CREATE SCHEMA vault;CREATE TABLE vault.decrypted_secrets(name text PRIMARY KEY,decrypted_secret text);INSERT INTO vault.decrypted_secrets VALUES('SCHEDULER_SIGNING_SECRET','synthetic-machine-key-not-used-anywhere-live-123456'),('SCHEDULER_EDGE_URL','https://ssssssssssssssssssss.supabase.co/functions/v1/daily-ops-run');CREATE SCHEMA net;CREATE TABLE net.test_outbox(id bigint GENERATED ALWAYS AS IDENTITY,url text,headers jsonb,body jsonb);CREATE FUNCTION net.http_post(url text,body jsonb DEFAULT '{}'::jsonb,params jsonb DEFAULT '{}'::jsonb,headers jsonb DEFAULT '{}'::jsonb,timeout_milliseconds integer DEFAULT 1000) RETURNS bigint LANGUAGE sql AS $$ INSERT INTO net.test_outbox(url,headers,body) VALUES(url,headers,body) RETURNING id $$;")
 run('psql','-X','-h','127.0.0.1','-p',port,'-U','postgres','-v','ON_ERROR_STOP=1','-f',root/'tests/fixtures/staff-contract-v1.sql')
 run('psql','-X','-h','127.0.0.1','-p',port,'-U','postgres','-v','ON_ERROR_STOP=1','-f',root/'supabase/migrations/20261021000600_daily_scheduler.sql')
 run('psql','-X','-h','127.0.0.1','-p',port,'-U','postgres','-v','ON_ERROR_STOP=1',*variables,'-f',root/'tests/daily-scheduler.sql')
 b=manifest['businesses']['a']
 # Two actual concurrent tick calls must enqueue only one HTTP job per tenant/day.
 tick="SELECT core.daily_scheduler_tick('2028-03-12T11:00:00Z');"
 sql("UPDATE core.daily_scheduler_settings SET enabled=true;")
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(lambda _:int(sql(tick).splitlines()[-1]),range(2)))
 assert sum(results)==2,results
 raw=sql("SELECT jsonb_build_object('id',id,'nonce',nonce)::text FROM core.daily_scheduler_runs WHERE business_id='"+b+"' AND local_date='2028-03-12';")
 record=json.loads(raw.splitlines()[-1])
 sql("UPDATE core.daily_scheduler_runs SET created_at=clock_timestamp() WHERE business_id='"+b+"' AND id='"+record['id']+"';")
 start=f"SET ROLE service_role;SELECT public.daily_scheduler_start('{b}','{record['id']}','{record['nonce']}') IS NOT NULL;"
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:starts=list(pool.map(lambda _:sql(start).splitlines()[-1],range(2)))
 assert sorted(starts)==['f','t'],starts
 # Independent tenant quotas at the boundary remain atomic under concurrency.
 sql("UPDATE core.daily_external_budget SET requests=29 WHERE business_id='"+b+"';")
 budget=f"SET ROLE service_role;SELECT public.daily_reserve_external_request('{b}');"
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:quota=list(pool.map(lambda _:sql(budget).splitlines()[-1],range(2)))
 assert sorted(quota)==['f','t'],quota
 receipt={'local_only':True,'postgres':run('psql','--version'),'sql_assertions_passed':True,'two_tenant_isolation':True,'concurrent_tick_calls':2,'http_jobs_for_two_tenants':sum(results),'concurrent_run_starts':2,'successful_run_starts':1,'concurrent_budget_reservations':2,'successful_reservations_at_29':1,'dst_march_and_november':True,'provider_calls':0,'hosted_changes':False,'logs':str(folder),'fixture':manifest,'shared_contract_fixture_sha256':hashlib.sha256((root/'tests/fixtures/staff-contract-v1.sql').read_bytes()).hexdigest(),'integration_limit':'pg_net and Vault use local synthetic contract fixtures; no live dispatch, cron extension or HMAC key configured' }
 (folder/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8');print(json.dumps(receipt))
finally:
 if started:run('pg_ctl','-D',folder/'data','-m','fast','-w','stop')
