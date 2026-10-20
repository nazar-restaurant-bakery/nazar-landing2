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


def read_pinned_json(path, expected_hash):
    source = Path(path)
    if not source.is_absolute() or not source.is_file() \
            or not re.fullmatch('[0-9a-f]{64}', str(expected_hash)):
        raise ValueError('REVIEW_PINNED_PROOF_REQUIRED')
    contents = source.read_bytes()
    if hashlib.sha256(contents).hexdigest() != expected_hash:
        raise ValueError('REVIEW_PINNED_PROOF_CHANGED')
    value = json.loads(contents.decode('utf8'))
    if not isinstance(value, dict):
        raise ValueError('REVIEW_OBJECT_PROOF_REQUIRED')
    return value


def utc_time(value):
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except (AttributeError, TypeError, ValueError):
        raise ValueError('REVIEW_DATED_PROOF_REQUIRED') from None
    if result.tzinfo is None:
        raise ValueError('REVIEW_DATED_PROOF_REQUIRED')
    return result.astimezone(timezone.utc)


def reviewed_continuation(cfg, target, review_path):
    """Authorize one named followup only for a proved pre-DDL network failure.

    This is a local proof review, never a connection or a request to repeat an
    ambiguous migration. The original durable attempt/failure remain immutable.
    """
    if target != 'production':
        raise ValueError('REVIEWED_CONTINUATION_PRODUCTION_ONLY')
    root = Path(cfg['receipt_directory'])
    if (root / 'production-followup-attempt.json').exists():
        raise ValueError('REVIEWED_CONTINUATION_ALREADY_ATTEMPTED')
    path = Path(review_path)
    if not path.is_absolute() or not path.is_file():
        raise ValueError('REVIEWED_CONTINUATION_MANIFEST_REQUIRED')
    review_hash = sha(path)
    review = read_pinned_json(path, review_hash)
    if review.get('scope') != 'K4_REVIEWED_PREFLIGHT_CONTINUATION' \
            or review.get('target') != target or review.get('target_ref') != cfg['production_ref'] \
            or review.get('migration_sha256') != cfg['migration_sha256'] \
            or review.get('acceptance_sha256') != cfg['acceptance_sha256'] \
            or review.get('psql_binary_sha256') != cfg['_psql_sha256'] \
            or review.get('ca_sha256') != cfg['_ca_sha256']:
        raise ValueError('REVIEWED_CONTINUATION_PLAN_MISMATCH')
    proofs = {}
    pins = [(str(path), review_hash)]
    for key in ('prior_attempt', 'prior_failure', 'network_diagnosis', 'inventory'):
        value = read_pinned_json(review.get(key + '_path', ''), review.get(key + '_sha256'))
        proofs[key] = value
        pins.append((str(Path(review[key + '_path'])), review[key + '_sha256']))
    if Path(review['prior_attempt_path']).resolve() != (root / 'production-attempt.json').resolve() \
            or Path(review['prior_failure_path']).resolve() != (root / 'production-last-failure.json').resolve():
        raise ValueError('REVIEW_ORIGINAL_ATTEMPT_PATH_MISMATCH')
    prior, failure = proofs['prior_attempt'], proofs['prior_failure']
    if prior.get('scope') != 'K4_OPERATOR_ATTEMPT' or prior.get('target') != 'production' \
            or prior.get('target_ref') != cfg['production_ref'] \
            or prior.get('migration_sha256') != cfg['migration_sha256'] \
            or prior.get('phase') != 'read_only_preflight' \
            or prior.get('password_recorded') is not False \
            or prior.get('automatic_retry') is not False \
            or failure.get('scope') != 'K4_OPERATOR_FAILURE' \
            or failure.get('target') != 'production' \
            or failure.get('code') != 'PSQL_FAILED_STOP_NO_RETRY' \
            or failure.get('password_recorded') is not False:
        raise ValueError('REVIEW_CONCLUSIVE_PREFLIGHT_FAILURE_REQUIRED')
    network = proofs['network_diagnosis']
    if network.get('scope') != 'K4_CREDENTIAL_FREE_NETWORK_DIAGNOSIS' \
            or network.get('host') != cfg['host'] or network.get('port') != 5432 \
            or network.get('restricted_outcome') != 'DNS_HOST_NOT_FOUND' \
            or network.get('restricted_error_code') != 11001 \
            or network.get('approved_environment_outcome') != 'TCP_CONNECTED' \
            or network.get('credentials_used') is not False \
            or network.get('database_connection_started') is not False:
        raise ValueError('REVIEW_KNOWN_CREDENTIAL_FREE_NETWORK_DIAGNOSIS_REQUIRED')
    inventory = proofs['inventory']
    absent = ('restore_function', 'list_offers_function', 'evidence_table', 'capability_table',
              'customer_guard', 'guard_function', 'evidence_guard_function')
    if inventory.get('scope') != 'K4_PRODUCTION_READ_ONLY_PREFLIGHT_INVENTORY' \
            or inventory.get('target_ref') != cfg['production_ref'] \
            or inventory.get('transaction_read_only') is not True \
            or inventory.get('rolled_back') is not True \
            or inventory.get('business_marked_test') is not False \
            or inventory.get('account_operations') != 0 \
            or any(inventory.get(key + '_present') is not False for key in absent):
        raise ValueError('REVIEW_FRESH_PRODUCTION_K4_ABSENT_INVENTORY_REQUIRED')
    prior_time = utc_time(prior.get('updated_at_utc'))
    review_time = utc_time(review.get('reviewed_at_utc'))
    now = datetime.now(timezone.utc)
    for proof in (network, inventory):
        observed = utc_time(proof.get('observed_at_utc'))
        if observed < prior_time or observed > review_time \
                or (now - observed).total_seconds() > 3600 \
                or (observed - now).total_seconds() > 60:
            raise ValueError('REVIEW_FRESH_POST_FAILURE_PROOF_REQUIRED')
    if review_time < prior_time or (review_time - now).total_seconds() > 60 \
            or (now - review_time).total_seconds() > 3600:
        raise ValueError('REVIEW_FRESH_POST_FAILURE_PROOF_REQUIRED')
    return {'review_path': str(path), 'review_sha256': review_hash,
            'prior_attempt_sha256': review['prior_attempt_sha256'],
            'attempt_path': str(root / 'production-followup-attempt.json'),
            'failure_path': str(root / 'production-followup-last-failure.json'),
            'pins': pins}


