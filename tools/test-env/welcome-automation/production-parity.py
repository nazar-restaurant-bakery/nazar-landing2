"""Owned local base/candidate build comparison; no hosted configuration read."""
from pathlib import Path
import os, subprocess, zipfile, io, hashlib, json, re
ROOT=Path(__file__).resolve().parents[3]
BASE_SHA='b232a6cc8ac496eb7515e6232084ebcc8a098610'
NODE=Path('C:/Program Files/nodejs/node.exe')
BASE=ROOT.parent/'nazar-normal-welcome-consumer-base-b232a6c'
OUT=ROOT/'docs/coupons/normal-consumer-evidence'
OUT.mkdir(parents=True,exist_ok=True)
assert ROOT.parent.resolve()==BASE.parent.resolve()
assert not BASE.exists(), 'Owned baseline already exists; inspect it before reuse'
archive=subprocess.run(['git','archive','--format=zip',BASE_SHA],cwd=ROOT,capture_output=True,check=True).stdout
BASE.mkdir()
with zipfile.ZipFile(io.BytesIO(archive)) as z:
 for item in z.infolist():
  target=(BASE/item.filename).resolve()
  assert target.is_relative_to(BASE.resolve())
 z.extractall(BASE)
subprocess.run(['powershell','-NoProfile','-Command',"New-Item -ItemType Junction -Path '"+str(BASE/'node_modules').replace("'","''")+"' -Target '"+str(ROOT/'node_modules').replace("'","''")+"' | Out-Null"],check=True,capture_output=True)
env={k:v for k,v in os.environ.items() if not k.startswith(('VITE_','TEST_','SUPABASE_','CF_','COUPON_')) and k!='APP_ENV'}
source=(ROOT/'src/lib/deploymentEnvironment.ts').read_text(encoding='utf-8')
value=lambda name: re.search(r'export const '+name+r' = "([^"]+)"',source).group(1)
env.update(VITE_SUPABASE_URL=value('PRODUCTION_SUPABASE_URL'),VITE_NAZAR_BUSINESS_ID=value('PRODUCTION_BUSINESS_ID'),VITE_SUPABASE_ANON_KEY='sb_publishable_synthetic_parity_only',VITE_TURNSTILE_SITE_KEY='synthetic_parity_only',CF_PAGES_BRANCH='main')
for label,path in [('base',BASE),('candidate',ROOT)]:
 text=''
 for args in [[str(NODE),'node_modules/typescript/bin/tsc','-b'],[str(NODE),'node_modules/vite/bin/vite.js','build']]:
  p=subprocess.run(args,cwd=path,env=env,capture_output=True,text=True,encoding='utf-8',timeout=180,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
  text+=p.stdout+p.stderr
  (OUT/(label+'-build.log')).write_text(text,encoding='utf-8',newline='\n')
  assert p.returncode==0,text[-4000:]
def hashes(path):
 return {f.relative_to(path).as_posix():hashlib.sha256(f.read_bytes()).hexdigest() for f in path.rglob('*') if f.is_file()}
a,b=hashes(BASE/'dist'),hashes(ROOT/'dist')
assert a==b,'Production asset differences: '+str(sorted(set(a)^set(b)))
protected=['src','public','index.html','functions/api/signup.ts','functions/api/webhooks/vip-doi.ts','functions/api/internal/coupon-bootstrap.ts','functions/_lib/couponBootstrap.ts','functions/_lib/bootstrapReadBudget.ts','functions/_lib/couponDelivery.ts','supabase/migrations']
paths=subprocess.run(['git','diff',BASE_SHA,'--name-only','--',*protected],cwd=ROOT,capture_output=True,text=True,check=True).stdout.strip().splitlines()
assert not paths,paths
result={'baseline':BASE_SHA,'production_mode':True,'app_env_absent':True,'test_environment_absent':True,'public_values':'synthetic keys plus existing production routing constants; no hosted secrets read','base_files':len(a),'candidate_files':len(b),'byte_identical_files':len(a),'changed_assets':[],'protected_source_diff':paths,'hosted_reads':False,'hosted_deployment':False}
(OUT/'production-parity.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8',newline='\n')
print(json.dumps(result))
