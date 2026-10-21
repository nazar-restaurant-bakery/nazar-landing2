"""Fresh owned loopback PG18.6; proposed v1.1 scope; no hosted Auth or email."""
import concurrent.futures,json,os,pathlib,shutil,socket,subprocess,tempfile,uuid,hashlib
root=pathlib.Path(__file__).resolve().parents[1];binary=pathlib.Path(shutil.which('psql')).parent
folder=pathlib.Path(tempfile.mkdtemp(prefix='staff-management-local-'));sock=socket.socket();sock.bind(('127.0.0.1',0));port=str(sock.getsockname()[1]);sock.close()
env={k:v for k,v in os.environ.items() if k.upper() in ['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','COMSPEC','PATHEXT']};env.update(PGCLIENTENCODING='UTF8',PGPASSFILE=str(folder/'not-a-password-file'),PGCONNECT_TIMEOUT='2')
flags=getattr(subprocess,'CREATE_NO_WINDOW',0)
def run(name,*args,check=True):
 command=[str(binary/(name+'.exe' if os.name=='nt' else name)),*map(str,args)]
 if name=='pg_ctl':
  with (folder/'pg_ctl.log').open('a',encoding='utf-8') as log:r=subprocess.run(command,stdout=log,stderr=log,text=True,env=env,creationflags=flags,timeout=60)
  if r.returncode:raise RuntimeError('Local PostgreSQL lifecycle failed')
  return ''
 r=subprocess.run(command,capture_output=True,text=True,env=env,creationflags=flags,timeout=60)
 if check and r.returncode:raise RuntimeError(r.stdout+r.stderr)
 return r
args=['-X','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate','-Atq','-P','null=null']
def raw(command,actor=None,role=None,check=True):
 prefix="SET statement_timeout='15s';SET lock_timeout='10s';"
 if role:prefix+=f"SET request.jwt.claim.role='{role}';SET request.jwt.claim.sub='{actor or ''}';SET ROLE {role};"
 return run('psql',*args,'-c',prefix+command,check=check)
def sql(command,actor=None,role=None):
 output=raw(command,actor,role).stdout.strip().splitlines();return ({'t':True,'f':False,'':None}[output[-1]] if output[-1] in ['t','f',''] else json.loads(output[-1])) if output else None
def call(name,values,actor=None,role='authenticated'):
 def lit(v):return 'NULL' if v is None else 'true' if v is True else 'false' if v is False else "'"+str(v).replace("'","''")+"'"
 return sql('SELECT public.'+name+'('+','.join(lit(v) for v in values)+');',actor,role)
def rejected(command,actor=None,role='authenticated',code='42501'):
 r=raw(command,actor,role,False);assert r.returncode and code in r.stderr,(code,r.stderr)