def classify_psql_error(stderr):
    """Return only a fixed known category; never retain stderr or a matched token."""
    message = stderr.lower()
    if b'tenant or user not found' in message:
        return 'TARGET_NOT_FOUND'
    if b'password authentication failed' in message or b'28p01' in message:
        return 'AUTH_REJECTED'
    if any(part in message for part in (b'certificate verify failed', b'certificate verification failed',
            b'root certificate file', b'ssl certificate', b'tls certificate', b'ssl handshake')):
        return 'TLS_VERIFICATION_FAILED'
    if any(part in message for part in (b'could not translate host name', b'name or service not known',
            b'no such host', b'hostnotfound')):
        return 'DNS_HOST_NOT_FOUND'
    if any(part in message for part in (b'connection refused', b'connection timed out', b'timeout expired',
            b'network is unreachable', b'could not connect to server')):
        return 'NETWORK_UNREACHABLE'
    if any(part in message for part in (b'too many connections', b'remaining connection slots',
            b'cannot connect now', b'database system is starting up', b'57p03', b'53300')):
        return 'SERVER_UNAVAILABLE'
    if b'permission denied' in message or b'42501' in message:
        return 'DATABASE_PERMISSION_REJECTED'
    return 'PSQL_FAILED_STOP_NO_RETRY'


def validate(path, target, reviewed_preflight_continuation=None):
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
    has_prior_attempt = (root/(target+'-attempt.json')).exists()
    if has_prior_attempt and reviewed_preflight_continuation is None:
        raise ValueError('PRIOR_ATTEMPT_REQUIRES_INDEPENDENT_READBACK')
    if reviewed_preflight_continuation is not None and not has_prior_attempt:
        raise ValueError('REVIEW_ORIGINAL_PREFLIGHT_ATTEMPT_REQUIRED')
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
    cfg.pop('_reviewed_preflight_continuation', None)
    if reviewed_preflight_continuation is not None:
        cfg['_reviewed_preflight_continuation'] = reviewed_continuation(
            cfg, target, reviewed_preflight_continuation
        )
    return cfg,version


