"""Private schema evidence and explicitly gated sandbox recovery capture.

Production exports schema only, never rows. Sandbox may export exactly four
reserved-marker test orders and one anonymous staff record. No restore/apply.

Import is inert. CLI defaults to configuration validation; --gui is the only
network-capable entry point. Passwords are entered in the local masked GUI.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import uuid
from datetime import datetime, timezone

MODES = {"PRODUCTION": "Nazar-production", "SANDBOX": "Nazar-catering-sandbox"}
SCHEMAS = ("core", "public")
CATALOG_SQL = """BEGIN TRANSACTION READ ONLY;
SELECT jsonb_build_object(
 'server_version_num',current_setting('server_version_num')::integer,
 'read_only',current_setting('transaction_read_only'),
 'objects',COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY class_id,object_id) FROM (
  SELECT n.tableoid::oid::bigint class_id,n.oid::bigint object_id,n.nspname schema_name,'schema' kind,n.nspname identity
   FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('core','public')
  UNION ALL SELECT c.tableoid::oid::bigint,c.oid::bigint,n.nspname,'relation',pg_catalog.pg_describe_object(c.tableoid,c.oid,0)
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('core','public')
  UNION ALL SELECT p.tableoid::oid::bigint,p.oid::bigint,n.nspname,'routine',pg_catalog.pg_describe_object(p.tableoid,p.oid,0)
   FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('core','public')
  UNION ALL SELECT t.tableoid::oid::bigint,t.oid::bigint,n.nspname,'type',pg_catalog.pg_describe_object(t.tableoid,t.oid,0)
   FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN ('core','public')
  UNION ALL SELECT c.tableoid::oid::bigint,c.oid::bigint,n.nspname,'constraint',pg_catalog.pg_describe_object(c.tableoid,c.oid,0)
   FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_namespace n ON n.oid=c.connamespace WHERE n.nspname IN ('core','public')
  UNION ALL SELECT t.tableoid::oid::bigint,t.oid::bigint,n.nspname,'trigger',pg_catalog.pg_describe_object(t.tableoid,t.oid,0)
   FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ('core','public') AND NOT t.tgisinternal
  UNION ALL SELECT p.tableoid::oid::bigint,p.oid::bigint,n.nspname,'policy',pg_catalog.pg_describe_object(p.tableoid,p.oid,0)
   FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('core','public')
  UNION ALL SELECT r.tableoid::oid::bigint,r.oid::bigint,n.nspname,'rule',pg_catalog.pg_describe_object(r.tableoid,r.oid,0)
   FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('core','public')
  UNION ALL SELECT a.tableoid::oid::bigint,a.oid::bigint,n.nspname,'default_acl',pg_catalog.pg_describe_object(a.tableoid,a.oid,0)
   FROM pg_catalog.pg_default_acl a JOIN pg_catalog.pg_namespace n ON n.oid=a.defaclnamespace WHERE n.nspname IN ('core','public')
 ) o WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
   WHERE d.classid=o.class_id AND d.objid=o.object_id AND d.deptype='e')), '[]'::jsonb));
COMMIT;
"""

# Sandbox-only recovery, explicitly requested separately from production schema.
# No Auth row/UUID or real staff identity is exported. Unexpected rows fail closed.
SANDBOX_RECOVERY_SQL = """BEGIN TRANSACTION READ ONLY;
WITH orders AS MATERIALIZED (SELECT o.* FROM public.catering_orders o),
counts AS (SELECT count(*) total,
 count(*) FILTER (WHERE lower(customer_email) ~ '@([^@.]+\\.)*(example\\.(com|net|org)|[^@]+\\.invalid)$'
  AND upper(customer_name) ~ '(TEST|VERIFY)') marked FROM orders),
