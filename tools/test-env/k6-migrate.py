"""K6 human operator backend. Credentials arrive only through a private stdin pipe.

No prompt, GUI, connection, retry, account action or migration occurs on import.
PowerShell 7 owns the masked human prompt; psql receives an ephemeral child env.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

APPROVED_MIGRATION_SHA256 = 'a772efa90eed339e298c373af43e8090952da7f0cea8f8ecb06c68cbec11663c'
MIGRATION_NAME = '20261020000800_message_send_gate.sql'
ACCEPTANCE_SCOPE = 'K6_SYNTHETIC_ROLLBACK_DB_ACCEPTANCE'
SCOPE = 'K6_HUMAN_PSQL_MIGRATION'
PSQL_VERSION = 'psql (PostgreSQL) 18.6'
K5_SUPPORT_SHA256 = 'e7ef8b71b2cb4352c10839194e4520a737b83f7ec54ab84af7005ba8d130e462'
DEPENDENCIES = {
    3: '3204eab72b8b0a9dc64eefc2f02d05ff0fde7a96489e010eb125896347007fa4',
    4: '5f68772059d9cd1e1d7a6a290aa31ee32d10ff5a367201577c4058861aada4a8',
}
HASH = re.compile(r'[0-9a-f]{64}')
UUID = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', re.I)
ROOT = Path(__file__).resolve().parent
SUPPORT = ROOT / 'k5-migrate.py'
LAUNCHER = ROOT / 'k6-run.ps1'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


if sha(SUPPORT) != K5_SUPPORT_SHA256:
    raise RuntimeError('K6_REVIEWED_SUPPORT_REQUIRED')
_spec = importlib.util.spec_from_file_location('k6_reviewed_k5_helpers', SUPPORT)
_k5 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_k5)
source_bytes = _k5.source_bytes
clean_environment = _k5.clean_environment
classify_psql_error = _k5.classify_psql_error

SAFE = frozenset('''K6_STOP_RESULT_REVIEW_REQUIRED K6_FINAL_REVIEW_HASH_REQUIRED
K6_CONFIG_INVALID K6_LOCAL_ABSOLUTE_FILES_REQUIRED K6_DIRECT_TARGET_REQUIRED
K6_DEPENDENCY_RECEIPTS_REQUIRED K6_TEST_SUCCESS_REQUIRED K6_FRESH_RECEIPTS_REQUIRED
K6_HUMAN_PRODUCTION_FLAG_REQUIRED K6_PSQL_AND_CA_PINS_REQUIRED K6_TOOL_VERSION_REQUIRED
K6_PREFLIGHT_FAILED K6_ACCEPTANCE_FAILED K6_DISPLAYED_PLAN_CHANGED K6_SOURCE_CHANGED
K6_DEADLINE_EXCEEDED K6_TIMEOUT_OUTCOME_REVIEW_REQUIRED K6_PROCESS_FAILED
K6_HUMAN_STDIN_HANDOFF_REQUIRED K6_REVIEWED_SUPPORT_REQUIRED
AUTH_REJECTED TARGET_NOT_FOUND TLS_VERIFICATION_FAILED DNS_HOST_NOT_FOUND
NETWORK_UNREACHABLE DATABASE_PERMISSION_REJECTED PSQL_FAILED_STOP_NO_RETRY
REVIEWED_SOURCE_REQUIRED LF_SOURCE_HASH_MISMATCH REVIEWED_TRANSACTION_SQL_REQUIRED'''.split())


def stop(code):
    raise ValueError(code)


def safe_code(error):
    return str(error) if str(error) in SAFE else 'K6_STOP_RESULT_REVIEW_REQUIRED'


def local_file(value):
    if not isinstance(value, str) or value.startswith(('\\\\', '//')):
        stop('K6_LOCAL_ABSOLUTE_FILES_REQUIRED')
    path = Path(value)
    if not path.is_absolute() or not path.is_file():
        stop('K6_LOCAL_ABSOLUTE_FILES_REQUIRED')
    return path


def pinned_json(path, digest):
    file = local_file(path)
    if not isinstance(digest, str) or not HASH.fullmatch(digest) or sha(file) != digest:
        stop('K6_DEPENDENCY_RECEIPTS_REQUIRED')
    return json.loads(file.read_text(encoding='utf8'))


def dependencies(cfg, target):
    # K7 has no dedicated historical receipt schema. Pin the reviewed sources;
    # actual installation is separately checked through read-only catalogues.
    entries = cfg['dependency_sources']
    if not isinstance(entries, list) or len(entries) != 2:
        stop('K6_DEPENDENCY_RECEIPTS_REQUIRED')
    seen = []
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {'order', 'path', 'sha256'}:
            stop('K6_DEPENDENCY_RECEIPTS_REQUIRED')
        order = entry['order']
        if type(order) is not int or order not in DEPENDENCIES:
            stop('K6_DEPENDENCY_RECEIPTS_REQUIRED')
        if entry['sha256'] != DEPENDENCIES[order]:
            stop('K6_DEPENDENCY_RECEIPTS_REQUIRED')
        local_file(entry['path']); source_bytes(entry['path'], entry['sha256'], b'COMMIT;')
        seen.append(order)
    if seen != [3, 4]:
        stop('K6_DEPENDENCY_RECEIPTS_REQUIRED')
    return [entry['sha256'] for entry in entries]


def evidence(cfg, target):
    values = cfg.get('dependency_evidence', {}).get(target, [])
    if not isinstance(values, list) or len(values) > 20:
        stop('K6_DEPENDENCY_RECEIPTS_REQUIRED')
    for item in values:
        if not isinstance(item, dict) or set(item) != {'path', 'sha256'}:
            stop('K6_DEPENDENCY_RECEIPTS_REQUIRED')
        if not HASH.fullmatch(str(item['sha256'])) or sha(local_file(item['path'])) != item['sha256']:
            stop('K6_DEPENDENCY_RECEIPTS_REQUIRED')
    return [item['sha256'] for item in values]


def acceptance(value, minimum):
    checks = value.get('checks') if isinstance(value, dict) else None
    if (not isinstance(value, dict) or value.get('scope') != ACCEPTANCE_SCOPE
        or not isinstance(checks, list) or len(checks) < minimum
        or any(not isinstance(c, dict) or set(c) != {'name', 'passed'}
               or not isinstance(c['name'], str) or not re.fullmatch(r'[a-z0-9_]{1,120}', c['name'])
               or c['passed'] is not True for c in checks)
        or len({c['name'] for c in checks}) != len(checks)
        or type(value.get('passed')) is not int or value['passed'] != len(checks)
        or type(value.get('failed')) is not int or value['failed'] != 0
        or value.get('missing') != [] or type(value.get('provider_calls')) is not int or value['provider_calls'] != 0
        or type(value.get('real_sends')) is not int or value['real_sends'] != 0
        or type(value.get('account_operations')) is not int or value['account_operations'] != 0
        or value.get('auth_http_claimed') is not False
        or value.get('fixtures_rolled_back') is not True):
        stop('K6_ACCEPTANCE_FAILED')
    return {key: value[key] for key in ('scope', 'checks', 'passed', 'failed', 'missing',
                                      'provider_calls', 'real_sends', 'account_operations',
                                      'auth_http_claimed', 'fixtures_rolled_back')}


def test_success(cfg):
    proof = pinned_json(cfg.get('test_success_path'), cfg.get('test_success_sha256'))
    expected = {'scope': SCOPE, 'status': 'completed', 'target': 'test',
        'target_ref': cfg['targets']['test']['ref'], 'business_id': cfg['targets']['test']['business_id'],
        'migration_sha256': cfg['migration_sha256'],
        'acceptance_sha256': cfg['acceptance_sha256'], 'psql_version': PSQL_VERSION,
        'psql_binary_sha256': cfg['psql_binary_sha256'], 'ca_sha256': cfg['ca_sha256'],
        'python_sha256': cfg['python_sha256'],
        'operator_sha256': cfg['_operator_sha256'], 'launcher_sha256': cfg['_launcher_sha256'],
        'support_sha256': K5_SUPPORT_SHA256, 'password_recorded': False, 'automatic_retry': False}
    if not isinstance(proof, dict) or any(proof.get(k) != v for k, v in expected.items()):
        stop('K6_TEST_SUCCESS_REQUIRED')
    preflight(proof.get('preflight'), 'test')
    acceptance(proof.get('acceptance'), cfg['acceptance_minimum_checks'])
    if (proof.get('dependency_source_sha256') != dependencies(cfg, 'test')
        or proof.get('dependency_evidence_sha256') != evidence(cfg, 'test')):
        stop('K6_TEST_SUCCESS_REQUIRED')


def validate(path, target, allow_production=False):
    if target not in ('test', 'production'):
        stop('K6_CONFIG_INVALID')
    if target == 'production' and not allow_production:
        stop('K6_HUMAN_PRODUCTION_FLAG_REQUIRED')
    file = local_file(str(path))
    cfg = json.loads(file.read_text(encoding='utf8'))
    required = {'migration', 'migration_sha256', 'acceptance', 'acceptance_sha256', 'acceptance_minimum_checks',
        'psql_path', 'psql_binary_sha256', 'psql_version', 'ca_path', 'ca_sha256', 'receipt_directory',
        'targets', 'dependency_sources', 'python_path', 'python_sha256'}
    if not isinstance(cfg, dict) or not required.issubset(cfg) or set(cfg) - required - {'test_success_path', 'test_success_sha256', 'dependency_evidence'}:
        stop('K6_CONFIG_INVALID')
    if not APPROVED_MIGRATION_SHA256 or not HASH.fullmatch(APPROVED_MIGRATION_SHA256):
        stop('K6_FINAL_REVIEW_HASH_REQUIRED')
    if cfg['migration_sha256'] != APPROVED_MIGRATION_SHA256 or Path(cfg['migration']).name != MIGRATION_NAME:
        stop('K6_FINAL_REVIEW_HASH_REQUIRED')
    for key, ending in (('migration', b'COMMIT;'), ('acceptance', b'ROLLBACK;')):
        local_file(cfg[key]); source_bytes(cfg[key], cfg[key + '_sha256'], ending)
    if type(cfg['acceptance_minimum_checks']) is not int or not 1 <= cfg['acceptance_minimum_checks'] <= 200:
        stop('K6_CONFIG_INVALID')
    if not isinstance(cfg['targets'], dict) or set(cfg['targets']) != {'test', 'production'}:
        stop('K6_DIRECT_TARGET_REQUIRED')
    for selected in cfg['targets'].values():
        if (not isinstance(selected, dict) or set(selected) != {'name', 'ref', 'host', 'port', 'business_id'}
            or not isinstance(selected['name'], str) or not 1 <= len(selected['name']) <= 120
            or not re.fullmatch(r'[a-z]{20}', str(selected['ref']))
            or selected['host'] != 'db.' + selected['ref'] + '.supabase.co'
            or type(selected['port']) is not int or selected['port'] != 5432
            or not UUID.fullmatch(str(selected['business_id']))):
            stop('K6_DIRECT_TARGET_REQUIRED')
    if cfg['targets']['test']['ref'] == cfg['targets']['production']['ref']:
        stop('K6_DIRECT_TARGET_REQUIRED')
    if ('dependency_evidence' in cfg and (not isinstance(cfg['dependency_evidence'], dict)
        or set(cfg['dependency_evidence']) != {'test', 'production'})):
        stop('K6_DEPENDENCY_RECEIPTS_REQUIRED')
    for key, digest in (('psql_path', 'psql_binary_sha256'), ('ca_path', 'ca_sha256'), ('python_path', 'python_sha256')):
        local_file(cfg[key])
        if not isinstance(cfg[digest], str) or not HASH.fullmatch(cfg[digest]) or sha(cfg[key]) != cfg[digest]:
            stop('K6_PSQL_AND_CA_PINS_REQUIRED')
    if Path(cfg['psql_path']).name.lower() != 'psql.exe' or cfg['psql_version'] != PSQL_VERSION:
        stop('K6_TOOL_VERSION_REQUIRED')
    receipt = Path(cfg['receipt_directory'])
    if not receipt.is_absolute() or str(receipt).startswith(('\\\\', '//')) or not receipt.is_dir() or any(receipt.iterdir()):
        stop('K6_FRESH_RECEIPTS_REQUIRED')
    cfg.update(_config_path=str(file), _config_sha256=sha(file), _operator_sha256=sha(__file__),
               _launcher_sha256=sha(LAUNCHER), _allow_production=allow_production)
    cfg['_dependencies'] = dependencies(cfg, target)
    cfg['_evidence'] = evidence(cfg, target)
    if target == 'production':
        test_success(cfg)
    result = subprocess.run([cfg['psql_path'], '--version'], env=clean_environment(), capture_output=True, timeout=10, check=False)
    if result.returncode or result.stdout.decode('utf8', errors='replace').strip() != PSQL_VERSION:
        stop('K6_TOOL_VERSION_REQUIRED')
    return cfg


def plan(cfg, target):
    selected = cfg['targets'][target]
    value = {'scope': 'K6_OPERATOR_PLAN', 'target': target, 'name': selected['name'], 'ref': selected['ref'],
        'host': selected['host'], 'port': selected['port'], 'user': 'postgres', 'connection': 'Direct',
        'config_sha256': cfg['_config_sha256'], 'operator_sha256': cfg['_operator_sha256'],
        'launcher_sha256': cfg['_launcher_sha256'], 'support_sha256': K5_SUPPORT_SHA256,
        'migration_sha256': cfg['migration_sha256'], 'acceptance_sha256': cfg['acceptance_sha256'],
        'psql_binary_sha256': cfg['psql_binary_sha256'], 'ca_sha256': cfg['ca_sha256'],
        'python_sha256': cfg['python_sha256'],
        'dependency_source_sha256': cfg['_dependencies'], 'dependency_evidence_sha256': cfg['_evidence'],
        'connection_started': False, 'password_recorded': False}
    value['plan_sha256'] = hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return value


def preflight_sql(selected):
    business = selected['business_id']  # validated UUID only
    return f"""BEGIN READ ONLY;