def execute(cfg,target,password,version):
    ref=cfg['test_ref' if target=='test' else 'production_ref']
    root=Path(cfg['receipt_directory'])
    continuation = cfg.get('_reviewed_preflight_continuation')
    if continuation:
        for path, expected_hash in continuation['pins']:
            if sha(path) != expected_hash:
                raise RuntimeError('REVIEW_PINNED_PROOF_CHANGED')
    attempt=Path(continuation['attempt_path']) if continuation else root/(target+'-attempt.json')
    state={'scope':'K4_OPERATOR_ATTEMPT','target':target,'target_ref':ref,
           'migration_sha256':cfg['migration_sha256'],'phase':'claimed_before_connection',
           'password_recorded':False,'automatic_retry':False}
    if continuation:
        state['reviewed_preflight_continuation_sha256'] = continuation['review_sha256']
        state['prior_attempt_sha256'] = continuation['prior_attempt_sha256']
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
            raise RuntimeError(classify_psql_error(r.stderr))
        return r.stdout.decode('utf8').strip()
    # Read-only identity classification before any DDL. No production rows read.
    probe="BEGIN READ ONLY; SELECT coalesce(bool_and(coalesce((to_jsonb(b)->>'is_test')::boolean,false)),false) FROM core.businesses b; ROLLBACK;"
    phase('read_only_preflight')
    is_test=call([],probe.encode())=='t'
    if is_test != (target=='test'):
        raise RuntimeError('TARGET_BUSINESS_CLASSIFICATION_MISMATCH')
    if any(sha(frozen[k])!=cfg[k+'_sha256'] for k in frozen):
        phase('frozen_source_changed');raise RuntimeError('FROZEN_SOURCE_HASH_MISMATCH')
    if continuation and any(sha(path) != expected_hash for path, expected_hash in continuation['pins']):
        phase('review_pins_changed_before_ddl');raise RuntimeError('REVIEW_PINNED_PROOF_CHANGED')
    phase('migration_submitting_outcome_unknown_until_receipt')
    call(['--file',str(frozen['migration'])])
    phase('migration_committed')
    result={'scope':'K4_HUMAN_PSQL_MIGRATION','status':'completed','target':target,'target_ref':ref,
            'completed_at_utc':datetime.now(timezone.utc).isoformat(),
            'migration_sha256':cfg['migration_sha256'],'acceptance_sha256':cfg['acceptance_sha256'],
            'psql_version':version,'psql_binary_sha256':cfg['_psql_sha256'],
            'password_recorded':False,'automatic_retry':False}
    if continuation:
        result['reviewed_preflight_continuation_sha256'] = continuation['review_sha256']
        result['prior_attempt_sha256'] = continuation['prior_attempt_sha256']
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


def gui(config,target,reviewed_preflight_continuation=None):
    import tkinter as tk
    cfg,version=validate(config,target,reviewed_preflight_continuation)
    root=tk.Tk();root.title('Nazar — K4 '+('TEST' if target=='test' else 'PRODUCTION')
                           +(' — reviewed continuation' if reviewed_preflight_continuation else ''))
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
                fresh,v=validate(config,target,reviewed_preflight_continuation)
                if fresh!=cfg or v!=version:
                    raise RuntimeError('DISPLAYED_PLAN_CHANGED_REOPEN_REQUIRED')
                execute(fresh,target,password,v)
                message='Tamamlandı. Receipt kaydedildi; pencere açık kalabilir.'
            except Exception as e:
                code=str(e)
                if not re.fullmatch('[A-Z0-9_]{5,}',code):code='K4_FAILED_RESULT_REVIEW_REQUIRED'
                message=code+' — yeniden başlatma; Codex sonucu incelesin.'
                continuation = cfg.get('_reviewed_preflight_continuation')
                failure_path = Path(continuation['failure_path']) if continuation else Path(cfg['receipt_directory'],target+'-last-failure.json')
                failure_path.write_text(json.dumps({'scope':'K4_OPERATOR_FAILURE','target':target,'code':code,'outcome_may_require_readback':True,'password_recorded':False}),encoding='utf8')
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
    p=argparse.ArgumentParser();p.add_argument('--config',required=True);p.add_argument('--target',choices=['test','production'],required=True);p.add_argument('--validate-only',action='store_true');p.add_argument('--reviewed-preflight-continuation');a=p.parse_args()
    if a.validate_only:
        c,v=validate(a.config,a.target,a.reviewed_preflight_continuation);print(json.dumps({'ready':True,'target':a.target,'migration_sha256':c['migration_sha256'],'psql_version':v,'connection_started':False,'reviewed_preflight_continuation':bool(c.get('_reviewed_preflight_continuation'))}))
    else:gui(a.config,a.target,a.reviewed_preflight_continuation)
