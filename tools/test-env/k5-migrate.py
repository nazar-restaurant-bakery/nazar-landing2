"""Dedicated, human-started K5 migration runner. No retries or account actions.

Only Talip enters the password and presses Start. Every connection uses the
reviewed psql binary, CA, target binding and frozen LF SQL. A failed or ambiguous
attempt is never automatically repeated. Config/receipts contain no passwords.
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
import time
import uuid

APPROVED_MIGRATION_SHA256 = 'd28672a87149839c71e44c72116ebbf3b96b2e76c7ec42a2a79c1f7b9f4fabc2'
PSQL_VERSION = 'psql (PostgreSQL) 18.6'
TOTAL_DEADLINE_SECONDS = 300
ACCEPTANCE_SCOPE = 'K5_SYNTHETIC_ROLLBACK_DB_ACCEPTANCE'
_HASH = re.compile(r'[0-9a-f]{64}')
_UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', re.I)
_SAFE_CODES = frozenset('''K5_STOP_RESULT_REVIEW_REQUIRED AUTH_REJECTED TARGET_NOT_FOUND
TLS_VERIFICATION_FAILED DNS_HOST_NOT_FOUND NETWORK_UNREACHABLE DATABASE_PERMISSION_REJECTED
PSQL_FAILED_STOP_NO_RETRY REVIEWED_SOURCE_REQUIRED LF_SOURCE_HASH_MISMATCH
REVIEWED_TRANSACTION_SQL_REQUIRED ACCEPTANCE_RECEIPT_INVALID PINNED_TEST_SUCCESS_REQUIRED
SAME_MIGRATION_TOOL_CA_TEST_SUCCESS_REQUIRED EXPLICIT_TARGET_REQUIRED HUMAN_PRODUCTION_FLAG_REQUIRED
ABSOLUTE_REVIEWED_CONFIG_REQUIRED CONFIG_FIELDS_INVALID K5_APPROVED_MIGRATION_REQUIRED
REVIEWED_TOOL_AND_ACCEPTANCE_REQUIRED DISTINCT_CONFIGURED_TARGETS_REQUIRED
REVIEWED_POOLER_PROJECT_BINDING_REQUIRED REVIEWED_TOOL_OR_CA_HASH_MISMATCH
REVIEWED_PSQL_EXECUTABLE_REQUIRED FRESH_EMPTY_RECEIPT_DIRECTORY_REQUIRED
REVIEWED_PSQL_VERSION_REQUIRED READ_ONLY_TARGET_OR_K5_ABSENCE_CHECK_FAILED
DISPLAYED_PLAN_CHANGED_REOPEN_REQUIRED DISPLAYED_TOOL_OR_CA_CHANGED FROZEN_OR_REVIEWED_SOURCE_CHANGED
K5_PROCESS_DEADLINE_EXCEEDED K5_PROCESS_TIMEOUT_OUTCOME_REVIEW_REQUIRED
PSQL_LAUNCH_FAILED_STOP_NO_RETRY READ_ONLY_PREFLIGHT_RECEIPT_INVALID'''.split())


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def safe_code(error):
    value = str(error)
    return value if value in _SAFE_CODES else 'K5_STOP_RESULT_REVIEW_REQUIRED'


def classify_psql_error(stderr):
    """Fixed categories only; never persist stderr, statements or matched text."""
    value = stderr.lower()
    for fragments, code in (
        ((b'password authentication failed', b'28p01'), 'AUTH_REJECTED'),
        ((b'tenant or user not found',), 'TARGET_NOT_FOUND'),
        ((b'certificate verify failed', b'certificate verification failed', b'root certificate file', b'ssl certificate'), 'TLS_VERIFICATION_FAILED'),
        ((b'could not translate host name', b'no such host', b'name or service not known'), 'DNS_HOST_NOT_FOUND'),
        ((b'connection refused', b'connection timed out', b'network is unreachable', b'could not connect to server'), 'NETWORK_UNREACHABLE'),
        ((b'permission denied', b'42501'), 'DATABASE_PERMISSION_REJECTED'),
    ):
        if any(fragment in value for fragment in fragments):
            return code
    return 'PSQL_FAILED_STOP_NO_RETRY'


def source_bytes(path, digest, ending):
    p = Path(path)
    if not p.is_absolute() or not p.is_file() or not _HASH.fullmatch(str(digest)):
        raise ValueError('REVIEWED_SOURCE_REQUIRED')
    data = p.read_bytes()
    if b'\r' in data or data.startswith(b'\xef\xbb\xbf') or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('LF_SOURCE_HASH_MISMATCH')
    if not data.rstrip().endswith(ending) or re.search(rb'(?m)^\s*\\', data):
        raise ValueError('REVIEWED_TRANSACTION_SQL_REQUIRED')
    return data


def validate_acceptance(value, minimum):
    if not isinstance(value, dict) or value.get('scope') != ACCEPTANCE_SCOPE:
        raise ValueError('ACCEPTANCE_RECEIPT_INVALID')
    checks = value.get('checks')
    if (not isinstance(checks, list) or len(checks) < minimum
            or any(not isinstance(c, dict) or set(c) != {'name', 'passed'}
                   or not isinstance(c['name'], str) or not c['name'] or c['passed'] is not True for c in checks)
            or len({c['name'] for c in checks}) != len(checks)
            or type(value.get('passed')) is not int or value['passed'] != len(checks)
            or type(value.get('failed')) is not int or value['failed'] != 0
            or value.get('missing') != [] or value.get('provider_calls') != 0
            or value.get('account_operations') != 0 or value.get('auth_http_claimed') is not False
            or value.get('fixtures_rolled_back') is not True):
        raise ValueError('ACCEPTANCE_RECEIPT_INVALID')
    return {key: value[key] for key in ('scope', 'passed', 'failed', 'checks', 'missing',
            'provider_calls', 'account_operations', 'auth_http_claimed', 'fixtures_rolled_back')}


def pinned_test_success(cfg):
    path = Path(cfg.get('test_success_path', ''))
    digest = cfg.get('test_success_sha256', '')
    if not path.is_absolute() or not path.is_file() or not _HASH.fullmatch(digest) or sha(path) != digest:
        raise ValueError('PINNED_TEST_SUCCESS_REQUIRED')
    try:
        proof = json.loads(path.read_text(encoding='utf8'))
        expected = {
            'scope': 'K5_HUMAN_PSQL_MIGRATION', 'status': 'completed', 'target': 'test',
            'target_ref': cfg['targets']['test']['ref'], 'business_id': cfg['targets']['test']['business_id'],
            'migration_sha256': cfg['migration_sha256'], 'acceptance_sha256': cfg['acceptance_sha256'],
            'psql_version': PSQL_VERSION, 'psql_binary_sha256': cfg['psql_binary_sha256'],
            'ca_sha256': cfg['ca_sha256'], 'operator_sha256': cfg['_operator_sha256'],
            'password_recorded': False, 'automatic_retry': False,
        }
        if any(proof.get(key) != expected_value for key, expected_value in expected.items()):
            raise ValueError('SAME_MIGRATION_TOOL_CA_TEST_SUCCESS_REQUIRED')
        validate_preflight(proof.get('preflight'), 'test')
        validate_acceptance(proof.get('acceptance'), cfg['acceptance_minimum_checks'])
    except (OSError, TypeError, json.JSONDecodeError):
        raise ValueError('PINNED_TEST_SUCCESS_REQUIRED') from None
    return str(path), digest


def clean_environment():
    # Discard every inherited libpq option/service/password/SSL setting.
    return {key: value for key, value in os.environ.items() if not key.upper().startswith('PG')
            and key.upper() not in ('PSQLRC', 'PSQL_HISTORY')}


def connection_kind(target):
    """No configurable username: direct host must bind the exact reviewed ref."""
    if target['host'] == 'db.' + target['ref'] + '.supabase.co':
        return 'Direct'
    if re.fullmatch(r'aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com', str(target['host'])):
        return 'Session pooler'
    return None


def validate(config_path, target, allow_production=False, ready_token=None):
    if target not in ('test', 'production'):
        raise ValueError('EXPLICIT_TARGET_REQUIRED')
    if target == 'production' and not allow_production:
        raise ValueError('HUMAN_PRODUCTION_FLAG_REQUIRED')
    path = Path(config_path)
    if not path.is_absolute() or not path.is_file():
        raise ValueError('ABSOLUTE_REVIEWED_CONFIG_REQUIRED')
    cfg = json.loads(path.read_text(encoding='utf8'))
    required = {'migration', 'migration_sha256', 'acceptance', 'acceptance_sha256', 'psql_path',
                'psql_binary_sha256', 'psql_version', 'ca_path', 'ca_sha256', 'receipt_directory',
                'targets', 'acceptance_minimum_checks'}
    if not isinstance(cfg, dict) or not required.issubset(cfg) or set(cfg) - required - {'test_success_path', 'test_success_sha256'}:
        raise ValueError('CONFIG_FIELDS_INVALID')
    if cfg['migration_sha256'] != APPROVED_MIGRATION_SHA256:
        raise ValueError('K5_APPROVED_MIGRATION_REQUIRED')
    source_bytes(cfg['migration'], cfg['migration_sha256'], b'COMMIT;')
    source_bytes(cfg['acceptance'], cfg['acceptance_sha256'], b'ROLLBACK;')
    if (type(cfg['acceptance_minimum_checks']) is not int or not 1 <= cfg['acceptance_minimum_checks'] <= 200
            or cfg['psql_version'] != PSQL_VERSION):
        raise ValueError('REVIEWED_TOOL_AND_ACCEPTANCE_REQUIRED')
    targets = cfg['targets']
    if not isinstance(targets, dict) or set(targets) != {'test', 'production'}:
        raise ValueError('DISTINCT_CONFIGURED_TARGETS_REQUIRED')
    for value in targets.values():
        if (not isinstance(value, dict) or set(value) != {'name', 'ref', 'host', 'port', 'business_id'}
                or not isinstance(value['name'], str) or not 1 <= len(value['name']) <= 120
                or not re.fullmatch(r'[a-z]{20}', str(value['ref']))
                or connection_kind(value) is None
                or type(value['port']) is not int or value['port'] != 5432
                or not _UUID.fullmatch(str(value['business_id']))):
            raise ValueError('REVIEWED_POOLER_PROJECT_BINDING_REQUIRED')
    if targets['test']['ref'] == targets['production']['ref']:
        raise ValueError('DISTINCT_CONFIGURED_TARGETS_REQUIRED')
    for key, hash_key in (('psql_path', 'psql_binary_sha256'), ('ca_path', 'ca_sha256')):
        file = Path(cfg[key])
        if (not file.is_absolute() or not file.is_file() or not _HASH.fullmatch(str(cfg[hash_key]))
                or sha(file) != cfg[hash_key]):
            raise ValueError('REVIEWED_TOOL_OR_CA_HASH_MISMATCH')
    if Path(cfg['psql_path']).name.lower() != 'psql.exe':
        raise ValueError('REVIEWED_PSQL_EXECUTABLE_REQUIRED')
    root = Path(cfg['receipt_directory'])
    if not root.is_absolute() or not root.is_dir():
        raise ValueError('FRESH_EMPTY_RECEIPT_DIRECTORY_REQUIRED')
    cfg['_config_sha256'] = sha(path)
    cfg['_operator_sha256'] = sha(__file__)
    cfg['_config_path'] = str(path)
    cfg['_allow_production'] = allow_production
    existing = list(root.iterdir())
    if ready_token is not None:
        try:
            ready = json.loads((root / 'gui-ready.json').read_text(encoding='utf8'))
        except (OSError, json.JSONDecodeError):
            raise ValueError('FRESH_EMPTY_RECEIPT_DIRECTORY_REQUIRED') from None
        expected_ready = {'scope': 'K5_GUI_READY', 'target': target, 'target_ref': targets[target]['ref'],
                          'config_sha256': cfg['_config_sha256'], 'operator_sha256': cfg['_operator_sha256'],
                          'window_token': ready_token, 'connection_started': False, 'password_recorded': False}
        if len(existing) != 1 or existing[0].name != 'gui-ready.json' or ready != expected_ready:
            raise ValueError('FRESH_EMPTY_RECEIPT_DIRECTORY_REQUIRED')
        cfg['_gui_token'] = ready_token
    elif existing:
        raise ValueError('FRESH_EMPTY_RECEIPT_DIRECTORY_REQUIRED')
    if target == 'production':
        cfg['_test_proof'] = pinned_test_success(cfg)
    try:
        result = subprocess.run([cfg['psql_path'], '--version'], env=clean_environment(),
                                capture_output=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError('REVIEWED_PSQL_VERSION_REQUIRED') from None
    if result.returncode or result.stdout.decode('utf8', errors='replace').strip() != PSQL_VERSION:
        raise ValueError('REVIEWED_PSQL_VERSION_REQUIRED')
    return cfg


def preflight_sql(target):
    # UUID was strictly validated before interpolation. Read only aggregate state.
    business = target['business_id']
    return f"""BEGIN READ ONLY;
