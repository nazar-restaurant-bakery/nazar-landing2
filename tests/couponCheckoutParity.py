"""Compare already-built candidate/base; hosted settings or secrets are never read."""
from pathlib import Path
import hashlib,json,re,subprocess
r=Path(__file__).resolve().parents[1];base=r.parent/'nazar-coupon-checkout-base'
out=r/'20_Yonetim/Teslim_Raporlari/K10_kasa_kanit';out.mkdir(parents=True,exist_ok=True)
def files(p):return {f.relative_to(p).as_posix():f.read_bytes() for f in p.rglob('*') if f.is_file()}
a,b=files(base/'dist'),files(r/'dist')
def normalize(v):return re.sub(rb'(StaffPage|index|jsQR)-[A-Za-z0-9_-]+\.(js|css)',rb'\1-HASH.\2',v)
protected=[p.relative_to(r).as_posix() for p in (r/'src/pages').glob('*.tsx') if p.name!='StaffPage.tsx']+['src/lib/analytics.ts','src/lib/signup.ts','src/lib/supabase.ts','src/lib/staffSupabase.ts','src/pages/staff/StaffSignIn.tsx','functions/api/signup.ts','functions/_lib/klaviyoProfileSync.ts','supabase/functions/ops-collect/ga4.ts']
current_main='0449e1ea493397ce182c4881d5213b968b0bf78d'
proof=[]
for name in protected:
 local=(r/name).read_bytes().replace(b'\r\n',b'\n')
 remote=subprocess.run(['git','show',current_main+':'+name],cwd=r,capture_output=True,check=True).stdout.replace(b'\r\n',b'\n')
 assert local==remote,name
 proof.append({'path':name,'sha256_lf':hashlib.sha256(local).hexdigest()})
cssa={k:v for k,v in a.items() if k.endswith('.css')};cssb={k:v for k,v in b.items() if k.endswith('.css')}
receipt={'baseline':'0449e1ea493397ce182c4881d5213b968b0bf78d (main)','current_main_source_comparison':current_main,'environment':'same Production target/mode, same synthetic publishable/site-key placeholders; hosted values not read','baseline_files':len(a),'candidate_files':len(b),'byte_identical_files':sum(k in b and a[k]==b[k] for k in a),'changed_same_path':[k for k in a if k in b and a[k]!=b[k]],'removed_hashed_files':sorted(a.keys()-b.keys()),'added_hashed_files':sorted(b.keys()-a.keys()),'normalized_index_html_identical':normalize(a['index.html'])==normalize(b['index.html']),'existing_css_identical':cssa==cssb,'protected_source_parity':proof,'expected_changes':'StaffPage checkout, lazy jsQR chunk, generated CommonJS interop/minified binding names in shared main JS, content hash references. Main JS is not claimed byte-equal after normalization.','provider_calls':0,'production_deployment':False}
assert receipt['normalized_index_html_identical'] and receipt['existing_css_identical']
(out/'production-parity.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8');print(json.dumps(receipt))