SELECT jsonb_build_object('scope','K6_READ_ONLY_PREFLIGHT','read_only',current_setting('transaction_read_only')='on',
 'read_committed',current_setting('transaction_isolation')='read committed',
 'database',current_database(),'business_count',(SELECT count(*) FROM core.businesses WHERE id='{business}'::uuid),
 'business_marked_test',(SELECT coalesce((to_jsonb(b)->>'is_test')::boolean,false) FROM core.businesses b WHERE id='{business}'::uuid),
 'all_businesses_test',(SELECT coalesce(bool_and(coalesce((to_jsonb(b)->>'is_test')::boolean,false)),false) FROM core.businesses b),
 'core_closed',NOT(has_schema_privilege('anon','core','USAGE') OR has_schema_privilege('authenticated','core','USAGE') OR has_schema_privilege('service_role','core','USAGE')),
 'k4_guard',to_regprocedure('core.guard_email_suppression_v1()') IS NOT NULL,
 'k5_guard',to_regprocedure('core.klaviyo_profile_sync_eligible_v1(uuid,uuid)') IS NOT NULL,
 'customers_rls',(SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('core.customers')),
 'replication_origin',current_setting('session_replication_role')='origin',
 'dependency_tables',(SELECT count(*)=8 AND bool_and(relrowsecurity) FROM pg_class WHERE oid IN
  (to_regclass('core.ops_metrics'),to_regclass('core.ops_actions'),to_regclass('core.ops_connections'),
   to_regclass('core.orders'),to_regclass('core.order_items'),to_regclass('core.payments'),to_regclass('core.refunds'),to_regclass('core.order_match_review'))),
 'dependency_functions',to_regprocedure('core.clover_order_status_v1(uuid)') IS NOT NULL
  AND to_regprocedure('public.clover_order_ingest_v1(uuid,text,jsonb)') IS NOT NULL
  AND to_regprocedure('public.clover_order_day_totals_v1(uuid,timestamptz,timestamptz)') IS NOT NULL,
 'k6_absent',to_regclass('core.message_send_settings') IS NULL AND to_regclass('core.message_log') IS NULL
  AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname IN ('core','public') AND (p.proname LIKE 'message_send_%' OR p.proname='message_log_immutable_v1')));
