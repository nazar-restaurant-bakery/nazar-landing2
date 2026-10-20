"""Masked, explicit operator for one verified hosted sandbox application reset.

Import and --validate-config are local-only. Only --gui can obtain a password;
only its explicit confirmation can submit the reviewed installer. No password
argument, unattended execution switch, credential file, or automatic retry exists.
The plan compiler and phases 1-4 gate verifier remain authoritative: this module
does not generate DROP statements, infer a staff role, or repair failed gates.
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


VALIDATED_SCOPE = 'K3_HOSTED_APPLICATION_RESET_PLAN_VALIDATED'
RESULT_SCOPE = 'k3_hosted_application_reset'
CONFIRMATION = 'APP RESET'
PHASES = ('legacy_sandbox', 'reviewed_baseline')
EXPECTED_SEED_COUNTS = {'businesses': 1, 'customers': 3, 'signups': 3,
                        'catering_requests': 1, 'offers': 1}
PLAN_VERIFIER = Path(__file__).with_name('hosted-reset-plan.mjs')
INSPECTION_SQL = Path(__file__).with_name('inspect-hosted-readonly.sql')
REQUIRED = ('SANDBOX_PROJECT_REF', 'PRODUCTION_PROJECT_REF', 'SANDBOX_HOST',
            'SANDBOX_PORT', 'SANDBOX_USER', 'SANDBOX_DATABASE',
            'SANDBOX_SSLROOTCERT', 'PG_BIN', 'NODE', 'RESET_PLAN',
            'RESET_PRIVATE_ROOT', 'STAFF_ROLE')


class OperatorError(Exception):
    """Only fixed, non-secret error codes may cross the operator boundary."""


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def local_path(value: str, *, directory=False, private=False) -> Path:
    if not value or value.startswith(('\\\\', '//')):
        raise OperatorError('LOCAL_ABSOLUTE_PATH_REQUIRED')
    path = Path(value)
    if not path.is_absolute() or (not path.is_dir() if directory else not path.is_file()):
        raise OperatorError('LOCAL_PATH_MISSING_OR_INVALID')
    if private:
        for ancestor in (path, *path.parents):
            if ancestor.is_symlink() or bool(getattr(ancestor.stat(), 'st_file_attributes', 0) & 0x400) \
                    or (ancestor.is_dir() and (ancestor / '.git').exists()):
                raise OperatorError('PRIVATE_PATH_LINK_OR_GIT_REFUSED')
    return path.resolve()


def config_for(env=None) -> dict:
    env = os.environ if env is None else env
    cfg = {name: str(env.get('K3_' + name, '')).strip() for name in REQUIRED}
    if not all(cfg.values()):
        raise OperatorError('EXPLICIT_OPERATOR_CONFIG_REQUIRED')
    test_ref, prod_ref = cfg['SANDBOX_PROJECT_REF'], cfg['PRODUCTION_PROJECT_REF']
    if not all(re.fullmatch('[a-z]{20}', x) for x in (test_ref, prod_ref)) or test_ref == prod_ref:
        raise OperatorError('DISTINCT_TEST_AND_PRODUCTION_REFS_REQUIRED')
    if not re.fullmatch(r'aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com', cfg['SANDBOX_HOST']) \
            or cfg['SANDBOX_USER'] != 'postgres.' + test_ref \
            or cfg['SANDBOX_PORT'] != '5432' or cfg['SANDBOX_DATABASE'] != 'postgres':
        raise OperatorError('SANDBOX_SESSION_POOLER_BINDING_REQUIRED')
    if cfg['STAFF_ROLE'] not in ('owner', 'staff'):
        raise OperatorError('EXPLICIT_REVIEWED_STAFF_ROLE_REQUIRED')
    cfg['private_root'] = local_path(cfg['RESET_PRIVATE_ROOT'], directory=True, private=True)
    cfg['plan_path'] = local_path(cfg['RESET_PLAN'], private=True)
    if cfg['private_root'] not in cfg['plan_path'].parents:
        raise OperatorError('PLAN_OUTSIDE_PRIVATE_OPERATOR_ROOT')
    if cfg['plan_path'].suffix != '.json' or cfg['plan_path'].stat().st_size > 1024 * 1024:
        raise OperatorError('PLAN_FILE_INVALID')
    cfg['ca_path'] = local_path(cfg['SANDBOX_SSLROOTCERT'], private=True)
    if cfg['ca_path'].stat().st_size > 1024 * 1024:
        raise OperatorError('TRUSTED_CA_FILE_REQUIRED')
    cfg['ca_sha256'] = digest(cfg['ca_path'])
    cfg['pg_bin'] = local_path(cfg['PG_BIN'], directory=True)
    if not (cfg['pg_bin'] / 'psql.exe').is_file():
        raise OperatorError('EXPLICIT_PSQL_BINARY_REQUIRED')
    cfg['node_path'] = local_path(cfg['NODE'])
    if not PLAN_VERIFIER.is_file():
        raise OperatorError('LOCAL_PLAN_VERIFIER_REQUIRED')
    if not INSPECTION_SQL.is_file():
        raise OperatorError('READ_ONLY_INSPECTION_SOURCE_REQUIRED')
    cfg['inspection_sql_sha256'] = digest(INSPECTION_SQL)
    return cfg


def operating_environment(env=None) -> dict:
    # Do not forward inherited PG*, DATABASE_URL, NODE_OPTIONS, provider keys,
    # app credentials, or unrelated process secrets to either child.
    env = os.environ if env is None else env
    allowed = {'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
               'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'PATHEXT'}
    return {k: v for k, v in env.items() if k.upper() in allowed}


def validated_plan(cfg: dict) -> dict:
    if digest(cfg['ca_path']) != cfg['ca_sha256']:
        raise OperatorError('TRUSTED_CA_CHANGED')
    try:
        result = subprocess.run(
            [str(cfg['node_path']), str(PLAN_VERIFIER), '--validate-plan', str(cfg['plan_path'])],
            env=operating_environment(), capture_output=True, timeout=30, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise OperatorError('LOCAL_PLAN_VALIDATION_UNAVAILABLE') from None
    if result.returncode or len(result.stdout) > 65536:
        raise OperatorError('LOCAL_PLAN_OR_GATES_NOT_READY')
    try:
        value = json.loads(result.stdout)
    except (ValueError, UnicodeError):
        raise OperatorError('PLAN_VALIDATOR_RECEIPT_INVALID') from None
    if not isinstance(value, dict) or value.get('ready') is not True \
            or value.get('scope') != VALIDATED_SCOPE \
            or value.get('expectedTestRef') != cfg['SANDBOX_PROJECT_REF'] \
            or value.get('expectedProdRef') != cfg['PRODUCTION_PROJECT_REF'] \
            or value.get('staffRole') != cfg['STAFF_ROLE'] \
            or value.get('phase') not in PHASES:
        raise OperatorError('PLAN_TARGET_OR_STAFF_ROLE_MISMATCH')
    for key in ('sqlSha256', 'planSha256', 'gatesReceiptSha256'):
        if not isinstance(value.get(key), str) or not re.fullmatch('[0-9a-f]{64}', value[key]):
            raise OperatorError('PLAN_VALIDATOR_HASH_MISSING')
    if digest(cfg['plan_path']) != value['planSha256']:
        raise OperatorError('PLAN_CHANGED')
    sql_path = local_path(str(value.get('sqlPath', '')), private=True)
    if sql_path != cfg['plan_path'].with_suffix('.sql') or sql_path.stat().st_size > 16 * 1024 * 1024 \
            or digest(sql_path) != value['sqlSha256']:
        raise OperatorError('REVIEWED_SQL_CHANGED_OR_OUTSIDE_PLAN')
    value['sql_path'] = sql_path
    return value


def postgres_environment(cfg: dict, password: str, env=None, *, read_only=False) -> dict:
    if not isinstance(password, str) or not password:
        raise OperatorError('DATABASE_PASSWORD_REQUIRED')
    result = operating_environment(env)
    result.update(PGHOST=cfg['SANDBOX_HOST'], PGPORT='5432', PGUSER=cfg['SANDBOX_USER'],
                  PGDATABASE='postgres', PGPASSWORD=password, PGSSLMODE='verify-full',
                  PGSSLROOTCERT=str(cfg['ca_path']), PGCONNECT_TIMEOUT='20',
                  PGCLIENTENCODING='UTF8', PGAPPNAME='k3-hosted-application-reset',
                  PGOPTIONS='-c lock_timeout=5000 -c statement_timeout=120000 '
                            '-c idle_in_transaction_session_timeout=180000 '
                            '-c timezone=UTC -c client_min_messages=error '
                            '-c default_transaction_read_only=' + ('on' if read_only else 'off'))
    return result


def restrict_directory(path: Path):
    if os.name != 'nt':
        path.chmod(0o700)
        return
    try:
        import csv
        import io
        identity = subprocess.run(['whoami', '/user', '/fo', 'csv', '/nh'],
                                  capture_output=True, check=True, timeout=10)
        sid = next(csv.reader(io.StringIO(identity.stdout.decode().strip())))[1]
        if not re.fullmatch('S-[0-9-]+', sid):
            raise ValueError()
        subprocess.run(['icacls', str(path), '/inheritance:r', '/grant:r',
                        '*' + sid + ':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F'],
                       capture_output=True, check=True, timeout=10)
    except Exception:
        raise OperatorError('PRIVATE_OPERATOR_ACL_FAILED_NO_CONNECTION') from None


def private_json(path: Path, value: dict, *, exclusive=False):
    if exclusive:
        with path.open('x', encoding='utf8') as stream:
            json.dump(value, stream, indent=2)
        return
    temporary = path.parent / ('.operator-' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf8') as stream:
        json.dump(value, stream, indent=2)
    os.replace(temporary, path)


def safe_status(cfg: dict, status: str, code=None, attempt=None):
    # Fixed categories and non-secret provenance only. Native output is never
    # copied into a result file, exception, console, or GUI.
    if status not in ('validating', 'blocked', 'submitting', 'completed', 'outcome_unknown'):
        raise OperatorError('STATUS_INVALID')
    private_json(cfg['private_root'] / 'operator-status.json', {
        'status': status, 'error_code': code,
        'updated_at': datetime.now(timezone.utc).isoformat(),
        'sandbox_project_ref': cfg['SANDBOX_PROJECT_REF'],
        'attempt_directory': str(attempt) if attempt else None,
        'password_recorded': False,
    })


def safe_inspection_error(stderr: bytes) -> str:
    text = stderr.decode('utf8', errors='replace').lower()
    categories = (
        (('too many authentication', 'circuit breaker'), 'AUTH_TEMPORARILY_BLOCKED'),
        (('password authentication failed', 'authentication failed', 'wrong password'), 'DATABASE_PASSWORD_REJECTED'),
        (('tenant or user not found', 'tenant not found'), 'PROJECT_BINDING_NOT_FOUND'),
        (('certificate verify failed', 'root certificate file', 'server certificate', 'ssl error'), 'TLS_VERIFY_FAILED'),
        (('could not translate host', 'could not resolve', 'name or service not known', 'getaddrinfo'), 'DNS_FAILED'),
        (('access is denied', 'permission denied to create socket', 'operation not permitted'), 'NETWORK_ACCESS_DENIED'),
        (('timeout', 'timed out'), 'CONNECTION_TIMEOUT'),
        (('connection refused', 'network is unreachable', 'no route to host'), 'CONNECTION_UNAVAILABLE'),
        (('permission denied', 'must be owner', 'insufficient privilege'), 'READ_PERMISSION_DENIED'),
    )
    for phrases, category in categories:
        if any(phrase in text for phrase in phrases):
            return category
    return 'READ_ONLY_INSPECTION_FAILED'


def inspection_status(cfg: dict, state: str, *, attempt=None, code=None, connected=False):
    if state not in ('starting', 'querying', 'completed', 'failed') \
            or code is not None and not re.fullmatch('[A-Z_]+', code):
        raise OperatorError('INSPECTION_STATUS_INVALID')
    value = {'scope': 'K3_OPERATOR_READ_ONLY_INSPECTION_STATUS', 'state': state,
             'error_code': code, 'updated_at': datetime.now(timezone.utc).isoformat(),
             'sandbox_project_ref': cfg['SANDBOX_PROJECT_REF'],
             'attempt_directory': str(attempt) if attempt else None,
             'database_process_started': connected, 'application_write_performed': False,
             'password_recorded': False, 'native_stderr_recorded': False}
    private_json(cfg['private_root'] / 'operator-inspection-status.json', value)
    if attempt is not None:
        private_json(attempt / 'read-only-status.json', value)


def gui_control_state(*, plan_ready: bool, inspected: bool, confirmed: bool,
                      held_password: bool, entered_password: bool, busy: bool, attempted: bool) -> dict:
    inspect_enabled = entered_password and not busy and not attempted
    if attempted:
        hint = 'Reset denendi; sonuç kontrol edilmeden yeniden başlatılmaz.'
    elif busy:
        hint = 'İşlem sürüyor; tamamlanmasını bekleyin.'
    elif not inspected:
        hint = 'Önce password alanını doldurup 1. Yalnız read-only kontrol düğmesine basın.'
    elif not plan_ready:
        hint = 'Read-only kontrol var; yerel plan/kanıt kontrolü henüz hazır değil.'
    elif not held_password:
        hint = 'Password oturumu sona erdi; 1. read-only kontrolü yeniden yapın.'
    elif not confirmed:
        hint = 'Read-only kontrol tamam; hedef ve kapsam onay kutusunu işaretleyin.'
    else:
        hint = '2. Sandbox application reset başlat düğmesi hazır.'
    return {'inspect_enabled': inspect_enabled,
            'reset_enabled': plan_ready and inspected and confirmed and held_password and not busy and not attempted,
            'hint': hint}


def parse_success(stdout: bytes, cfg: dict, plan: dict) -> dict:
    if len(stdout) > 65536:
        raise OperatorError('RESET_RESULT_REQUIRES_READ_ONLY_VERIFICATION')
    lines = [x.strip() for x in stdout.splitlines() if x.strip()]
    if len(lines) != 1:
        raise OperatorError('RESET_RESULT_REQUIRES_READ_ONLY_VERIFICATION')
    try:
        value = json.loads(lines[0])
    except (ValueError, UnicodeError):
        raise OperatorError('RESET_RESULT_REQUIRES_READ_ONLY_VERIFICATION') from None
    if not isinstance(value, dict) or value.get('scope') != RESULT_SCOPE \
            or value.get('reset_completed') is not True \
            or value.get('staff_identity_preserved') is not True \
            or value.get('staff_active_preserved') is not True \
            or value.get('auth_identity_exported') is not False \
            or value.get('managed_platform_preserved') is not True \
            or value.get('real_auth_rest_verified') is not False \
            or value.get('expected_test_ref') != cfg['SANDBOX_PROJECT_REF'] \
            or value.get('configured_staff_role') != cfg['STAFF_ROLE'] \
            or value.get('phase') not in PHASES or value.get('phase') != plan.get('phase') \
            or not isinstance(value.get('application_catalog_md5'), str) \
            or not re.fullmatch('[0-9a-f]{32}', value['application_catalog_md5']):
        raise OperatorError('RESET_RESULT_REQUIRES_READ_ONLY_VERIFICATION')
    counts = value.get('seed_counts')
    if not isinstance(counts, dict) or set(counts) != set(EXPECTED_SEED_COUNTS) \
            or any(type(counts[name]) is not int or counts[name] != expected
                   for name, expected in EXPECTED_SEED_COUNTS.items()):
        raise OperatorError('RESET_RESULT_REQUIRES_READ_ONLY_VERIFICATION')
    # Do not preserve arbitrary fields: the server output must not cause a
    # principal identifier, message, SQL body, or credential to enter a log.
    return {'scope': RESULT_SCOPE, 'reset_completed': True,
            'expected_test_ref': value['expected_test_ref'], 'phase': value['phase'],
            'application_catalog_md5': value['application_catalog_md5'],
            'configured_staff_role': value['configured_staff_role'],
            'staff_identity_preserved': True, 'staff_active_preserved': True,
            'auth_identity_exported': False, 'managed_platform_preserved': True,
            'real_auth_rest_verified': False, 'seed_counts': dict(counts)}


def inspect_read_only(cfg: dict, password: str) -> dict:
    """Explicit GUI stage only: catalog SELECT, never an application call/write."""
    if digest(cfg['ca_path']) != cfg['ca_sha256'] \
            or digest(INSPECTION_SQL) != cfg['inspection_sql_sha256']:
        raise OperatorError('READ_ONLY_INPUT_CHANGED')
    sql = INSPECTION_SQL.read_bytes()
    attempt = cfg['private_root'] / ('inspect_' + datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
                                     + '_' + uuid.uuid4().hex[:12])
    attempt.mkdir(exist_ok=False)
    env = None
    restricted = False
    process_started = False
    try:
        restrict_directory(attempt)
        restricted = True
        inspection_status(cfg, 'starting', attempt=attempt)
        env = postgres_environment(cfg, password, read_only=True)
        args = [str(cfg['pg_bin'] / 'psql.exe'), '--no-password', '--no-psqlrc',
                '--quiet', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1', '--file=-']
        inspection_status(cfg, 'querying', attempt=attempt)
        process_started = True
        result = subprocess.run(args, input=sql, env=env, capture_output=True, timeout=180, check=False)
        if result.returncode:
            raise OperatorError(safe_inspection_error(result.stderr))
        if len(result.stdout) > 8 * 1024 * 1024:
            raise OperatorError('READ_ONLY_INSPECTION_FAILED')
        try:
            value = json.loads(result.stdout)
        except (ValueError, UnicodeError):
            raise OperatorError('READ_ONLY_INSPECTION_RECEIPT_INVALID') from None
        if not isinstance(value, dict) \
                or value.get('scope') != 'approved_sandbox_read_only_metadata_not_install_or_restore' \
                or value.get('transaction_read_only') != 'on' \
                or value.get('auth_identities_included') is not False \
                or value.get('function_bodies_included') is not False:
            raise OperatorError('READ_ONLY_INSPECTION_SCOPE_INVALID')
        output = attempt / 'read-only-metadata.json'
        private_json(output, value, exclusive=True)
        proof = {'scope': 'K3_OPERATOR_READ_ONLY_INSPECTION',
                 'sandbox_project_ref': cfg['SANDBOX_PROJECT_REF'],
                 'captured_at': datetime.now(timezone.utc).isoformat(),
                 'metadata_path': str(output), 'metadata_sha256': digest(output),
                 'inspection_sql_sha256': cfg['inspection_sql_sha256'],
                 'password_recorded': False, 'application_write_performed': False}
        private_json(attempt / 'inspection-proof.json', proof, exclusive=True)
        inspection_status(cfg, 'completed', attempt=attempt, connected=True)
        return proof
    except OperatorError as error:
        inspection_status(cfg, 'failed', attempt=attempt if restricted else None,
                          code=str(error), connected=process_started)
        raise
    except (OSError, subprocess.TimeoutExpired) as error:
        code = 'CONNECTION_TIMEOUT' if isinstance(error, subprocess.TimeoutExpired) else 'LOCAL_POSTGRES_START_FAILED'
        if isinstance(error, OSError):
            process_started = False
        inspection_status(cfg, 'failed', attempt=attempt if restricted else None,
                          code=code, connected=process_started)
        raise OperatorError(code) from None
    finally:
        if env is not None:
            env.pop('PGPASSWORD', None)


def validate_inspection(cfg: dict, inspection: dict):
    if not isinstance(inspection, dict) or inspection.get('scope') != 'K3_OPERATOR_READ_ONLY_INSPECTION' \
            or inspection.get('sandbox_project_ref') != cfg['SANDBOX_PROJECT_REF'] \
            or inspection.get('inspection_sql_sha256') != cfg['inspection_sql_sha256'] \
            or inspection.get('password_recorded') is not False \
            or inspection.get('application_write_performed') is not False:
        raise OperatorError('EXPLICIT_READ_ONLY_INSPECTION_REQUIRED')
    try:
        stamp = datetime.fromisoformat(inspection['captured_at'])
        age = (datetime.now(timezone.utc) - stamp).total_seconds()
    except (KeyError, ValueError, TypeError):
        raise OperatorError('READ_ONLY_INSPECTION_RECEIPT_INVALID') from None
    if age < 0 or age > 600:
        raise OperatorError('READ_ONLY_INSPECTION_STALE')
    path = local_path(str(inspection.get('metadata_path', '')), private=True)
    if cfg['private_root'] not in path.parents or digest(path) != inspection.get('metadata_sha256'):
        raise OperatorError('READ_ONLY_INSPECTION_CHANGED')


def operate(cfg: dict, password: str, confirmation: str, displayed_plan: dict, inspection: dict) -> dict:
    if confirmation != CONFIRMATION:
        raise OperatorError('EXPLICIT_APPLICATION_RESET_CONFIRMATION_REQUIRED')
    if not isinstance(password, str) or not password:
        raise OperatorError('DATABASE_PASSWORD_REQUIRED')
    validate_inspection(cfg, inspection)
    current = validated_plan(cfg)
    for name in ('planSha256', 'sqlSha256', 'gatesReceiptSha256'):
        if current[name] != displayed_plan.get(name):
            raise OperatorError('DISPLAYED_PLAN_CHANGED_NO_CONNECTION')
    # A used plan is never resubmitted automatically, including after a dropped
    # connection. Read-only reconciliation and a new reviewed plan are required.
    claim = cfg['private_root'] / ('attempt-' + current['planSha256'] + '.json')
    try:
        private_json(claim, {'plan_sha256': current['planSha256'],
                            'started_at': datetime.now(timezone.utc).isoformat(),
                            'automatic_retry_forbidden': True}, exclusive=True)
    except FileExistsError:
        raise OperatorError('PLAN_ALREADY_ATTEMPTED_READ_ONLY_RECONCILIATION_REQUIRED') from None
    attempt = cfg['private_root'] / ('run_' + datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
                                     + '_' + uuid.uuid4().hex[:12])
    attempt.mkdir(exist_ok=False)
    restrict_directory(attempt)
    safe_status(cfg, 'validating', attempt=attempt)
    env = None
    submitted = False
    process = None
    try:
        # This second fresh validator checks every receipt again immediately
        # before a network-capable process can be started.
        final = validated_plan(cfg)
        validate_inspection(cfg, inspection)
        if any(final[k] != current[k] for k in ('planSha256', 'sqlSha256', 'gatesReceiptSha256')):
            raise OperatorError('PLAN_OR_GATES_CHANGED_NO_CONNECTION')
        sql = final['sql_path'].read_bytes()
        if hashlib.sha256(sql).hexdigest() != final['sqlSha256']:
            raise OperatorError('REVIEWED_SQL_CHANGED_NO_CONNECTION')
        env = postgres_environment(cfg, password)
        password = None  # Python strings cannot promise forensic memory zeroing.
        args = [str(cfg['pg_bin'] / 'psql.exe'), '--no-password', '--no-psqlrc',
                '--quiet', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1', '--file=-']
        safe_status(cfg, 'submitting', attempt=attempt)
        process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, env=env)
        submitted = True
        try:
            stdout, _stderr = process.communicate(input=sql, timeout=240)
        except subprocess.TimeoutExpired:
            process.kill()
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            raise OperatorError('RESET_OUTCOME_UNKNOWN_NO_RETRY') from None
        if process.returncode:
            # Failure can occur after COMMIT or after a lost acknowledgement.
            # Never turn a nonzero exit into a rollback/success claim.
            raise OperatorError('RESET_OUTCOME_UNKNOWN_NO_RETRY')
        receipt = parse_success(stdout, cfg, final)
        proof = dict(receipt, completed_at=datetime.now(timezone.utc).isoformat(),
                     plan_sha256=final['planSha256'], sql_sha256=final['sqlSha256'],
                     gates_receipt_sha256=final['gatesReceiptSha256'],
                     target_project_ref=cfg['SANDBOX_PROJECT_REF'],
                     staff_role=cfg['STAFF_ROLE'], password_recorded=False,
                     prior_read_only_metadata_sha256=inspection['metadata_sha256'],
                     independent_read_only_readback_pending=True,
                     hosted_auth_rest_acceptance_pending=True)
        private_json(attempt / 'operator-result.json', proof, exclusive=True)
        safe_status(cfg, 'completed', attempt=attempt)
        return proof
    except OperatorError as error:
        safe_status(cfg, 'outcome_unknown' if submitted else 'blocked', str(error), attempt)
        raise
    except Exception:
        code = 'RESET_OUTCOME_UNKNOWN_NO_RETRY' if submitted else 'LOCAL_OPERATOR_FAILED_NO_RETRY'
        safe_status(cfg, 'outcome_unknown' if submitted else 'blocked', code, attempt)
        raise OperatorError(code) from None
    finally:
        if env is not None:
            env.pop('PGPASSWORD', None)
        password = None
        if process is not None and process.poll() is None:
            process.kill()


def launch_gui():
    import tkinter as tk
    from tkinter import ttk
    cfg = config_for()
    window = tk.Tk()
    window.title('K3 — Sandbox application reset')
    window.geometry('780x710')
    panel = ttk.Frame(window, padding=20)
    panel.pack(fill='both', expand=True)
    ttk.Label(panel, text='Yalnız sandbox application reset', font=('Segoe UI', 16, 'bold')).pack(anchor='w')
    target = ('Project ref: ' + cfg['SANDBOX_PROJECT_REF'] + '\nHost: ' + cfg['SANDBOX_HOST']
              + '\nUser: ' + cfg['SANDBOX_USER'] + '\nYeni şemadaki staff role: ' + cfg['STAFF_ROLE'])
    ttk.Label(panel, text=target, wraplength=730).pack(anchor='w', pady=12)
    ttk.Label(panel, text='Auth/storage korunur. Yalnız reviewed application nesneleri reset edilir. '
              'Bağlantı kaybolursa otomatik tekrar yapılmaz.', wraplength=730).pack(anchor='w', pady=6)
    plan_status = tk.StringVar(value='Yerel plan ve 1–4 kanıtları kontrol ediliyor.')
    status = tk.StringVar(value='Read-only kontrol henüz başlatılmadı.')
    next_action = tk.StringVar(value='')
    accepted = tk.BooleanVar(value=False)
    ttk.Label(panel, text='Sandbox database password (gizli)').pack(anchor='w', pady=(10, 0))
    password_entry = ttk.Entry(panel, show='●', width=65)
    password_entry.pack(anchor='w', pady=5)
    ttk.Label(panel, text='Password sohbete veya dosyaya yazılmaz; web/CRM/archive password değil.',
              wraplength=730).pack(anchor='w')
    checkbox = ttk.Checkbutton(panel, variable=accepted,
        text='Gösterilen sandbox hedefini, staff role ve application reset kapsamını kontrol ettim.')
    checkbox.pack(anchor='w', pady=12)
    ttk.Label(panel, textvariable=plan_status, wraplength=730).pack(anchor='w', pady=(10, 4))
    ttk.Label(panel, textvariable=status, wraplength=730).pack(anchor='w', pady=4)
    ttk.Label(panel, textvariable=next_action, wraplength=730).pack(anchor='w', pady=4)
    displayed = None
    inspection = None
    held_password = None
    busy = False
    attempted = False

    def update_button(*_):
        controls = gui_control_state(plan_ready=displayed is not None, inspected=inspection is not None,
                                     confirmed=accepted.get(), held_password=bool(held_password),
                                     entered_password=bool(password_entry.get()), busy=busy, attempted=attempted)
        start_button.configure(state='normal' if controls['reset_enabled'] else 'disabled')
        inspect_button.configure(state='normal' if controls['inspect_enabled'] else 'disabled')
        next_action.set(controls['hint'])

    def refresh():
        nonlocal displayed
        if busy or attempted:
            return
        try:
            displayed = validated_plan(cfg)
            plan_status.set('Plan ve 1–4 kanıtları doğrulandı. SQL SHA256: ' + displayed['sqlSha256'])
        except OperatorError as error:
            displayed = None
            plan_status.set('Yerel plan hazır değil: ' + str(error) + '.')
        update_button()

    def finish(message):
        nonlocal busy
        busy = False
        status.set(message)
        if not attempted:
            for control in (refresh_button, password_entry, checkbox):
                control.configure(state='normal')
        update_button()

    def expire_secret():
        nonlocal held_password, inspection
        if busy:
            return
        held_password, inspection = None, None
        if not attempted:
            status.set('Read-only kontrolün süresi doldu. Password yeniden girilip kontrol tekrarlanmalı.')
        update_button()

    def inspected(result, secret):
        nonlocal held_password, inspection
        held_password, inspection = secret, result
        finish('Read-only metadata kontrolü tamamlandı; application verisi değiştirilmedi. '
               'Aynı password yalnız bu pencerenin belleğinde en fazla 10 dakika tutulur. '
               'Plan hazırsa hedef kutusunu işaretleyip application reset düğmesine basabilirsiniz.')
        refresh()
        window.after(600000, expire_secret)

    def start_inspection():
        nonlocal busy, held_password, inspection
        if busy or attempted:
            return
        secret = password_entry.get()
        password_entry.delete(0, 'end')
        held_password, inspection = None, None
        if not secret:
            return
        busy = True
        for control in (start_button, inspect_button, refresh_button, password_entry, checkbox):
            control.configure(state='disabled')
        status.set('Yalnız read-only metadata kontrolü çalışıyor; application reset başlamadı.')

        def work():
            try:
                result = inspect_read_only(cfg, secret)
                window.after(0, lambda: inspected(result, secret))
            except OperatorError as error:
                message = str(error) + '. Application reset başlamadı.'
                window.after(0, lambda: finish(message))
            except Exception:
                window.after(0, lambda: finish('READ_ONLY_INSPECTION_FAILED. Application reset başlamadı.'))

        threading.Thread(target=work, daemon=True).start()

    def start():
        nonlocal busy, attempted, held_password
        update_button()
        if displayed is None or inspection is None or busy or attempted or not accepted.get():
            return
        secret, held_password = held_password, None
        if not secret:
            return
        busy, attempted = True, True
        for control in (start_button, inspect_button, refresh_button, password_entry, checkbox):
            control.configure(state='disabled')
        status.set('Sandbox application reset çalışıyor. Pencereyi açık bırakın.')

        def work():
            try:
                operate(cfg, secret, CONFIRMATION, displayed, inspection)
                message = 'İşlem yanıtı alındı. Codex bağımsız read-only kontrol ve Auth/REST testlerini tamamlayacak.'
            except OperatorError as error:
                message = str(error) + '. Tekrar başlatmayın; önce read-only kontrol gerekir.'
            except Exception:
                message = 'LOCAL_OPERATOR_FAILED_NO_RETRY. Önce read-only kontrol gerekir.'
            window.after(0, lambda: finish(message))

        threading.Thread(target=work, daemon=True).start()

    inspect_button = ttk.Button(panel, text='1. Yalnız read-only kontrol', command=start_inspection, state='disabled')
    inspect_button.pack(anchor='w', pady=4)
    refresh_button = ttk.Button(panel, text='Yerel kanıtları tekrar kontrol et', command=refresh)
    refresh_button.pack(anchor='w', pady=4)
    start_button = ttk.Button(panel, text='2. Sandbox application reset başlat', command=start, state='disabled')
    start_button.pack(anchor='w', pady=4)
    accepted.trace_add('write', update_button)
    password_entry.bind('<KeyRelease>', update_button)

    def close():
        nonlocal held_password, inspection
        if busy:
            status.set('İşlem sürüyor; pencereyi açık bırakın.')
        else:
            held_password, inspection = None, None
            window.destroy()

    window.protocol('WM_DELETE_WINDOW', close)
    refresh()
    window.mainloop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--gui', action='store_true')
    action.add_argument('--validate-config', action='store_true')
    args = parser.parse_args()
    if args.gui:
        launch_gui()
    elif args.validate_config:
        cfg = config_for()
        checked = validated_plan(cfg)
        print(json.dumps({'ready': True, 'scope': 'LOCAL_OPERATOR_VALIDATED_NO_CONNECTION',
                          'sandbox_project_ref': cfg['SANDBOX_PROJECT_REF'],
                          'staff_role': cfg['STAFF_ROLE'], 'sql_sha256': checked['sqlSha256'],
                          'database_connection_started': False}))
    else:
        parser.print_help()


if __name__ == '__main__':
    try:
        main()
    except OperatorError as error:
        print(str(error))
        raise SystemExit(2)
    except Exception:
        print('LOCAL_OPERATOR_FAILED_NO_DETAILS_PRINTED')
        raise SystemExit(2)