manifest={'businesses':{k:str(uuid.uuid4()) for k in ['a','b']},'users':{k:str(uuid.uuid4()) for k in ['ownerA','ownerA2','managerA','staffA','inactiveA','staffB','platformOnly','platformMember','inactivePlatform','legacyOnly']}}
a,b=manifest['businesses'].values();u=manifest['users'];started=False;checks=[]
def passed(label):checks.append(label)
try:
 assert '18.6' in run('psql','--version').stdout
 run('initdb','-D',folder/'data','-U','postgres','-A','trust','--encoding=UTF8','--locale=C')
 run('pg_ctl','-D',folder/'data','-l',folder/'server.log','-o',f'-h 127.0.0.1 -p {port}','-w','start');started=True
 raw("CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE SCHEMA core;CREATE SCHEMA auth;CREATE TABLE core.businesses(id uuid PRIMARY KEY);CREATE TABLE auth.users(id uuid PRIMARY KEY,email text UNIQUE,raw_user_meta_data jsonb DEFAULT '{}'::jsonb);CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.role',true),'')$$;GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role;")
 run('psql',*args,'-f',root/'tests/fixtures/staffManagementContractV1_1.sql')
 run('psql',*args,'-f',root/'supabase/migrations/20261021000900_staff_management.sql')
 raw(f"INSERT INTO core.businesses VALUES('{a}'),('{b}');")
 for key,value in u.items():raw(f"INSERT INTO auth.users VALUES('{value}','{key.lower()}@example.invalid','{{\"full_name\":\"Synthetic {key}\"}}');")
 for who,role,active,biz in [('ownerA','owner',True,a),('ownerA2','owner',False,a),('managerA','manager',True,a),('staffA','staff',True,a),('inactiveA','owner',False,a),('staffB','staff',True,b),('platformMember','staff',True,a),('inactivePlatform','staff',True,a)]:
  raw(f"INSERT INTO core.business_staff VALUES('{biz}','{u[who]}','{role}',{'true' if active else 'false'});")
 for who,active in [('platformOnly',True),('platformMember',True),('inactivePlatform',False)]:raw(f"INSERT INTO core.platform_operators VALUES('{u[who]}',{'true' if active else 'false'});")
 for who,expected in [('ownerA',True),('managerA',False),('staffA',False),('inactiveA',False),('staffB',False),('platformOnly',False),('platformMember',True),('inactivePlatform',False),('legacyOnly',False)]:assert call('staff_business_authorized_v1',[a,'staff.manage'],u[who])==expected
 assert call('staff_business_authorized_v1',[a,'ops.read'],u['platformOnly']) is True
 assert call('staff_business_authorized_v1',[None,'staff.manage'],u['ownerA']) is False
 assert call('staff_business_authorized_v1',[a,'staff.manage'],None) is False
 passed('v1.1: owner and active platform+member yes; manager/staff/platform-only/inactive/wrong tenant/NULL no; platform read unchanged')
 data=call('staff_members_list_v1',[a],u['ownerA']);assert data['inviteEnabled'] is False
 assert any(m['name']=='Synthetic staffA' and m['email']=='staffa@example.invalid' for m in data['members'])
 assert all(m['staffId']!=u['staffB'] for m in data['members'])
 for who in ['managerA','staffA','platformOnly','inactiveA']:rejected(f"SELECT public.staff_members_list_v1('{a}');",u[who])
 rejected(f"SELECT public.staff_members_list_v1('{b}');",u['ownerA']);passed('own-tenant unmasked member list; wrong-tenant/staff/manager/platform-only HTTP-boundary SQLSTATE 42501')
 for dbrole in ['anon','authenticated','service_role']:
  for table in ['business_staff','platform_operators','staff_management_invites','staff_management_settings','staff_management_audit']:
   assert sql(f"SELECT to_jsonb(has_table_privilege('{dbrole}','core.{table}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE'));") is False
 passed('private RLS tables have no application direct CRUD/TRUNCATE grants')
 update=lambda who,role,active,er,ea,actor=u['ownerA']:call('staff_member_update_v1',[a,u[who],role,active,er,ea],actor)
 assert update('ownerA','owner',False,'owner',True)['code']=='own_owner'
 assert update('ownerA','manager',True,'owner',True)['code']=='last_owner'
 assert update('ownerA','owner',False,'owner',True,u['platformMember'])['code']=='last_owner'
 assert update('ownerA2','owner',True,'owner',False,u['platformMember'])['changed'] is True
 assert update('ownerA','owner',False,'owner',True)['code']=='own_owner';passed('own owner cannot deactivate even with a second owner; last owner cannot deactivate/demote')
 assert update('managerA','staff',True,'manager',True)['changed'] is True
 assert update('staffA','staff',False,'staff',True)['changed'] is True
 assert update('staffA','manager',True,'staff',True)['code']=='stale_member'
 assert sql(f"SELECT count(*) FROM auth.users WHERE id='{u['staffA']}';")==1
 passed('role change and tenant deactivation preserve Auth user; stale snapshot rejected')
 def drop_owner(who):return update(who,'staff',True,'owner',True,u['platformMember'])
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:race=list(pool.map(drop_owner,['ownerA','ownerA2']))
 assert sorted(x['code'] for x in race)==['last_owner','updated'];assert sql(f"SELECT count(*) FROM core.business_staff WHERE business_id='{a}' AND role='owner' AND active;")==1
 raw(f"UPDATE core.business_staff SET role='owner',active=(staff_id='{u['ownerA']}') WHERE business_id='{a}' AND staff_id IN('{u['ownerA']}','{u['ownerA2']}');")
 passed('two concurrent owner demotions serialize: one updated, one last_owner; one owner remains')
 key=str(uuid.uuid4());assert call('staff_invite_prepare_v1',[a,'new@example.invalid','staff',key],u['ownerA'])['code']=='configuration_required'
 raw(f"INSERT INTO core.staff_management_settings VALUES('{a}',true,'https://a.example.invalid/staff/system');")
 prepared=call('staff_invite_prepare_v1',[a,'new@example.invalid','staff',key],u['ownerA']);invite=prepared['inviteId']
 assert call('staff_invite_prepare_v1',[a,'new@example.invalid','staff',key],u['ownerA'])['inviteId']==invite
 rejected(f"SELECT public.staff_invite_prepare_v1('{a}','other@example.invalid','owner','{key}');",u['ownerA'],code='22023')
 def gate(_):return call('staff_invite_gate_v1',[a,invite],u['ownerA'])
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:gates=list(pool.map(gate,range(2)))
 assert sum(x is not None for x in gates)==1;lease=next(x['claimToken'] for x in gates if x)
 ctx=call('staff_invite_context_v1',[a,invite,lease],None,'service_role');assert ctx['email']=='new@example.invalid' and ctx['existingUserId'] is None
 rejected(f"SELECT public.staff_invite_context_v1('{a}','{invite}','{lease}');",u['ownerA'])
 rejected(f"SELECT public.staff_invite_gate_v1('{a}','{invite}');",None,'service_role')
 rejected(f"SELECT public.staff_invite_finish_v1('{a}','{invite}','{lease}','{u['staffB']}','invited');",None,'service_role')
 passed('invites disabled by default; same-key idempotency; concurrent JWT gate only one lease; forged identity/service-only bypass denied')
 target=str(uuid.uuid4());raw(f"INSERT INTO auth.users VALUES('{target}','new@example.invalid','{{}}');")
 done=call('staff_invite_finish_v1',[a,invite,lease,target,'invited'],None,'service_role');assert done['code']=='invited'
 assert call('staff_invite_finish_v1',[a,invite,lease,target,'invited'],None,'service_role')==done
 assert sql(f"SELECT count(*) FROM core.staff_management_audit WHERE target_staff_id='{target}';")==1
 assert sql(f"SELECT count(*) FROM core.business_staff WHERE business_id='{a}' AND staff_id='{target}' AND active AND role='staff';")==1
 passed('Auth-matching identity creates exactly one tenant member/audit; repeated finalizer is idempotent')
 def intent(email,role='staff'):
  row=call('staff_invite_prepare_v1',[a,email,role,str(uuid.uuid4())],u['ownerA']);lease=call('staff_invite_gate_v1',[a,row['inviteId']],u['ownerA']);return row['inviteId'],lease['claimToken']
 unknown,utoken=intent('unknown@example.invalid');call('staff_invite_finish_v1',[a,unknown,utoken,None,'unknown'],None,'service_role')
 assert call('staff_invite_prepare_v1',[a,'unknown@example.invalid','staff',str(uuid.uuid4())],u['ownerA'])['code']=='invite_unknown'
 existing,etoken=intent('staffb@example.invalid','manager');ctx=call('staff_invite_context_v1',[a,existing,etoken],None,'service_role');assert ctx['existingUserId']==u['staffB']
 assert call('staff_invite_finish_v1',[a,existing,etoken,u['staffB'],'existing'],None,'service_role')['code']=='existing_account_added'
 assert sql(f"SELECT to_jsonb(role='staff') FROM core.business_staff WHERE business_id='{b}' AND staff_id='{u['staffB']}';") is True
 assert call('staff_invite_prepare_v1',[a,'staffa@example.invalid','owner',str(uuid.uuid4())],u['ownerA'])['code']=='member_exists'
 passed('unknown cannot resend; existing Auth user added only to target tenant; existing inactive membership cannot be overwritten by invite')
 revoked,rtoken=intent('revoked@example.invalid');newid=str(uuid.uuid4());raw(f"INSERT INTO auth.users VALUES('{newid}','revoked@example.invalid','{{}}');UPDATE core.business_staff SET active=false WHERE business_id='{a}' AND staff_id='{u['ownerA']}';")
 assert call('staff_invite_context_v1',[a,revoked,rtoken],None,'service_role') is None
 assert call('staff_invite_finish_v1',[a,revoked,rtoken,newid,'invited'],None,'service_role')['code']=='access_revoked'
 assert sql(f"SELECT count(*) FROM core.business_staff WHERE staff_id='{newid}';")==0
 passed('revocation after JWT gate creates no membership; service finalizer retains safe unknown audit')
 receipt={'local_only':True,'postgres':'18.6','shared_contract':'v1.1 proposed fixture; #65 helper not changed','passed':len(checks),'checks':checks,'concurrent_owner_changes':race,'concurrent_invite_gate_successes':1,'provider_calls':0,'hosted_changes':False,'fixture_manifest':manifest,'logs':str(folder),'migration_sha256':hashlib.sha256((root/'supabase/migrations/20261021000900_staff_management.sql').read_bytes()).hexdigest()}
 out=root/'20_Yonetim/Teslim_Raporlari/K10_personel_kanit';out.mkdir(parents=True,exist_ok=True);(out/'postgres-synthetic.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8');print(json.dumps({'passed':len(checks),'checks':checks,'logs':str(folder)}))
finally:
 if started:run('pg_ctl','-D',folder/'data','-m','fast','-w','stop')