SELECT jsonb_build_object(
 'scope','K5_READ_ONLY_PREFLIGHT','read_only',current_setting('transaction_read_only')='on',
 'database',current_database(),
 'business_count',(SELECT count(*) FROM core.businesses WHERE id='{business}'::uuid),
 'business_marked_test',(SELECT coalesce((to_jsonb(b)->>'is_test')::boolean,false) FROM core.businesses b WHERE id='{business}'::uuid),
 'all_businesses_test',(SELECT coalesce(bool_and(coalesce((to_jsonb(b)->>'is_test')::boolean,false)),false) FROM core.businesses b),
 'core_closed',NOT (has_schema_privilege('anon','core','USAGE') OR has_schema_privilege('authenticated','core','USAGE') OR has_schema_privilege('service_role','core','USAGE')),
 'baseline_and_k4_present',to_regclass('core.customers') IS NOT NULL AND to_regclass('core.signups') IS NOT NULL AND to_regclass('core.crm_staff') IS NOT NULL AND to_regclass('core.klaviyo_email_observations') IS NOT NULL AND to_regprocedure('core.guard_email_suppression_v1()') IS NOT NULL,
 'k5_objects',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('core','public') AND c.relname LIKE 'klaviyo_profile_sync_%')+(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('core','public') AND (p.proname LIKE 'klaviyo_profile_sync_%' OR p.proname='crm_profile_sync_queue_v1')));