staff AS (SELECT count(*) total FROM core.crm_staff),
payload AS (SELECT counts.total,counts.marked,staff.total staff_count,
 CASE WHEN counts.total=4 AND counts.marked=4 AND staff.total=1
 THEN (SELECT jsonb_agg(to_jsonb(o) ORDER BY id)::text FROM orders o) END rows_json,
 CASE WHEN counts.total=4 AND counts.marked=4 AND staff.total=1 THEN
 (SELECT jsonb_agg(jsonb_build_object('staff_ref','sandbox-staff-'||s.n,'active',s.active,
 'auth_linked',s.auth_linked,'role',NULL) ORDER BY s.n)::text FROM
 (SELECT row_number() OVER (ORDER BY auth_user_id) n,active,
 EXISTS(SELECT 1 FROM auth.users a WHERE a.id=c.auth_user_id) auth_linked FROM core.crm_staff c) s) END staff_json
 FROM counts CROSS JOIN staff)
SELECT jsonb_build_object('total',total,'marked',marked,'staff_count',staff_count,
 'rows_json',rows_json,'staff_json',staff_json,
 'rows_sha256',CASE WHEN rows_json IS NOT NULL THEN encode(sha256(convert_to(rows_json,'UTF8')),'hex') END)
FROM payload;
COMMIT;
"""


class CaptureError(Exception):
    """Only fixed, non-secret messages may reach GUI/console."""


def sha256_file(file: Path) -> str:
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def config_for(mode: str, env=None) -> dict:
    env = os.environ if env is None else env
    if mode not in MODES:
        raise CaptureError('MODE_INVALID')
    prefix = 'SCHEMA_' + mode + '_'
    values = {name: env.get(prefix + name, '').strip() for name in
              ('PROJECT_REF', 'HOST', 'PORT', 'USER', 'DATABASE', 'SSLROOTCERT')}
    if not all(values.values()):
        raise CaptureError('CONFIG_MISSING: ' + prefix + '{PROJECT_REF,HOST,PORT,USER,DATABASE,SSLROOTCERT}')
    ref, host = values['PROJECT_REF'], values['HOST']
    if not re.fullmatch(r'[a-z]{20}', ref):
        raise CaptureError('PROJECT_REF_INVALID')
    direct = host == 'db.' + ref + '.supabase.co' and values['USER'] == 'postgres'
    pooler = bool(re.fullmatch(r'aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com', host)) and values['USER'] == 'postgres.' + ref
    if not (direct or pooler) or values['PORT'] != '5432' or values['DATABASE'] != 'postgres':
        raise CaptureError('TARGET_BINDING_REJECTED: direct veya session-pooler hedefini kontrol edin.')
    other = env.get('SCHEMA_' + ('SANDBOX' if mode == 'PRODUCTION' else 'PRODUCTION') + '_PROJECT_REF', '').strip()
    if other == ref:
        raise CaptureError('SOURCE_TARGET_PROJECTS_MUST_DIFFER')
    cert = Path(values['SSLROOTCERT'])
    pg_bin = Path(env.get('SCHEMA_PG_BIN', ''))
    private_value = env.get(prefix + 'PRIVATE_ROOT', env.get('SCHEMA_PRIVATE_ROOT', ''))
    private = Path(private_value)
    if not values['SSLROOTCERT'] or not cert.is_absolute() or not cert.is_file():
        raise CaptureError('TRUSTED_CA_FILE_REQUIRED')
    if not env.get('SCHEMA_PG_BIN') or not pg_bin.is_absolute() or not all((pg_bin / (tool + '.exe')).is_file() for tool in ('psql', 'pg_dump', 'pg_restore')):
        raise CaptureError('POSTGRES_BIN_REQUIRED')
    if not private_value or not private.is_absolute() or not private.is_dir():
        raise CaptureError('PRIVATE_ROOT_REQUIRED: mevcut mutlak klasör gerekli.')
    for ancestor in (private, *private.parents):
        if ancestor.is_symlink() or bool(getattr(ancestor.stat(), 'st_file_attributes', 0) & 0x400) or (ancestor / '.git').exists():
            raise CaptureError('PRIVATE_ROOT_MUST_BE_OUTSIDE_GIT_AND_LINKS')
    return {'mode': mode, **values, 'pg_bin': pg_bin.resolve(), 'private_root': private.resolve()}


def child_env(config: dict, password: str, env=None) -> dict:
    result = {k: v for k, v in (os.environ if env is None else env).items() if not k.upper().startswith('PG')}
    # libpq reads only this explicit child environment. No password in argv/file.
    result.update(PGHOST=config['HOST'], PGPORT=config['PORT'], PGUSER=config['USER'],
                  PGDATABASE=config['DATABASE'], PGPASSWORD=password, PGSSLMODE='verify-full',
                  PGSSLROOTCERT=config['SSLROOTCERT'], PGCONNECT_TIMEOUT='20',
                  PGAPPNAME='nazar-schema-only-capture',
                  PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=120000')
    return result


def pg_args(tool: str, capture_dir: Path) -> list[str]:
    if tool == 'psql':
        return ['--no-password', '--no-psqlrc', '--quiet', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1', '--file=-']
    if tool == 'pg_dump':
        return ['--no-password', '--schema-only', '--format=custom', '--no-owner', '--strict-names',
                '--schema=core', '--schema=public', '--lock-wait-timeout=15s', '--file=' + str(capture_dir / 'raw-schema.dump')]
    if tool == 'pg_restore':
        return ['--list', str(capture_dir / 'raw-schema.dump')]
    raise CaptureError('TOOL_NOT_ALLOWED')


def render_args(capture_dir: Path) -> list[str]:
    # File output only. No --dbname, --clean, --create or SQL execution path.
    return ['--schema-only', '--no-owner', '--file=' + str(capture_dir / 'schema.sql'), str(capture_dir / 'raw-schema.dump')]


def safe_error_code(stderr: bytes) -> str:
    message = stderr.decode('utf8', errors='replace').lower()
    for phrases, code in (
        (('too many authentication', 'circuit breaker'), 'AUTH_TEMPORARILY_BLOCKED'),
        (('password authentication failed', 'authentication failed', 'wrong password'), 'DATABASE_PASSWORD_REJECTED'),
        (('tenant or user not found', 'tenant not found'), 'PROJECT_BINDING_NOT_FOUND'),
        (('certificate verify failed', 'root certificate file', 'server certificate', 'ssl error'), 'TLS_VERIFY_FAILED'),
        (('could not translate host', 'could not resolve', 'name or service not known'), 'DNS_FAILED'),
        (('timeout', 'timed out'), 'CONNECTION_TIMEOUT'),
        (('connection refused', 'network is unreachable', 'no route to host'), 'CONNECTION_UNAVAILABLE'),
        (('permission denied', 'must be owner', 'insufficient privilege'), 'READ_PERMISSION_DENIED'),
    ):
        if any(phrase in message for phrase in phrases):
            return code
    return 'POSTGRES_OPERATION_FAILED'


def record_status(config: dict, status: str, directory=None, error_code=None):
    value = os.environ.get('SCHEMA_STATUS_FILE', '').strip()
    if not value:
        return
    file = Path(value)
    if not file.is_absolute() or file.name not in ('capture-status.json', 'production-capture-status.json', 'sandbox-capture-status.json') or not file.parent.is_dir():
        raise CaptureError('STATUS_FILE_PATH_INVALID')
    for ancestor in (file, *file.parents):
        if ancestor.is_symlink() or (ancestor.exists() and bool(getattr(ancestor.stat(), 'st_file_attributes', 0) & 0x400)) or (ancestor / '.git').exists():
            raise CaptureError('STATUS_FILE_PATH_INVALID')
    if status not in ('ready', 'validating', 'catalog', 'schema_dump', 'schema_render', 'sandbox_recovery', 'success', 'error'):
        raise CaptureError('STATUS_INVALID')
    proof = {'mode': config['mode'], 'status': status, 'updated_at': datetime.now(timezone.utc).isoformat(),
             'directory': str(directory) if directory else None, 'error_code': error_code}
    temporary = file.parent / ('.capture-status-' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf8') as stream:
        stream.write(json.dumps(proof, indent=2))
    os.replace(temporary, file)


def run_pg(config: dict, tool: str, args: list[str], env: dict, stdin=None) -> bytes:
    try:
        result = subprocess.run([str(config['pg_bin'] / (tool + '.exe')), *args], input=stdin,
                                env=env, capture_output=True, timeout=300, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise CaptureError('POSTGRES_TOOL_START_OR_TIMEOUT') from None
    if result.returncode:
        # Raw libpq stderr can contain target details/SQL. Never echo or persist.
        raise CaptureError(safe_error_code(result.stderr) + ': ham server yanıtı gösterilmedi.')
    return result.stdout


def restrict_capture_dir(directory: Path):
    if os.name != 'nt':
        directory.chmod(0o700)
        return
    try:
        result = subprocess.run(['whoami', '/user', '/fo', 'csv', '/nh'], capture_output=True, check=True)
        import csv
        import io
        sid = next(csv.reader(io.StringIO(result.stdout.decode().strip())))[1]
        if not re.fullmatch(r'S-[0-9-]+', sid):
            raise ValueError()
        subprocess.run(['icacls', str(directory), '/inheritance:r', '/grant:r',
                        '*' + sid + ':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F'], capture_output=True, check=True)
    except Exception:
        raise CaptureError('PRIVATE_ACL_FAILED: hiçbir database bağlantısı açılmadı.') from None


def inspect_toc(toc: str, objects: list[dict]) -> dict:
    """Propose explicit IDs for review; never infer membership from a name prefix."""
    lookup = {(int(o['class_id']), int(o['object_id'])): o for o in objects if o.get('schema_name') in SCHEMAS}
    candidates, excluded, unresolved = [], [], []
    for line in toc.splitlines():
        if not line or line.startswith(';'):
            continue
        match = re.fullmatch(r'(\d+); (\d+) (\d+) (.+)', line)
        if not match:
            raise CaptureError('TOC_FORMAT_UNSUPPORTED')
        dump_id, class_id, object_id, description = match.groups()
        # No data entry may survive even if a future argument regression occurs.
        if re.match(r'(TABLE DATA|MATERIALIZED VIEW DATA|SEQUENCE SET|BLOBS|BLOB DATA|LARGE OBJECT)', description):
            raise CaptureError('DATA_ENTRY_REFUSED')
        item = {'dump_id': int(dump_id), 'class_id': int(class_id), 'object_id': int(object_id), 'description': description, 'include': False}
        obj = lookup.get((int(class_id), int(object_id)))
        if obj:
            item.update(schema=obj['schema_name'], identity=obj['identity'])
            candidates.append(item)
        elif int(class_id) == 0:
            # ACL/comment/default/ROW SECURITY entries often have synthetic IDs.
            # Human review must associate these with an approved app object.
            unresolved.append(item)
        else:
            excluded.append(item)
    return {'application_candidates': candidates, 'excluded_non_application_or_extension_owned': excluded,
            'unresolved_dependency_or_acl_entries': unresolved}


def write_sandbox_recovery(directory: Path, envelope: dict):
    if (envelope.get('total'), envelope.get('marked'), envelope.get('staff_count')) != (4, 4, 1):
        raise CaptureError('SANDBOX_RECOVERY_COUNTS_CHANGED: hiçbir satır export edilmedi.')
    rows, staff = envelope.get('rows_json'), envelope.get('staff_json')
    if not isinstance(rows, str) or not isinstance(staff, str):
        raise CaptureError('SANDBOX_RECOVERY_ENVELOPE_INVALID')
    rows_bytes = rows.encode('utf8')  # Preserve SQL text exactly, including whitespace.
    if hashlib.sha256(rows_bytes).hexdigest() != envelope.get('rows_sha256'):
        raise CaptureError('SANDBOX_RECOVERY_SOURCE_HASH_MISMATCH')
    decoded_rows, decoded_staff = json.loads(rows), json.loads(staff)
    if not isinstance(decoded_rows, list) or len(decoded_rows) != 4 or not isinstance(decoded_staff, list) or len(decoded_staff) != 1:
        raise CaptureError('SANDBOX_RECOVERY_PAYLOAD_COUNTS_INVALID')
    if any(set(row) != {'staff_ref', 'active', 'auth_linked', 'role'} or row.get('role') is not None
           or not isinstance(row.get('active'), bool) or not isinstance(row.get('auth_linked'), bool)
           or not re.fullmatch(r'sandbox-staff-[0-9]+', row.get('staff_ref', '')) for row in decoded_staff):
        raise CaptureError('SANDBOX_STAFF_IDENTITY_EXPORT_REFUSED')
    (directory / 'catering-orders.json').write_bytes(rows_bytes)
    (directory / 'staff-anonymous.json').write_bytes(staff.encode('utf8'))
    proof = {'capturedAtUtc': datetime.now(timezone.utc).isoformat(), 'expectedCateringRows': 4,
             'expectedStaffRows': 1, 'cateringRowsSha256': envelope['rows_sha256'],
             'staffAnonymousSha256': sha256_file(directory / 'staff-anonymous.json'),
             'allRowsReviewedSynthetic': False, 'markerClassificationPassed': True,
             'freeFormReviewPending': True, 'schemaDumpSucceeded': True,
             'authPlatformPreserved': True, 'localRestoreProof': False,
             'scope': 'read_only_source_capture_not_reset_or_restore'}
    (directory / 'recovery-source-proof.json').write_text(json.dumps(proof, indent=2), encoding='utf8')


def capture(config: dict, password: str) -> Path:
    if not isinstance(password, str) or not password:
        raise CaptureError('DATABASE_PASSWORD_REQUIRED')
    directory = config['private_root'] / (config['mode'].lower() + '_' + datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S') + '_' + uuid.uuid4().hex[:12])
    try:
        directory.mkdir(exist_ok=False)
        restrict_capture_dir(directory)  # Must succeed before any network operation.
    except CaptureError as error:
        record_status(config, 'error', directory, str(error).split(':')[0])
        raise
    except OSError:
        record_status(config, 'error', directory, 'PRIVATE_DIRECTORY_CREATE_FAILED')
        raise CaptureError('PRIVATE_DIRECTORY_CREATE_FAILED: database bağlantısı açılmadı.') from None
    env = child_env(config, password)
    try:
        record_status(config, 'validating', directory)
        version = run_pg(config, 'pg_dump', ['--version'], env).decode('utf8')
        match = re.search(r'PostgreSQL\) (\d+)\.', version)
        if not match:
            raise CaptureError('DUMP_VERSION_UNRECOGNIZED')
        record_status(config, 'catalog', directory)
        catalog = json.loads(run_pg(config, 'psql', pg_args('psql', directory), env, CATALOG_SQL.encode('utf8')))
        if catalog.get('read_only') != 'on' or not isinstance(catalog.get('objects'), list):
            raise CaptureError('READ_ONLY_CATALOG_REQUIRED')
        if int(match.group(1)) < int(catalog['server_version_num']) // 10000:
            raise CaptureError('PG_DUMP_VERSION_TOO_OLD')
        if not any(o.get('schema_name') == 'core' for o in catalog['objects']):
            raise CaptureError('APPLICATION_CORE_SCHEMA_MISSING')
        (directory / 'catalog.json').write_text(json.dumps(catalog, indent=2), encoding='utf8')
        record_status(config, 'schema_dump', directory)
        run_pg(config, 'pg_dump', pg_args('pg_dump', directory), env)
        toc = run_pg(config, 'pg_restore', pg_args('pg_restore', directory), env).decode('utf8')
        (directory / 'raw-toc.list').write_text(toc, encoding='utf8')
        review = inspect_toc(toc, catalog['objects'])
        record_status(config, 'schema_render', directory)
        offline_env = {key: value for key, value in env.items() if not key.upper().startswith('PG')}
        run_pg(config, 'pg_restore', render_args(directory), offline_env)
        offline_env.clear()
        review.update(version=1, review_complete=False, capture_only=True,
                      note='Her include=false bilinçlidir. Managed public nesneler, ACL ve bağımlılıklar tek tek incelenmeden replay üretilemez.')
        (directory / 'allowlist-review.json').write_text(json.dumps(review, indent=2, ensure_ascii=False), encoding='utf8')
        manifest = {'version': 1, 'status': 'PRIVATE_RAW_SCHEMA_REQUIRES_REVIEW', 'mode': config['mode'],
                    'captured_at': datetime.now(timezone.utc).isoformat(), 'source_project_ref': config['PROJECT_REF'],
                    'server_version_num': catalog['server_version_num'], 'pg_dump_version': version.strip(),
                    'schemas': list(SCHEMAS), 'schema_data_exported': False,
                    'data_exported': config['mode'] == 'SANDBOX',
                    'syntheticRowsExported': 4 if config['mode'] == 'SANDBOX' else 0,
                    'anonymousStaffRowsExported': 1 if config['mode'] == 'SANDBOX' else 0,
                    'syntheticContentsReviewed': False, 'read_only': True, 'tls': 'verify-full',
                    'replay_ready': False, 'files': {name: sha256_file(directory / name) for name in
                    ('catalog.json', 'raw-schema.dump', 'raw-toc.list', 'allowlist-review.json', 'schema.sql')}}
        if config['mode'] == 'SANDBOX':
            record_status(config, 'sandbox_recovery', directory)
            recovery = json.loads(run_pg(config, 'psql', pg_args('psql', directory), env, SANDBOX_RECOVERY_SQL.encode('utf8')))
            write_sandbox_recovery(directory, recovery)
            for name in ('catering-orders.json', 'staff-anonymous.json', 'recovery-source-proof.json'):
                manifest['files'][name] = sha256_file(directory / name)
        (directory / 'capture-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf8')
        (directory / 'source-proof.json').write_text(json.dumps(manifest, indent=2), encoding='utf8')
        record_status(config, 'success', directory)
        return directory
    except CaptureError as error:
        record_status(config, 'error', directory, str(error).split(':')[0])
        raise
    except Exception:
        record_status(config, 'error', directory, 'CAPTURE_FAILED')
        raise CaptureError('CAPTURE_FAILED: ham içerik gösterilmedi; özel klasör korunuyor.') from None
    finally:
        env.clear()
        password = None  # Python immutable strings cannot promise forensic zeroing.


def launch_gui():
    import tkinter as tk
    from tkinter import ttk
    window = tk.Tk()
    window.title('Nazar — K3 capture')
    window.geometry('780x620')
    window.resizable(False, False)
    mode = tk.StringVar(value='PRODUCTION')
    status = tk.StringVar(value='Production: yalnız schema. Sandbox: schema + 4 test order + anonim staff. Reset / restore yapılmaz.')
    panel = ttk.Frame(window, padding=22)
    panel.pack(fill='both', expand=True)
    ttk.Label(panel, text='1. Database seçin', font=('Segoe UI', 12, 'bold')).pack(anchor='w')
    radio_controls = []
    for value, label in MODES.items():
        radio = ttk.Radiobutton(panel, text=label, value=value, variable=mode)
        radio.pack(anchor='w', pady=3)
        radio_controls.append(radio)
    target = tk.StringVar()
    password_label = tk.StringVar()
    approval_label = tk.StringVar()
    scope_label = tk.StringVar()
    password = None
    button = None
    in_progress = False
    approved = tk.BooleanVar(value=False)
    def show_target(*_):
        approved.set(False)
        if password is not None:
            password.delete(0, 'end')
        scope = 'Yalnız schema; production data alınmaz.' if mode.get() == 'PRODUCTION' else 'Schema + tam 4 test order + 1 anonim staff kaydı; içerik review bekler.'
        scope_label.set(scope)
        password_label.set('2. ' + MODES[mode.get()] + ' — mevcut database password')
        approval_label.set('Project ref / host’u kontrol ettim. ' + scope)
        if button is not None:
            button.configure(text='Production schema al' if mode.get() == 'PRODUCTION' else 'Sandbox recovery dosyalarını al')
        try:
            cfg = config_for(mode.get())
            target.set(MODES[mode.get()] + '\nProject ref: ' + cfg['PROJECT_REF'] + '\nHost: ' + cfg['HOST'] + '\nUser: ' + cfg['USER'])
            record_status(cfg, 'ready')
        except CaptureError as error:
            target.set(str(error))
    mode.trace_add('write', show_target)
    show_target()
    ttk.Label(panel, textvariable=target, wraplength=690).pack(anchor='w', pady=12)
    ttk.Label(panel, textvariable=scope_label, wraplength=690).pack(anchor='w', pady=6)
    ttk.Label(panel, textvariable=password_label, font=('Segoe UI', 11, 'bold')).pack(anchor='w')
    ttk.Label(panel, text='Supabase web / CRM password değil. Archive password istenmiyor.').pack(anchor='w', pady=4)
    password = ttk.Entry(panel, show='●', width=65)
    password.pack(anchor='w', pady=5)
    approval_control = ttk.Checkbutton(panel, textvariable=approval_label, variable=approved)
    approval_control.pack(anchor='w', pady=10)
    ttk.Label(panel, textvariable=status, wraplength=690).pack(anchor='w', pady=12)
    def start():
        nonlocal in_progress
        if not approved.get():
            status.set('Önce project ref / host kontrol kutusunu işaretleyin.')
            return
        secret = password.get()
        password.delete(0, 'end')
        try:
            cfg = config_for(mode.get())
            if not secret:
                raise CaptureError('DATABASE_PASSWORD_REQUIRED')
        except CaptureError as error:
            status.set(str(error))
            return
        button.configure(state='disabled')
        in_progress = True
        for control in (*radio_controls, password, approval_control):
            control.configure(state='disabled')
        status.set(MODES[cfg['mode']] + ' capture çalışıyor. Bu pencereyi açık bırakın.')
        def finish(message):
            nonlocal in_progress
            in_progress = False
            status.set(message)
            button.configure(state='normal')
            for control in (*radio_controls, password, approval_control):
                control.configure(state='normal')
        def work():
            try:
                output = capture(cfg, secret)
                message = 'Capture tamamlandı. Review bekliyor; replay hazır değil. Özel klasör: ' + str(output)
            except CaptureError as error:
                message = MODES[cfg['mode']] + ': ' + str(error) + ' Password’ü sohbete yazmayın.'
            window.after(0, lambda: finish(message))
        threading.Thread(target=work, daemon=True).start()
    button = ttk.Button(panel, text='Production schema al', command=start)
    button.pack(anchor='w', pady=4)
    def close():
        if in_progress:
            status.set('Capture çalışıyor; tamamlanana kadar pencereyi açık bırakın.')
        else:
            window.destroy()
    window.protocol('WM_DELETE_WINDOW', close)
    window.mainloop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--gui', action='store_true', help='Masked yerel GUI; kullanıcı başlatmadan bağlantı açılmaz.')
    parser.add_argument('--validate-config', choices=tuple(MODES), help='Yalnız yerel configuration kontrolü; ağ bağlantısı yok.')
    args = parser.parse_args()
    if args.gui:
        launch_gui()
    elif args.validate_config:
        config_for(args.validate_config)
        print('CONFIG_VALIDATED_NO_CONNECTION')
    else:
        parser.print_help()


if __name__ == '__main__':
    try:
        main()
    except CaptureError as error:
        print(str(error))
        raise SystemExit(2)