ROLLBACK;
""".encode()


def preflight(value, target):
    expected = {'scope': 'K6_READ_ONLY_PREFLIGHT', 'read_only': True, 'read_committed': True, 'database': 'postgres',
        'business_count': 1, 'business_marked_test': target == 'test', 'core_closed': True,
        'k4_guard': True, 'k5_guard': True, 'customers_rls': True, 'replication_origin': True,
        'dependency_tables': True, 'dependency_functions': True, 'k6_absent': True}
    if (not isinstance(value, dict) or type(value.get('business_count')) is not int
        or any((value.get(k) is not v if type(v) is bool else value.get(k) != v) for k, v in expected.items())
        or target == 'test' and value.get('all_businesses_test') is not True):
        stop('K6_PREFLIGHT_FAILED')
    return value


def execute(cfg, target, password):
    directory = Path(cfg['receipt_directory'])
    selected = cfg['targets'][target]
    if target == 'production' and not cfg.get('_allow_production'):
        stop('K6_HUMAN_PRODUCTION_FLAG_REQUIRED')
    state = {'scope': 'K6_OPERATOR_ATTEMPT', 'target': target, 'target_ref': selected['ref'],
        'host': selected['host'], 'business_id': selected['business_id'],
        'config_sha256': cfg['_config_sha256'], 'operator_sha256': cfg['_operator_sha256'],
        'launcher_sha256': cfg['_launcher_sha256'], 'migration_sha256': cfg['migration_sha256'],
        'acceptance_sha256': cfg['acceptance_sha256'],
        'phase': 'claimed_before_connection', 'password_recorded': False, 'automatic_retry': False}
    attempt = directory / (target + '-attempt.json')
    with attempt.open('x', encoding='utf8') as handle:
        json.dump(state, handle, indent=2)
    def phase(value):
        state.update(phase=value, updated_at_utc=datetime.now(timezone.utc).isoformat())
        temporary = directory / ('.phase-' + uuid.uuid4().hex)
        temporary.write_text(json.dumps(state), encoding='utf8'); os.replace(temporary, attempt)
    frozen_dir = directory / ('frozen-' + uuid.uuid4().hex); frozen_dir.mkdir()
    frozen = {}
    for key, ending in (('migration', b'COMMIT;'), ('acceptance', b'ROLLBACK;')):
        frozen[key] = frozen_dir / (key + '.sql')
        with frozen[key].open('xb') as handle:
            handle.write(source_bytes(cfg[key], cfg[key + '_sha256'], ending))
    deadline = time.monotonic() + 300
    def pins():
        if sha(cfg['_config_path']) != cfg['_config_sha256'] or sha(__file__) != cfg['_operator_sha256'] or sha(LAUNCHER) != cfg['_launcher_sha256'] or sha(SUPPORT) != K5_SUPPORT_SHA256:
            stop('K6_DISPLAYED_PLAN_CHANGED')
        for key, digest in (('migration', 'migration_sha256'), ('acceptance', 'acceptance_sha256'),
                            ('psql_path', 'psql_binary_sha256'), ('ca_path', 'ca_sha256'), ('python_path', 'python_sha256')):
            if sha(cfg[key]) != cfg[digest] or key in frozen and sha(frozen[key]) != cfg[digest]:
                stop('K6_SOURCE_CHANGED')
        if dependencies(cfg, target) != cfg['_dependencies']:
            stop('K6_DEPENDENCY_RECEIPTS_REQUIRED')
        if evidence(cfg, target) != cfg['_evidence']:
            stop('K6_DEPENDENCY_RECEIPTS_REQUIRED')
        if target == 'production':
            test_success(cfg)
    def call(args, sql=None, test=False):
        pins(); remaining = deadline - time.monotonic()
        if remaining <= 0: stop('K6_DEADLINE_EXCEEDED')
        environment = clean_environment()
        environment.update(PGHOST=selected['host'], PGPORT='5432', PGUSER='postgres', PGDATABASE='postgres',
            PGPASSWORD=password, PGSSLMODE='verify-full', PGSSLROOTCERT=cfg['ca_path'], PGCONNECT_TIMEOUT='15',
            PGCLIENTENCODING='UTF8', PGAPPNAME='k6-human-migration', PSQL_HISTORY=os.devnull,
            PGOPTIONS='-c client_min_messages=error -c statement_timeout=60000 -c lock_timeout=5000')
        if test: environment['PGOPTIONS'] += ' -c k6.test_business_id=' + selected['business_id']
        try:
            result = subprocess.run([cfg['psql_path'], '-X', '--no-password', '--set=ON_ERROR_STOP=1', '-qAt', *args],
                input=sql, env=environment, capture_output=True, timeout=min(120, remaining), check=False)
        except subprocess.TimeoutExpired:
            stop('K6_TIMEOUT_OUTCOME_REVIEW_REQUIRED')
        except OSError:
            stop('K6_PROCESS_FAILED')
        finally:
            environment.pop('PGPASSWORD', None)
        if result.returncode: stop(classify_psql_error(result.stderr))
        return result.stdout.decode('utf8', errors='replace').strip()
    try:
        phase('read_only_preflight'); observed = preflight(json.loads(call([], preflight_sql(selected))), target)
        phase('migration_submitting_outcome_unknown_until_receipt'); call(['--file', str(frozen['migration'])])
        phase('migration_committed')
        result = {'scope': SCOPE, 'status': 'completed', 'target': target, 'target_ref': selected['ref'],
            'business_id': selected['business_id'], 'migration_sha256': cfg['migration_sha256'],
            'acceptance_sha256': cfg['acceptance_sha256'], 'psql_version': PSQL_VERSION,
            'psql_binary_sha256': cfg['psql_binary_sha256'], 'ca_sha256': cfg['ca_sha256'],
            'python_sha256': cfg['python_sha256'],
            'operator_sha256': cfg['_operator_sha256'], 'launcher_sha256': cfg['_launcher_sha256'],
            'support_sha256': K5_SUPPORT_SHA256, 'dependency_source_sha256': cfg['_dependencies'],
            'dependency_evidence_sha256': cfg['_evidence'],
            'preflight': observed, 'host': selected['host'], 'user': 'postgres',
            'password_recorded': False, 'automatic_retry': False, 'completed_at_utc': datetime.now(timezone.utc).isoformat()}
        if target == 'test':
            phase('rollback_acceptance'); result['acceptance'] = acceptance(json.loads(call(['--file', str(frozen['acceptance'])], test=True)), cfg['acceptance_minimum_checks'])
        else: result['test_success_sha256'] = cfg['test_success_sha256']
        pins()
        with (directory / (target + '-success.json')).open('x', encoding='utf8') as handle:
            json.dump(result, handle, indent=2)
        phase('completed_success_receipt_written')
        return result
    finally:
        password = None


def main(argv=None, stdin=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True); parser.add_argument('--target', choices=['test', 'production'], required=True)
    parser.add_argument('--allow-production', action='store_true'); parser.add_argument('--execute', action='store_true')
    parser.add_argument('--plan-sha256'); args = parser.parse_args(argv)
    cfg = None
    try:
        cfg = validate(args.config, args.target, args.allow_production); displayed = plan(cfg, args.target)
        if not args.execute:
            print(json.dumps(displayed)); return 0
        if args.plan_sha256 != displayed['plan_sha256']:
            stop('K6_DISPLAYED_PLAN_CHANGED')
        # PS7's redirected pipe is explicitly UTF-8; do not use the Windows
        # console locale to decode a password containing non-ASCII characters.
        raw = (stdin if stdin is not None else sys.stdin.buffer).read(16385)
        payload = json.loads(raw.decode('utf8') if isinstance(raw, bytes) else raw)
        if (not isinstance(payload, dict) or set(payload) != {'password', 'human_confirmed', 'target_ref', 'plan_sha256'}
            or payload['human_confirmed'] is not True or payload['target_ref'] != displayed['ref']
            or payload['plan_sha256'] != displayed['plan_sha256'] or not isinstance(payload['password'], str)
            or not payload['password'] or '\x00' in payload['password']):
            stop('K6_HUMAN_STDIN_HANDOFF_REQUIRED')
        secret = payload.pop('password')
        try: result = execute(cfg, args.target, secret)
        finally: secret = None; payload.clear()
        print(json.dumps({'scope': SCOPE, 'status': result['status'], 'target': args.target, 'password_recorded': False})); return 0
    except Exception as error:
        code = safe_code(error)
        if cfg is not None and args.execute:
            try:
                with (Path(cfg['receipt_directory']) / (args.target + '-failure.json')).open('x', encoding='utf8') as handle:
                    json.dump({'scope': 'K6_OPERATOR_FAILURE', 'target': args.target, 'code': code,
                        'password_recorded': False, 'automatic_retry': False, 'outcome_requires_review': True}, handle)
            except OSError: pass
        print(json.dumps({'status': 'stopped', 'code': code, 'password_recorded': False})); return 1


if __name__ == '__main__':
    raise SystemExit(main())
