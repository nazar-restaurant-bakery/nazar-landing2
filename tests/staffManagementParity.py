"""Production-mode local builds with synthetic public values; no hosted writes."""
import pathlib,os,subprocess,json,hashlib,re
root=pathlib.Path(__file__).resolve().parents[1];base=root.parent/'nazar-staff-members-base'
node=pathlib.Path.home()/'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
out=root/'20_Yonetim/Teslim_Raporlari/K10_personel_kanit';out.mkdir(parents=True,exist_ok=True)
env={k:v for k,v in os.environ.items() if not k.startswith(('VITE_','SUPABASE_','CF_'))}
env.update(CF_PAGES_BRANCH='main',VITE_APP_ENV='production',VITE_SUPABASE_URL='https://khgczybubufouraqyrcj.supabase.co',VITE_SUPABASE_ANON_KEY='sb_publishable_synthetic_parity_only',VITE_NAZAR_BUSINESS_ID='a358eba4-b197-4309-805b-46f43a718454',VITE_TURNSTILE_SITE_KEY='synthetic_parity_only')
def run(args,cwd):
 p=subprocess.run(list(map(str,args)),cwd=cwd,env=env,capture_output=True,text=True,encoding='utf-8',creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),timeout=120)
 if p.returncode:raise RuntimeError(p.stdout+p.stderr)
 return p.stdout
for name,repo in [('base',base),('candidate',root)]:
 run([node,'node_modules/typescript/bin/tsc','-b'],repo)
 log=run([node,'node_modules/vite/bin/vite.js','build'],repo);(out/(name+'-build.txt')).write_text(log,encoding='utf-8')
def hashes(folder):return {p.relative_to(folder).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in folder.rglob('*') if p.is_file()}
a,b=hashes(base/'dist'),hashes(root/'dist');same=[p for p in a if p in b and a[p]==b[p]]
def asset(kind,folder):return next(p for p in (folder/'dist/assets').glob(kind+'-*'))
cssa=asset('index',base) # Select explicit CSS below: index JS also exists.
css=[p for p in (base/'dist/assets').glob('index-*.css')][0];cssb=[p for p in (root/'dist/assets').glob('index-*.css')][0]
source_paths=['src/App.tsx','src/lib/supabase.ts','src/lib/analytics.ts','src/pages/staff/StaffSignIn.tsx','functions/api/signup.ts','functions/api/staff/_middleware.ts']
sources={}
for p in source_paths:
 if (root/p).exists():
  current=(root/p).read_bytes();old=run(['git','show','origin/main:'+p],root).replace('\r\n','\n').encode()
  sources[p]={'same_as_base':current.replace(b'\r\n',b'\n')==(base/p).read_bytes().replace(b'\r\n',b'\n'),'same_as_origin_main':current.replace(b'\r\n',b'\n')==old}
# All public source files must remain byte-equivalent after Git newline normalization.
changed=run(['git','diff','--name-only','origin/main','--','public','src/pages/StaffPage.tsx','src/lib/analytics.ts','src/lib/supabase.ts','functions/api','index.html'],root).strip().splitlines()
assert not changed,changed
assert css.read_bytes()==cssb.read_bytes(),'Unexpected public CSS change'
assert len(a)==len(b),'Unexpected published file count change'
assert all(v['same_as_base'] and v['same_as_origin_main'] for v in sources.values()),sources
receipt={'production_mode':True,'synthetic_public_environment_only':True,'baseline':run(['git','rev-parse','HEAD'],base).strip(),'origin_main':run(['git','rev-parse','origin/main'],root).strip(),'base_files':len(a),'candidate_files':len(b),'byte_identical_files':len(same),'removed_or_changed':[p for p in a if p not in b or a[p]!=b[p]],'new_or_changed':[p for p in b if p not in a or a.get(p)!=b[p]],'css_identical':True,'sources':sources,'protected_source_diff':changed,'hosted_deployment':False}
(out/'production-parity.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8');print(json.dumps(receipt))
