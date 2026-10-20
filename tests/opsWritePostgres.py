"""Fresh loopback-only PostgreSQL, synthetic identities only. Leaves logs for review."""
import concurrent.futures,json,os,pathlib,shutil,socket,subprocess,sys,tempfile
root=pathlib.Path(__file__).resolve().parents[1]
binary=pathlib.Path(shutil.which('psql')).parent
folder=pathlib.Path(tempfile.mkdtemp(prefix='k15-local-'))
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
started=False
try:
 run('initdb','-D',folder/'data','-U','postgres','-A','trust','--encoding=UTF8','--locale=C')
 run('pg_ctl','-D',folder/'data','-l',folder/'server.log','-o',f'-h 127.0.0.1 -p {port}','-w','start');started=True
 sql("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA auth;CREATE SCHEMA core;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE TABLE core.businesses(id uuid PRIMARY KEY);CREATE TABLE core.crm_staff(auth_user_id uuid PRIMARY KEY,active boolean);CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role;")
 run('psql','-X','-h','127.0.0.1','-p',port,'-U','postgres','-v','ON_ERROR_STOP=1','-f',root/'supabase/migrations/20261021000500_ops_write_gate.sql')
 run('psql','-X','-h','127.0.0.1','-p',port,'-U','postgres','-v','ON_ERROR_STOP=1','-f',root/'tests/ops-write-gate.sql')
 b='11111111-1111-4111-8111-111111111111';u='33333333-3333-4333-8333-333333333333';t='66666666-6666-4666-8666-666666666666'
 setup=f"SELECT set_config('request.jwt.claim.sub','{u}',false);SELECT (public.ops_write_preview('{b}','{t}',repeat('a',64),gen_random_uuid())->>'id');"
 action=sql(setup).splitlines()[-1]
 sql(f"SELECT set_config('request.jwt.claim.sub','{u}',false);SELECT public.ops_write_approve('{b}','{action}','{t}',repeat('a',64));")
 query=f"SET ROLE service_role;SELECT public.ops_write_claim('{b}','{action}','{u}','{t}',repeat('a',64)) IS NOT NULL;"
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(lambda _:sql(query).splitlines()[-1],range(2)))
 assert sorted(results)==['f','t'],results
 receipt={'local_only':True,'postgres':run('psql','--version'),'sql_assertions_passed':True,'two_tenant_isolation':True,'concurrent_claims':2,'successful_claims':1,'provider_calls':0,'hosted_changes':False,'logs':str(folder)}
 (folder/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8');print(json.dumps(receipt))
finally:
 if started:run('pg_ctl','-D',folder/'data','-m','fast','-w','stop')
