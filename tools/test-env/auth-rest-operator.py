"""One explicit sandbox Auth password sign-in and bounded read-only REST checks.

Import/config validation make no HTTP calls. Only the local GUI obtains email and
password. Auth session creation/local logout are the only session mutations; no
customer/staff write RPC, reset email, user creation or credential change exists.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import ssl
import threading
import time
import urllib.error
import urllib.request
import uuid


REPO = Path(__file__).resolve().parents[2]
PRODUCTION_GUARD = REPO / 'src/lib/deploymentEnvironment.ts'
BASELINE = REPO / 'supabase/baselines/20261019_application_schema.sql'
PUBLIC_CHECKS = ('auth_health', 'openapi_restricted', 'rest_ready', 'public_offers',
                 'anon_queue_denied', 'anon_core_denied')
CHECKS = (*PUBLIC_CHECKS, 'password_sign_in', 'jwt_target_claims',
          'staff_authorized', 'staff_queue_read', 'staff_core_denied', 'local_logout')
COUNT_KEYS = {'open_catering', 'missing_owner', 'missing_followup', 'overdue_catering',
              'open_tasks', 'overdue_tasks', 'pending_decisions'}
QUEUE_ARGUMENTS = {'p_queue': 'open_catering', 'p_offset': 0}
ROUTES = {('GET', '/auth/v1/health'), ('GET', '/rest/v1/'),
          ('POST', '/rest/v1/rpc/get_active_offers'),
          ('POST', '/rest/v1/rpc/crm_follow_up_queue_v1'),
          ('POST', '/rest/v1/rpc/crm_staff_authorized_v1'),
          ('GET', '/rest/v1/customers?select=id&limit=0'),
          ('POST', '/auth/v1/token?grant_type=password'),
          ('POST', '/auth/v1/logout?scope=local')}


class AuthRestError(Exception):
    """Fixed category only: never include HTTP response/credentials in errors."""


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def private_path(value, directory=False):
    if not isinstance(value, str) or not value or value.startswith(('\\\\', '//')):
        raise AuthRestError('LOCAL_PRIVATE_PATH_REQUIRED')
    path = Path(value)
    if not path.is_absolute() or not (path.is_dir() if directory else path.is_file()):
        raise AuthRestError('LOCAL_PRIVATE_PATH_REQUIRED')
    for ancestor in (path, *path.parents):
        if ancestor.is_symlink() or bool(getattr(ancestor.stat(), 'st_file_attributes', 0) & 0x400) \
                or (ancestor.is_dir() and (ancestor / '.git').exists()):
            raise AuthRestError('PRIVATE_LINK_OR_GIT_REFUSED')
    return path.resolve()


def configuration(filename):
    path = private_path(str(filename))
    if path.stat().st_size > 16384:
        raise AuthRestError('CONFIG_TOO_LARGE')
    try:
        value = json.loads(path.read_text(encoding='utf8'))
    except (OSError, ValueError):
        raise AuthRestError('CONFIG_INVALID') from None
    fields = {'expectedSandboxRef', 'productionRef', 'sandboxUrl', 'publishableKey', 'testBusinessId', 'privateRoot'}
    if not isinstance(value, dict) or set(value) != fields or not all(isinstance(x, str) and x for x in value.values()):
        raise AuthRestError('EXACT_EXPLICIT_CONFIG_REQUIRED_NO_CREDENTIAL_FIELDS')
    if not all(re.fullmatch('[a-z]{20}', value[k]) for k in ('expectedSandboxRef', 'productionRef')):
        raise AuthRestError('PROJECT_REF_INVALID')
    guard = re.search(r'^export const PRODUCTION_SUPABASE_URL = "https://([a-z]{20})\.supabase\.co";',
                      PRODUCTION_GUARD.read_text(encoding='utf8'), re.MULTILINE)
    if not guard or value['productionRef'] != guard.group(1) \
            or value['expectedSandboxRef'] == guard.group(1):
        raise AuthRestError('PRODUCTION_TARGET_FORBIDDEN')
    target = 'https://' + value['expectedSandboxRef'] + '.supabase.co'
    if value['sandboxUrl'] not in (target, target + '/'):
        raise AuthRestError('EXACT_SANDBOX_HTTPS_ORIGIN_REQUIRED')
    if not re.fullmatch(r'sb_publishable_[A-Za-z0-9_-]{16,256}', value['publishableKey']):
        raise AuthRestError('SANDBOX_PUBLISHABLE_KEY_REQUIRED_NO_SECRET_KEY')
    business = re.search(r"CONSTRAINT businesses_id_check CHECK \(\(id = '([0-9a-f-]+)'::uuid\)\)",
                         BASELINE.read_text(encoding='utf8'))
    if not business or value['testBusinessId'] != business.group(1):
        raise AuthRestError('TEST_BUSINESS_MUST_MATCH_REVIEWED_EXISTING_BASELINE')
    value['sandboxUrl'] = target
    value['private_root'] = private_path(value['privateRoot'], directory=True)
    return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(cfg, method, route, *, body=None, token=None, profile='public'):
    if (method, route) not in ROUTES or profile not in ('public', 'core'):
        raise AuthRestError('HTTP_ROUTE_NOT_ALLOWED')
    if cfg['sandboxUrl'] != 'https://' + cfg['expectedSandboxRef'] + '.supabase.co' \
            or cfg['expectedSandboxRef'] == cfg['productionRef']:
        raise AuthRestError('PRODUCTION_TARGET_FORBIDDEN')
    headers = {'apikey': cfg['publishableKey'],
               'Accept': 'application/openapi+json' if route == '/rest/v1/' else 'application/json'}
    if token is not None:
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', token) \
                or len(token) > 16384:
            raise AuthRestError('ACCESS_TOKEN_FORMAT_INVALID')
        headers['Authorization'] = 'Bearer ' + token
    if route.startswith('/rest/'):
        headers['Accept-Profile' if method == 'GET' else 'Content-Profile'] = profile
    data = None if body is None else json.dumps(body).encode('utf8')
    if data is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(cfg['sandboxUrl'] + route, data=data, headers=headers, method=method)
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                        urllib.request.HTTPSHandler(context=context), NoRedirect())
    try:
        try:
            response = opener.open(req, timeout=25)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status = response.code
            payload = response.read(2 * 1024 * 1024 + 1)
        if len(payload) > 2 * 1024 * 1024:
            raise AuthRestError('HTTP_RESPONSE_TOO_LARGE')
        if status in (301, 302, 303, 307, 308):
            raise AuthRestError('HTTP_REDIRECT_FORBIDDEN')
        if not payload:
            return status, None
        try:
            return status, json.loads(payload)
        except (ValueError, UnicodeError):
            raise AuthRestError('HTTP_RESPONSE_JSON_INVALID') from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise AuthRestError('HTTP_CONNECTION_OR_TLS_FAILED') from None


def jwt_target_verified(token, cfg):
    try:
        parts = token.split('.')
        if len(parts) != 3 or len(token) > 16384:
            return False
        decoded = [json.loads(base64.urlsafe_b64decode(p + '=' * (-len(p) % 4))) for p in parts[:2]]
        header, claims = decoded
        now = time.time()
        return isinstance(header, dict) and isinstance(claims, dict) \
            and header.get('alg') in ('HS256', 'RS256', 'ES256', 'EdDSA') \
            and claims.get('iss') == cfg['sandboxUrl'] + '/auth/v1' \
            and claims.get('role') == 'authenticated' \
            and type(claims.get('exp')) is int and claims['exp'] > now \
            and ('nbf' not in claims or type(claims['nbf']) is int and claims['nbf'] <= now + 30)
    except (ValueError, UnicodeError, TypeError, AttributeError):
        return False


def queue_shape(value):
    return isinstance(value, dict) and value.get('queue') == 'open_catering' \
        and value.get('offset') == 0 and type(value.get('offset')) is int \
        and value.get('page_size') == 25 and type(value.get('page_size')) is int \
        and type(value.get('total')) is int and value['total'] >= 0 \
        and isinstance(value.get('generated_at'), str) \
        and isinstance(value.get('counts'), dict) and set(value['counts']) == COUNT_KEYS \
        and all(type(x) is int and x >= 0 for x in value['counts'].values()) \
        and isinstance(value.get('items'), list) and len(value['items']) <= 25 \
        and len(value['items']) <= value['total'] and all(isinstance(x, dict) for x in value['items'])


def restrict_output(directory):
    # Reuse only the inert, reviewed local ACL utility; no operator is started.
    source = Path(__file__).with_name('hosted-reset-operator.py')
    spec = importlib.util.spec_from_file_location('k3_private_acl_only', source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.restrict_directory(directory)


def write_json(path, value):
    with path.open('x', encoding='utf8') as stream:
        json.dump(value, stream, indent=2)


def record_check(receipt, name, passed, status=None):
    receipt['checks'][name] = {'passed': bool(passed), 'state': 'passed' if passed else 'failed',
                                'http_status': status}
    if not passed:
        raise AuthRestError('CHECK_FAILED_' + name.upper())


def perform_public_checks(cfg, receipt):
    status, body = request(cfg, 'GET', '/auth/v1/health')
    record_check(receipt, 'auth_health', status == 200, status)
    status, body = request(cfg, 'GET', '/rest/v1/')
    # The root OpenAPI catalogue requires an admin-level key. Its documented
    # restriction is a boundary check, not a REST service-readiness failure.
    # Never substitute a secret or legacy key to bypass this restriction.
    record_check(receipt, 'openapi_restricted', status == 401 and isinstance(body, dict)
                 and body.get('message') == 'Secret API key required', status)
    status, body = request(cfg, 'POST', '/rest/v1/rpc/get_active_offers',
                           body={'p_business_id': cfg['testBusinessId']})
    record_check(receipt, 'rest_ready', status == 200 and isinstance(body, list), status)
    record_check(receipt, 'public_offers', status == 200 and isinstance(body, list), status)
    status, body = request(cfg, 'POST', '/rest/v1/rpc/crm_follow_up_queue_v1', body=QUEUE_ARGUMENTS)
    record_check(receipt, 'anon_queue_denied', status in (401, 403), status)
    status, body = request(cfg, 'GET', '/rest/v1/customers?select=id&limit=0', profile='core')
    record_check(receipt, 'anon_core_denied', status == 406 and isinstance(body, dict)
                 and body.get('code') == 'PGRST106', status)


def config_binding(cfg):
    fields = {name: cfg[name] for name in ('expectedSandboxRef', 'productionRef', 'sandboxUrl',
                                          'publishableKey', 'testBusinessId')}
    return hashlib.sha256(json.dumps(fields, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def run_public_preflight(cfg):
    directory = cfg['private_root'] / ('public_preflight_' + datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
                                      + '_' + uuid.uuid4().hex[:12])
    directory.mkdir(exist_ok=False)
    restrict_output(directory)
    receipt = {'scope': 'k3_sandbox_public_auth_rest_preflight',
               'expectedSandboxRef': cfg['expectedSandboxRef'], 'configuration_sha256': config_binding(cfg),
               'started_at': timestamp(), 'checks': {name: {'passed': False, 'state': 'not_run'} for name in PUBLIC_CHECKS},
               'public_preflight_passed': False, 'error_code': None, 'password_login_attempts': 0,
               'credentials_recorded': False, 'tokens_recorded': False,
               'identities_recorded': False, 'response_content_recorded': False,
               'customer_or_staff_write_performed': False}
    try:
        perform_public_checks(cfg, receipt)
    except AuthRestError as error:
        code = str(error)
        receipt['error_code'] = code if re.fullmatch('[A-Z0-9_]{1,96}', code) else 'PUBLIC_PREFLIGHT_FAILED'
    except Exception:
        receipt['error_code'] = 'PUBLIC_PREFLIGHT_FAILED_NO_DETAILS_RECORDED'
    receipt['finished_at'] = timestamp()
    receipt['public_preflight_passed'] = all(item['passed'] for item in receipt['checks'].values())
    path = directory / 'public-preflight-receipt.json'
    write_json(path, receipt)
    return {'public_preflight_passed': receipt['public_preflight_passed'],
            'error_code': receipt['error_code'], 'receipt_path': str(path)}


def verified_public_preflight(cfg, filename):
    path = private_path(str(filename))
    if cfg['private_root'] not in path.parents or path.stat().st_size > 65536:
        raise AuthRestError('PRIVATE_PUBLIC_PREFLIGHT_REQUIRED')
    try:
        receipt = json.loads(path.read_text(encoding='utf8'))
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(receipt['finished_at'])).total_seconds()
    except (OSError, ValueError, KeyError, TypeError):
        raise AuthRestError('PUBLIC_PREFLIGHT_RECEIPT_INVALID') from None
    expected_status = {'auth_health': {200}, 'openapi_restricted': {401}, 'rest_ready': {200},
                       'public_offers': {200}, 'anon_queue_denied': {401, 403}, 'anon_core_denied': {406}}
    if not isinstance(receipt, dict) or receipt.get('scope') != 'k3_sandbox_public_auth_rest_preflight' \
            or receipt.get('expectedSandboxRef') != cfg['expectedSandboxRef'] \
            or receipt.get('configuration_sha256') != config_binding(cfg) \
            or receipt.get('public_preflight_passed') is not True \
            or receipt.get('password_login_attempts') != 0 \
            or receipt.get('customer_or_staff_write_performed') is not False \
            or not isinstance(receipt.get('checks'), dict) or set(receipt['checks']) != set(PUBLIC_CHECKS) \
            or age < 0 or age > 600:
        raise AuthRestError('FRESH_TARGET_BOUND_PUBLIC_PREFLIGHT_REQUIRED')
    safe = {}
    for name in PUBLIC_CHECKS:
        item = receipt['checks'][name]
        if not isinstance(item, dict) or item.get('passed') is not True or item.get('state') != 'passed' \
                or type(item.get('http_status')) is not int or item['http_status'] not in expected_status[name]:
            raise AuthRestError('PUBLIC_PREFLIGHT_CHECK_NOT_VERIFIED')
        safe[name] = {'passed': True, 'state': 'passed', 'http_status': item['http_status']}
    return safe


def run_checks(cfg, email, password, preflight_receipt=None):
    if not isinstance(email, str) or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', email) or len(email) > 254 \
            or not isinstance(password, str) or not password:
        raise AuthRestError('STAFF_EMAIL_AND_AUTH_PASSWORD_REQUIRED')
    directory = cfg['private_root'] / ('auth_rest_' + datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
                                      + '_' + uuid.uuid4().hex[:12])
    directory.mkdir(exist_ok=False)
    restrict_output(directory)  # Must finish before any HTTP call.
    receipt = {'scope': 'k3_sandbox_auth_rest_read_only_acceptance',
               'expectedSandboxRef': cfg['expectedSandboxRef'], 'started_at': timestamp(),
               'checks': {name: {'passed': False, 'state': 'not_run'} for name in CHECKS},
               'real_auth_rest_verified': False, 'error_code': None,
               'credentials_recorded': False, 'tokens_recorded': False,
               'identities_recorded': False, 'response_content_recorded': False,
               'customer_or_staff_write_performed': False, 'password_login_attempts': 0}
    token = None
    def check(name, passed, status=None):
        record_check(receipt, name, passed, status)
    def call(method, route, **kwargs):
        return request(cfg, method, route, **kwargs)
    try:
        if preflight_receipt is None:
            perform_public_checks(cfg, receipt)
        else:
            receipt['checks'].update(verified_public_preflight(cfg, preflight_receipt))
        receipt['password_login_attempts'] = 1
        status, body = call('POST', '/auth/v1/token?grant_type=password', body={'email': email, 'password': password})
        if status == 200 and isinstance(body, dict):
            token = body.get('access_token')
            body.clear()  # User/refresh-token response values have no reporting path.
        check('password_sign_in', status == 200 and isinstance(token, str) and bool(token), status)
        email = password = None
        check('jwt_target_claims', jwt_target_verified(token, cfg))
        # Claims are decoded locally for target binding, not a local signature
        # verification claim. The following server-authorized RPC proves that
        # this sandbox accepts the authenticated session.
        status, body = call('POST', '/rest/v1/rpc/crm_staff_authorized_v1', body={}, token=token)
        check('staff_authorized', status == 200 and body is True, status)
        status, body = call('POST', '/rest/v1/rpc/crm_follow_up_queue_v1', body=QUEUE_ARGUMENTS, token=token)
        check('staff_queue_read', status == 200 and queue_shape(body), status)
        body = None  # Do not return/persist names, notes, customer IDs or items.
        status, body = call('GET', '/rest/v1/customers?select=id&limit=0', token=token, profile='core')
        check('staff_core_denied', status == 406 and isinstance(body, dict) and body.get('code') == 'PGRST106', status)
    except AuthRestError as error:
        code = str(error)
        receipt['error_code'] = code if re.fullmatch('[A-Z0-9_]{1,96}', code) \
            else 'AUTH_REST_TEST_FAILED_NO_DETAILS_RECORDED'
    except Exception:
        receipt['error_code'] = 'AUTH_REST_TEST_FAILED_NO_DETAILS_RECORDED'
    finally:
        email = password = None
        if isinstance(token, str) and token:
            try:
                status, _ = call('POST', '/auth/v1/logout?scope=local', token=token)
                receipt['checks']['local_logout'] = {'passed': status in (200, 204),
                    'state': 'passed' if status in (200, 204) else 'failed', 'http_status': status}
            except Exception:
                receipt['checks']['local_logout'] = {'passed': False, 'state': 'failed', 'http_status': None}
            if not receipt['checks']['local_logout']['passed'] and receipt['error_code'] is None:
                receipt['error_code'] = 'LOCAL_SESSION_LOGOUT_NOT_VERIFIED'
        token = None
        receipt['finished_at'] = timestamp()
        receipt['real_auth_rest_verified'] = all(item['passed'] for item in receipt['checks'].values())
        write_json(directory / 'auth-rest-receipt.json', receipt)
    return {'real_auth_rest_verified': receipt['real_auth_rest_verified'],
            'error_code': receipt['error_code'], 'receipt_path': str(directory / 'auth-rest-receipt.json')}


def launch_gui(cfg, preflight_receipt=None):
    import tkinter as tk
    from tkinter import ttk
    window = tk.Tk()
    window.title('K3 — Sandbox Auth / REST kontrolü')
    panel = ttk.Frame(window, padding=20)
    panel.pack(fill='both', expand=True)
    ttk.Label(panel, text='Sandbox ref: ' + cfg['expectedSandboxRef'], wraplength=680).pack(anchor='w')
    ttk.Label(panel, text='Mevcut sandbox staff Auth hesabıyla tek giriş yapılır; '
              'read-only kontrollerden sonra yalnız bu oturum kapatılır.', wraplength=680).pack(anchor='w', pady=10)
    ttk.Label(panel, text='Staff Email').pack(anchor='w')
    email_entry = ttk.Entry(panel, width=65, state='disabled')
    email_entry.pack(anchor='w', pady=5)
    ttk.Label(panel, text='Mevcut staff Auth password (database password değil)').pack(anchor='w')
    password_entry = ttk.Entry(panel, show='●', width=65, state='disabled')
    password_entry.pack(anchor='w', pady=5)
    status = tk.StringVar(value='Önce public kontrol doğrulanır; Email/password alanları henüz kapalı.')
    ttk.Label(panel, textvariable=status, wraplength=680).pack(anchor='w', pady=10)
    busy = False
    attempted = False
    public_receipt = None
    def controls():
        enabled = public_receipt is not None and not busy and not attempted
        for control in (email_entry, password_entry, button):
            control.configure(state='normal' if enabled else 'disabled')
        public_button.configure(state='disabled' if busy or attempted else 'normal')
    def accept_preflight(path):
        nonlocal public_receipt
        try:
            verified_public_preflight(cfg, path)
            public_receipt = str(path)
            status.set('Public kontrol doğrulandı: root OpenAPI 401 koruması normal; REST RPC çalışıyor. '
                       'Şimdi mevcut staff Email ve Auth password alanlarını doldurun.')
        except AuthRestError as error:
            public_receipt = None
            status.set('Public kontrol hazır değil: ' + str(error) + '. Giriş bilgisi henüz istenmiyor.')
        controls()
    def finish_public(result):
        nonlocal busy, public_receipt
        busy = False
        if result.get('public_preflight_passed'):
            accept_preflight(result['receipt_path'])
        else:
            public_receipt = None
            status.set('Public kontrol tamamlanamadı: ' + str(result.get('error_code'))
                       + '. Staff giriş bilgileri kullanılmadı.')
            controls()
    def start_public():
        nonlocal busy
        if busy or attempted:
            return
        busy = True
        controls()
        status.set('Yalnız public bağlantı ve erişim sınırları kontrol ediliyor; staff girişi yapılmıyor.')
        def work():
            try:
                result = run_public_preflight(cfg)
            except Exception:
                result = {'public_preflight_passed': False, 'error_code': 'PUBLIC_PREFLIGHT_START_FAILED'}
            window.after(0, lambda: finish_public(result))
        threading.Thread(target=work, daemon=True).start()
    def finish(result):
        nonlocal busy
        busy = False
        status.set('Auth / REST kontrolleri doğrulandı. Özel receipt kaydedildi.' if result['real_auth_rest_verified']
                   else 'Kontrol tamamlanamadı: ' + str(result['error_code']) + '. Otomatik tekrar yapılmadı.')
    def start():
        nonlocal busy, attempted, public_receipt
        if busy or attempted:
            return
        try:
            verified_public_preflight(cfg, public_receipt)
        except AuthRestError:
            public_receipt = None
            status.set('Public kontrolü yenileyin; Email/password henüz kullanılmadı.')
            controls()
            return
        email, password = email_entry.get().strip(), password_entry.get()
        if not email or not password:
            status.set('Mevcut staff Email ve Auth password alanlarını doldurun.')
            return
        email_entry.delete(0, 'end')
        password_entry.delete(0, 'end')
        busy = attempted = True
        controls()
        status.set('Sandbox Auth / REST kontrolleri çalışıyor; pencereyi açık bırakın.')
        def work():
            try:
                result = run_checks(cfg, email, password, public_receipt)
            except Exception:
                result = {'real_auth_rest_verified': False, 'error_code': 'LOCAL_TEST_START_FAILED_NO_DETAILS_RECORDED'}
            window.after(0, lambda: finish(result))
        threading.Thread(target=work, daemon=True).start()
    public_button = ttk.Button(panel, text='Yalnız public kontrolü yap / yenile', command=start_public)
    public_button.pack(anchor='w', pady=8)
    button = ttk.Button(panel, text='Tek giriş ile Auth / REST kontrolünü başlat', command=start, state='disabled')
    button.pack(anchor='w', pady=8)
    window.protocol('WM_DELETE_WINDOW', lambda: status.set('Kontrol sürüyor; pencereyi açık bırakın.')
                    if busy else window.destroy())
    if preflight_receipt is not None:
        accept_preflight(preflight_receipt)
    else:
        controls()
    window.mainloop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True, type=Path)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--validate-config', action='store_true')
    mode.add_argument('--public-preflight', action='store_true')
    mode.add_argument('--gui', action='store_true')
    parser.add_argument('--preflight-receipt', type=Path, help='Fresh private public-preflight receipt for --gui.')
    args = parser.parse_args()
    cfg = configuration(args.config)
    if args.preflight_receipt is not None and not args.gui:
        raise AuthRestError('PREFLIGHT_RECEIPT_OPTION_GUI_ONLY')
    if args.gui:
        launch_gui(cfg, args.preflight_receipt)
    elif args.public_preflight:
        result = run_public_preflight(cfg)
        print(json.dumps(result))
        if result['public_preflight_passed'] is not True:
            raise SystemExit(2)
    else:
        print(json.dumps({'configuration_valid': True, 'http_calls_performed': False,
                          'expectedSandboxRef': cfg['expectedSandboxRef']}))


if __name__ == '__main__':
    try:
        main()
    except AuthRestError as error:
        print(str(error))
        raise SystemExit(2)
    except Exception:
        print('LOCAL_AUTH_REST_OPERATOR_FAILED_NO_DETAILS_PRINTED')
        raise SystemExit(2)
