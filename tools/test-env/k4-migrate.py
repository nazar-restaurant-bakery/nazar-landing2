"""One human-operated psql runner for the identical LF migration in test/production.

No unattended password/connection switch. Talip enters the database password and
starts each run. Config contains paths/refs/hash only, never credentials. No retry.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import uuid


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def validate(path, target):
    cfg = json.loads(Path(path).read_text(encoding='utf8'))
    required = ('test_ref', 'production_ref', 'host', 'pg_bin', 'ca_path', 'migration',
                'migration_sha256', 'acceptance', 'acceptance_sha256', 'receipt_directory')
    if not all(isinstance(cfg.get(k), str) and cfg[k] for k in required):
        raise ValueError('CONFIG_INCOMPLETE')
    if not all(re.fullmatch('[a-z]{20}', cfg[k]) for k in ('test_ref','production_ref')) or cfg['test_ref']==cfg['production_ref']:
        raise ValueError('DISTINCT_TARGET_REFS_REQUIRED')
    if not re.fullmatch(r'aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com',cfg['host']):
        raise ValueError('SESSION_POOLER_HOST_REQUIRED')
    for key in ('migration', 'acceptance'):
        p=Path(cfg[key])
        if not p.is_absolute() or not p.is_file() or b'\r' in p.read_bytes() or sha(p)!=cfg[key+'_sha256']:
            raise ValueError('LF_SOURCE_HASH_MISMATCH')
    if not Path(cfg['ca_path']).is_file() or not Path(cfg['pg_bin'],'psql.exe').is_file():
        raise ValueError('PSQL_AND_TLS_CA_REQUIRED')
    root=Path(cfg['receipt_directory'])
    if not root.is_absolute() or not root.is_dir():
        raise ValueError('RECEIPT_DIRECTORY_REQUIRED')
    if (root/(target+'-success.json')).exists():
        raise ValueError('SUCCESS_RECEIPT_EXISTS_DO_NOT_REPEAT')
    if (root/(target+'-attempt.json')).exists():
        raise ValueError('PRIOR_ATTEMPT_REQUIRES_INDEPENDENT_READBACK')
    version=subprocess.run([str(Path(cfg['pg_bin'],'psql.exe')),'--version'],capture_output=True,check=True,timeout=10).stdout.decode().strip()
    cfg['_psql_sha256']=sha(Path(cfg['pg_bin'],'psql.exe'))
    cfg['_ca_sha256']=sha(cfg['ca_path'])
    if target=='production':
        proof=json.loads((root/'test-success.json').read_text(encoding='utf8'))
        if (proof.get('status')!='completed' or proof.get('target_ref')!=cfg['test_ref']
            or proof.get('migration_sha256')!=cfg['migration_sha256']
            or proof.get('acceptance_sha256')!=cfg['acceptance_sha256']
            or proof.get('psql_version')!=version or proof.get('psql_binary_sha256')!=cfg['_psql_sha256']
            or proof.get('acceptance',{}).get('failed')!=0 or proof.get('acceptance',{}).get('passed',0)<11):
            raise ValueError('SAME_MIGRATION_TOOL_TEST_SUCCESS_REQUIRED')
    return cfg,version


def execute(cfg,target,password,version):
    ref=cfg['test_ref' if target=='test' else 'production_ref']
    root=Path(cfg['receipt_directory'])
    attempt=root/(target+'-attempt.json')
    state={'scope':'K4_OPERATOR_ATTEMPT','target':target,'target_ref':ref,
           'migration_sha256':cfg['migration_sha256'],'phase':'claimed_before_connection',
           'password_recorded':False,'automatic_retry':False}
    with attempt.open('x',encoding='utf8') as f:json.dump(state,f,indent=2)
    def phase(name):
        state['phase']=name;state['updated_at_utc']=datetime.now(timezone.utc).isoformat()
        temp=root/('.phase-'+uuid.uuid4().hex+'.json')
        temp.write_text(json.dumps(state,indent=2),encoding='utf8');os.replace(temp,attempt)
    run=root/(target+'-'+uuid.uuid4().hex);run.mkdir()
    frozen={}
    for key in ('migration','acceptance'):
        contents=Path(cfg[key]).read_bytes()
        if b'\r' in contents or hashlib.sha256(contents).hexdigest()!=cfg[key+'_sha256']:
            phase('source_changed_before_connection');raise RuntimeError('LF_SOURCE_HASH_MISMATCH')
        frozen[key]=run/(key+'.sql')
        with frozen[key].open('xb') as f:f.write(contents)
    env={k:v for k,v in os.environ.items() if not k.upper().startswith('PG')}
    env.update(PGHOST=cfg['host'],PGPORT='5432',PGUSER='postgres.'+ref,PGDATABASE='postgres',
               PGPASSWORD=password,PGSSLMODE='verify-full',PGSSLROOTCERT=cfg['ca_path'],
               PGCONNECT_TIMEOUT='20',PGCLIENTENCODING='UTF8',PGAPPNAME='k4-human-migration',
               PGOPTIONS='-c client_min_messages=error -c statement_timeout=60000 -c lock_timeout=5000')
    cmd=[str(Path(cfg['pg_bin'],'psql.exe')),'-X','--no-password','--set=ON_ERROR_STOP=1','-qAt']
    def call(args,sql=None):
        if sha(Path(cfg['pg_bin'],'psql.exe'))!=cfg['_psql_sha256'] or sha(cfg['ca_path'])!=cfg['_ca_sha256']:
            raise RuntimeError('DISPLAYED_TOOL_OR_TLS_CA_CHANGED')
        r=subprocess.run(cmd+args,input=sql,env=env,capture_output=True,timeout=150)
        if r.returncode:
            # Never expose server rows, statement text, credentials or raw stderr.
            code=re.search(rb'ERROR:\s+([A-Z][A-Z0-9_]{5,})',r.stderr)
            raise RuntimeError(code.group(1).decode() if code else 'PSQL_FAILED_STOP_NO_RETRY')
        return r.stdout.decode('utf8').strip()
    # Read-only identity classification before any DDL. No production rows read.
    probe="BEGIN READ ONLY; SELECT coalesce(bool_and(coalesce((to_jsonb(b)->>'is_test')::boolean,false)),false) FROM core.businesses b; ROLLBACK;"
    phase('read_only_preflight')
    is_test=call([],probe.encode())=='t'
    if is_test != (target=='test'):
        raise RuntimeError('TARGET_BUSINESS_CLASSIFICATION_MISMATCH')
    if any(sha(frozen[k])!=cfg[k+'_sha256'] for k in frozen):
        phase('frozen_source_changed');raise RuntimeError('FROZEN_SOURCE_HASH_MISMATCH')
    phase('migration_submitting_outcome_unknown_until_receipt')
    call(['--file',str(frozen['migration'])])
    phase('migration_committed')
    result={'scope':'K4_HUMAN_PSQL_MIGRATION','status':'completed','target':target,'target_ref':ref,
            'completed_at_utc':datetime.now(timezone.utc).isoformat(),
            'migration_sha256':cfg['migration_sha256'],'acceptance_sha256':cfg['acceptance_sha256'],
            'psql_version':version,'psql_binary_sha256':cfg['_psql_sha256'],
            'password_recorded':False,'automatic_retry':False}
    if target=='test':
        phase('synthetic_acceptance_running_after_migration_commit')
        output=call(['--file',str(frozen['acceptance'])])
        checks=[json.loads(line) for line in output.splitlines() if line.startswith('{')]
        if len(checks)!=1 or checks[0].get('failed')!=0 or checks[0].get('passed',0)<11:
            raise RuntimeError('ACCEPTANCE_RECEIPT_INVALID')
        result['acceptance']=checks[0]
    # Always re-check the source bytes after the database operation.
    if any(sha(frozen[k])!=cfg[k+'_sha256'] for k in frozen):
        raise RuntimeError('SOURCE_CHANGED_OUTCOME_REVIEW_REQUIRED')
    out=Path(cfg['receipt_directory'],target+'-success.json')
    if out.exists():
        raise RuntimeError('SUCCESS_RECEIPT_EXISTS_DO_NOT_REPEAT')
    with out.open('x',encoding='utf8') as f: json.dump(result,f,indent=2)
    phase('completed_success_receipt_written')
    return result


def gui(config,target):
    import tkinter as tk
    cfg,version=validate(config,target)
    root=tk.Tk();root.title('Nazar — K4 '+('TEST' if target=='test' else 'PRODUCTION'))
    root.geometry('720x410')
    active={'running':False}
    ref=cfg['test_ref' if target=='test' else 'production_ref']
    tk.Label(root,text='K4 — '+target.upper(),font=('Segoe UI',16,'bold')).pack(pady=14)
    tk.Label(root,text='Project ref: '+ref+'\n'+version+' · LF migration · TLS verify-full').pack()
    tk.Label(root,text='Bu projenin database password değerini gir.\nSupabase web / CRM / archive password kullanılmaz.').pack(pady=14)
    entry=tk.Entry(root,show='•',width=55);entry.pack();entry.focus_set()
    confirmed=tk.BooleanVar()
    tk.Checkbutton(root,text='Project ref doğru. Login ve uygulamayı Talip olarak ben başlatıyorum.',variable=confirmed).pack(pady=10)
    status=tk.StringVar(value='Hazır. Henüz database bağlantısı kurulmadı.')
    tk.Label(root,textvariable=status,wraplength=670).pack(pady=10)
    def start():
        if not confirmed.get() or not entry.get():
            status.set('Password ve hedef onayı gerekli.');return
        password=entry.get();entry.delete(0,'end');entry.config(state='disabled');button.config(state='disabled')
        active['running']=True
        status.set('psql çalışıyor; pencereyi açık bırak. Otomatik tekrar yapılmaz.')
        def work():
            try:
                fresh,v=validate(config,target)
                if fresh!=cfg or v!=version:
                    raise RuntimeError('DISPLAYED_PLAN_CHANGED_REOPEN_REQUIRED')
                execute(fresh,target,password,v)
                message='Tamamlandı. Receipt kaydedildi; pencere açık kalabilir.'
            except Exception as e:
                code=str(e)
                if not re.fullmatch('[A-Z0-9_]{5,}',code):code='K4_FAILED_RESULT_REVIEW_REQUIRED'
                message=code+' — yeniden başlatma; Codex sonucu incelesin.'
                Path(cfg['receipt_directory'],target+'-last-failure.json').write_text(json.dumps({'scope':'K4_OPERATOR_FAILURE','target':target,'code':code,'outcome_may_require_readback':True,'password_recorded':False}),encoding='utf8')
            def finished():
                active['running']=False;status.set(message)
            root.after(0,finished)
        threading.Thread(target=work,daemon=False).start()
    button=tk.Button(root,text=('Test migration + rollback testlerini başlat' if target=='test' else 'Production migration uygula (Talip)'),command=start)
    button.pack(pady=8)
    def close():
        if active['running']:status.set('İşlem sürüyor; tamamlanana kadar pencere açık kalmalı.')
        else:root.destroy()
    root.protocol('WM_DELETE_WINDOW',close)
    print('K4_GUI_READY_'+target.upper(),flush=True)
    root.mainloop()


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--config',required=True);p.add_argument('--target',choices=['test','production'],required=True);p.add_argument('--validate-only',action='store_true');a=p.parse_args()
    if a.validate_only:
        c,v=validate(a.config,a.target);print(json.dumps({'ready':True,'target':a.target,'migration_sha256':c['migration_sha256'],'psql_version':v,'connection_started':False}))
    else:gui(a.config,a.target)