ROLLBACK;
""".encode('utf8')


def validate_preflight(value, target):
    if (not isinstance(value, dict) or value.get('scope') != 'K5_READ_ONLY_PREFLIGHT'
            or value.get('read_only') is not True or value.get('database') != 'postgres'
            or value.get('business_count') != 1 or value.get('business_marked_test') is not (target == 'test')
            or (target == 'test' and value.get('all_businesses_test') is not True)
            or value.get('core_closed') is not True or value.get('baseline_and_k4_present') is not True
            or type(value.get('k5_objects')) is not int or value['k5_objects'] != 0):
        raise ValueError('READ_ONLY_TARGET_OR_K5_ABSENCE_CHECK_FAILED')
    return value


def execute(cfg, target, password):
    """Only the GUI calls this after human confirmation; tests inject subprocess."""
    root = Path(cfg['receipt_directory'])
    selected = cfg['targets'][target]
    if target == 'production':
        if not cfg.get('_allow_production'):
            raise ValueError('HUMAN_PRODUCTION_FLAG_REQUIRED')
        pinned_test_success(cfg)
    state = {'scope': 'K5_OPERATOR_ATTEMPT', 'target': target, 'target_ref': selected['ref'],
             'phase': 'claimed_before_connection', 'migration_sha256': cfg['migration_sha256'],
             'password_recorded': False, 'automatic_retry': False}
    attempt = root / (target + '-attempt.json')
    with attempt.open('x', encoding='utf8') as handle:
        json.dump(state, handle, indent=2)

    def phase(name):
        state['phase'] = name
        state['updated_at_utc'] = datetime.now(timezone.utc).isoformat()
        temp = root / ('.phase-' + uuid.uuid4().hex + '.json')
        temp.write_text(json.dumps(state, indent=2), encoding='utf8')
        os.replace(temp, attempt)

    run = root / ('frozen-' + uuid.uuid4().hex)
    run.mkdir()
    frozen = {}
    for key, ending in (('migration', b'COMMIT;'), ('acceptance', b'ROLLBACK;')):
        data = source_bytes(cfg[key], cfg[key + '_sha256'], ending)
        frozen[key] = run / (key + '.sql')
        with frozen[key].open('xb') as handle:
            handle.write(data)
    deadline = time.monotonic() + TOTAL_DEADLINE_SECONDS
    env = clean_environment()
    env.update(PGHOST=selected['host'], PGPORT=str(selected['port']),
               PGUSER='postgres' if connection_kind(selected) == 'Direct' else 'postgres.' + selected['ref'],
               PGDATABASE='postgres', PGPASSWORD=password, PGSSLMODE='verify-full', PGSSLROOTCERT=cfg['ca_path'],
               PGCONNECT_TIMEOUT='15', PGCLIENTENCODING='UTF8', PGAPPNAME='k5-human-migration',
               PSQL_HISTORY=os.devnull,
               PGOPTIONS='-c client_min_messages=error -c statement_timeout=60000 -c lock_timeout=5000')
    command = [cfg['psql_path'], '-X', '--no-password', '--set=ON_ERROR_STOP=1', '-qAt']

    def check_pins():
        if sha(cfg['_config_path']) != cfg['_config_sha256'] or sha(__file__) != cfg['_operator_sha256']:
            raise ValueError('DISPLAYED_PLAN_CHANGED_REOPEN_REQUIRED')
        for key, digest_key in (('psql_path', 'psql_binary_sha256'), ('ca_path', 'ca_sha256')):
            if sha(cfg[key]) != cfg[digest_key]:
                raise ValueError('DISPLAYED_TOOL_OR_CA_CHANGED')
        if any(sha(frozen[key]) != cfg[key + '_sha256'] or sha(cfg[key]) != cfg[key + '_sha256'] for key in frozen):
            raise ValueError('FROZEN_OR_REVIEWED_SOURCE_CHANGED')
        if target == 'production':
            pinned_test_success(cfg)

    def call(args, input_sql=None, acceptance=False):
        check_pins()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError('K5_PROCESS_DEADLINE_EXCEEDED')
        call_env = dict(env)
        if acceptance:
            call_env['PGOPTIONS'] += ' -c k5.test_business_id=' + selected['business_id']
        try:
            result = subprocess.run(command + args, input=input_sql, env=call_env,
                                    capture_output=True, timeout=min(120, remaining), check=False)
        except subprocess.TimeoutExpired:
            raise ValueError('K5_PROCESS_TIMEOUT_OUTCOME_REVIEW_REQUIRED') from None
        except OSError:
            raise ValueError('PSQL_LAUNCH_FAILED_STOP_NO_RETRY') from None
        finally:
            call_env.pop('PGPASSWORD', None)
        if result.returncode:
            raise ValueError(classify_psql_error(result.stderr))
        return result.stdout.decode('utf8', errors='replace').strip()

    try:
        phase('read_only_preflight')
        try:
            preflight = validate_preflight(json.loads(call([], preflight_sql(selected))), target)
        except json.JSONDecodeError:
            raise ValueError('READ_ONLY_PREFLIGHT_RECEIPT_INVALID') from None
        phase('migration_submitting_outcome_unknown_until_receipt')
        call(['--file', str(frozen['migration'])])
        phase('migration_committed')
        result = {'scope': 'K5_HUMAN_PSQL_MIGRATION', 'status': 'completed', 'target': target,
                  'target_ref': selected['ref'], 'business_id': selected['business_id'],
                  'completed_at_utc': datetime.now(timezone.utc).isoformat(),
                  'migration_sha256': cfg['migration_sha256'], 'acceptance_sha256': cfg['acceptance_sha256'],
                  'psql_version': PSQL_VERSION, 'psql_binary_sha256': cfg['psql_binary_sha256'],
                  'ca_sha256': cfg['ca_sha256'], 'operator_sha256': cfg['_operator_sha256'],
                  'preflight': preflight, 'password_recorded': False, 'automatic_retry': False}
        if target == 'test':
            phase('synthetic_acceptance_running_after_commit')
            try:
                acceptance = json.loads(call(['--file', str(frozen['acceptance'])], acceptance=True))
            except json.JSONDecodeError:
                raise ValueError('ACCEPTANCE_RECEIPT_INVALID') from None
            result['acceptance'] = validate_acceptance(acceptance, cfg['acceptance_minimum_checks'])
        else:
            result['test_success_sha256'] = cfg['test_success_sha256']
        check_pins()
        with (root / (target + '-success.json')).open('x', encoding='utf8') as handle:
            json.dump(result, handle, indent=2)
        phase('completed_success_receipt_written')
        return result
    finally:
        env.pop('PGPASSWORD', None)
        password = None


def gui(config_path, target, allow_production=False):
    import tkinter as tk
    cfg = validate(config_path, target, allow_production)
    cfg['_gui_token'] = uuid.uuid4().hex
    selected = cfg['targets'][target]
    window = tk.Tk()
    window.title('K5 — ' + target.upper() + ' migration'
                 + (' — Direct' if connection_kind(selected) == 'Direct' else ''))
    window.geometry('780x460')
    active = {'running': False}
    tk.Label(window, text='K5 — ' + target.upper(), font=('Segoe UI', 16, 'bold')).pack(pady=12)
    tk.Label(window, text=selected['name'] + '\nProject ref: ' + selected['ref']
             + '\nConnection: ' + connection_kind(selected) + '\nHost: ' + selected['host']).pack()
    tk.Label(window, text='psql 18.6 · reviewed LF SQL · TLS verify-full\nBu projenin database password değerini gir. Web / CRM / archive password kullanılmaz.').pack(pady=12)
    tk.Label(window, text=selected['name'] + ' — database password', font=('Segoe UI', 10, 'bold')).pack()
    entry = tk.Entry(window, show='•', width=58)
    entry.pack(); entry.focus_set()
    confirmed = tk.BooleanVar(value=False)
    tk.Checkbutton(window, text='Hedefi kontrol ettim. Bu işlemi Talip olarak ben başlatıyorum.', variable=confirmed).pack(pady=10)
    status = tk.StringVar(value='Hazır. Henüz database bağlantısı kurulmadı.')
    tk.Label(window, textvariable=status, wraplength=740).pack(pady=10)

    def start():
        if active['running']:
            return
        if not confirmed.get() or not entry.get():
            status.set('Database password ve hedef onayı gerekli.'); return
        password = entry.get()
        entry.delete(0, 'end'); entry.config(state='disabled'); button.config(state='disabled')
        active['running'] = True
        status.set('Read-only kontrol, migration ve test doğrulaması çalışıyor. Otomatik tekrar yok.')

        def work(secret):
            try:
                fresh = validate(config_path, target, allow_production, ready_token=cfg['_gui_token'])
                if fresh != cfg:
                    raise ValueError('DISPLAYED_PLAN_CHANGED_REOPEN_REQUIRED')
                execute(fresh, target, secret)
                message = 'Tamamlandı. Receipt kaydedildi. Pencere açık kalabilir.'
            except Exception as error:
                code = safe_code(error)
                message = code + ' — yeniden başlatma; sonuç önce incelenecek.'
                failure = {'scope': 'K5_OPERATOR_FAILURE', 'target': target, 'code': code,
                           'outcome_may_require_readback': True, 'password_recorded': False, 'automatic_retry': False}
                try:
                    with (Path(cfg['receipt_directory']) / (target + '-failure.json')).open('x', encoding='utf8') as handle:
                        json.dump(failure, handle, indent=2)
                except OSError:
                    pass
            finally:
                secret = None
            def finished():
                active['running'] = False
                status.set(message)
            window.after(0, finished)

        threading.Thread(target=work, args=(password,), daemon=False).start()
        password = None

    button = tk.Button(window, text='K5 ' + target.upper() + ' migration başlat', command=start)
    button.pack(pady=8)
    def close():
        if active['running']:
            status.set('İşlem sürüyor. Sonuç gelene kadar pencereyi açık bırak.')
        else:
            entry.delete(0, 'end'); window.destroy()
    window.protocol('WM_DELETE_WINDOW', close)
    ready = {'scope': 'K5_GUI_READY', 'target': target, 'target_ref': selected['ref'],
             'config_sha256': cfg['_config_sha256'], 'operator_sha256': cfg['_operator_sha256'],
             'window_token': cfg['_gui_token'], 'connection_started': False, 'password_recorded': False}
    with (Path(cfg['receipt_directory']) / 'gui-ready.json').open('x', encoding='utf8') as handle:
        json.dump(ready, handle, indent=2)
    print('K5_GUI_READY_' + target.upper(), flush=True)
    window.mainloop()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--target', choices=['test', 'production'], required=True)
    parser.add_argument('--allow-production', action='store_true')
    parser.add_argument('--validate-only', action='store_true')
    args = parser.parse_args()
    try:
        if args.validate_only:
            config = validate(args.config, args.target, args.allow_production)
            print(json.dumps({'ready': True, 'target': args.target, 'target_ref': config['targets'][args.target]['ref'],
                              'migration_sha256': config['migration_sha256'], 'connection_started': False}))
        else:
            gui(args.config, args.target, args.allow_production)
    except Exception as error:
        print(safe_code(error))
        raise SystemExit(1) from None
