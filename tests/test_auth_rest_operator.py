"""Mocked HTTP only: no real Auth account, GUI, database or network execution."""
import base64
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
import uuid


SOURCE = Path(__file__).resolve().parents[1] / 'tools/test-env/auth-rest-operator.py'
SPEC = importlib.util.spec_from_file_location('auth_rest_operator', SOURCE)
operator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(operator)


class AuthRestTests(unittest.TestCase):
    def setUp(self):
        self.parent = Path(__file__).resolve().parents[3] / 'tmp'
        self.temp = tempfile.TemporaryDirectory(prefix='k3-auth-rest-unit-', dir=self.parent)
        self.root = Path(self.temp.name).resolve()
        self.private = self.root/'private'
        self.private.mkdir()
        self.guard = self.root/'guard.ts'
        self.guard.write_text('export const PRODUCTION_SUPABASE_URL = "https://'+'b'*20+'.supabase.co";')
        self.business = str(uuid.uuid4())
        self.baseline = self.root/'baseline.sql'
        self.baseline.write_text("CONSTRAINT businesses_id_check CHECK ((id = '"+self.business+"'::uuid))")
        self.constants = patch.multiple(operator, PRODUCTION_GUARD=self.guard, BASELINE=self.baseline)
        self.constants.start()
        self.cfg_path = self.private/'config.json'
        self.original = {'expectedSandboxRef': 'a'*20, 'productionRef': 'b'*20,
                         'sandboxUrl': 'https://'+'a'*20+'.supabase.co',
                         'publishableKey': 'sb_publishable_'+'p'*32,
                         'testBusinessId': self.business, 'privateRoot': str(self.private)}
        self.cfg_path.write_text(json.dumps(self.original))
        self.cfg = operator.configuration(self.cfg_path)
        self.token = self.jwt()
        self.calls = []
        self.overrides = {}

    def tearDown(self):
        self.constants.stop()
        self.assertIn(self.parent.resolve(), self.root.parents)
        self.temp.cleanup()

    def jwt(self, **changes):
        encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
        claims = {'iss': self.original['sandboxUrl']+'/auth/v1', 'role': 'authenticated',
                  'exp': int(time.time())+3600, 'sub': 'FAKE-PRIVATE-IDENTITY'}
        claims.update(changes)
        return encode({'alg': 'HS256', 'typ': 'JWT'})+'.'+encode(claims)+'.FAKE_SIGNATURE'

    def fake_http(self, cfg, method, route, **kwargs):
        self.assertEqual(cfg['sandboxUrl'], self.original['sandboxUrl'])
        self.calls.append((method, route, kwargs))
        key = (route, bool(kwargs.get('token')))
        if key in self.overrides:
            value = self.overrides[key]
            if isinstance(value, Exception): raise value
            return value
        if route == '/auth/v1/health': return 200, {'healthy': True}
        if route == '/rest/v1/': return 401, {'message': 'Secret API key required'}
        if route == '/rest/v1/rpc/get_active_offers': return 200, []
        if route == '/rest/v1/customers?select=id&limit=0': return 406, {'code': 'PGRST106', 'message': 'PRIVATE DO NOT LOG'}
        if route == '/auth/v1/token?grant_type=password':
            return 200, {'access_token': self.token, 'refresh_token': 'FAKE_REFRESH_TOKEN',
                         'user': {'id': 'FAKE-PRIVATE-IDENTITY', 'email': 'staff@example.invalid'}}
        if route == '/auth/v1/logout?scope=local': return 204, None
        if route == '/rest/v1/rpc/crm_staff_authorized_v1': return 200, True
        if route == '/rest/v1/rpc/crm_follow_up_queue_v1':
            if not kwargs.get('token'): return 401, {'code': '42501'}
            return 200, {'queue': 'open_catering', 'offset': 0, 'page_size': 25, 'total': 1,
                         'generated_at': datetime.now(timezone.utc).isoformat(),
                         'counts': {key: 0 for key in operator.COUNT_KEYS},
                         'items': [{'customer_name': 'FAKE CUSTOMER CONTENT', 'customer_id': 'FAKE-PRIVATE-IDENTITY'}]}
        raise AssertionError('Unexpected route')

    def run_flow(self):
        with patch.object(operator, 'restrict_output'), patch.object(operator, 'request', side_effect=self.fake_http):
            return operator.run_checks(self.cfg, 'staff@example.invalid', 'FAKE_AUTH_PASSWORD')

    def read_receipt(self, result):
        return json.loads(Path(result['receipt_path']).read_text())

    def test_config_validation_is_inert_and_contains_no_user_credentials(self):
        with patch.object(operator, 'request') as http:
            operator.configuration(self.cfg_path)
            http.assert_not_called()
        self.cfg_path.write_text(json.dumps(dict(self.original, password='FAKE')))
        with self.assertRaisesRegex(operator.AuthRestError, 'NO_CREDENTIAL_FIELDS'):
            operator.configuration(self.cfg_path)

    def test_production_ref_and_origin_cannot_be_relabelled(self):
        for changes in ({'expectedSandboxRef': 'b'*20, 'sandboxUrl': 'https://'+'b'*20+'.supabase.co'},
                        {'productionRef': 'c'*20}, {'sandboxUrl': self.original['sandboxUrl']+'?x=1'},
                        {'sandboxUrl': 'http://'+'a'*20+'.supabase.co'},
                        {'sandboxUrl': 'https://user:password@'+'a'*20+'.supabase.co'},
                        {'sandboxUrl': self.original['sandboxUrl']+'/auth/v1'}):
            with self.subTest(changes=changes):
                self.cfg_path.write_text(json.dumps(dict(self.original, **changes)))
                with self.assertRaises(operator.AuthRestError): operator.configuration(self.cfg_path)

    def test_secret_keys_and_unknown_business_are_rejected(self):
        for changes in ({'publishableKey': 'sb_secret_'+'s'*32}, {'testBusinessId': str(uuid.uuid4())}):
            self.cfg_path.write_text(json.dumps(dict(self.original, **changes)))
            with self.assertRaises(operator.AuthRestError): operator.configuration(self.cfg_path)

    def test_all_checks_succeed_and_receipt_cannot_contain_response_or_credentials(self):
        result = self.run_flow()
        self.assertTrue(result['real_auth_rest_verified'])
        receipt = self.read_receipt(result)
        self.assertEqual(set(receipt['checks']), set(operator.CHECKS))
        self.assertEqual(receipt['password_login_attempts'], 1)
        serialized = json.dumps(receipt)
        for forbidden in ('FAKE_AUTH_PASSWORD', self.token, 'FAKE_REFRESH_TOKEN', 'staff@example.invalid',
                          'FAKE-PRIVATE-IDENTITY', 'FAKE CUSTOMER CONTENT', self.original['publishableKey'],
                          'PRIVATE DO NOT LOG'):
            self.assertNotIn(forbidden, serialized)
        self.assertEqual(sum(route == '/auth/v1/token?grant_type=password' for _, route, _ in self.calls), 1)
        self.assertEqual(self.calls[-1][1], '/auth/v1/logout?scope=local')

    def public_flow(self):
        with patch.object(operator, 'restrict_output'), patch.object(operator, 'request', side_effect=self.fake_http):
            return operator.run_public_preflight(self.cfg)

    def test_public_preflight_accepts_restricted_openapi_and_proves_rpc_readiness_without_login(self):
        result = self.public_flow()
        self.assertTrue(result['public_preflight_passed'])
        receipt = json.loads(Path(result['receipt_path']).read_text())
        self.assertEqual(receipt['checks']['openapi_restricted']['http_status'], 401)
        self.assertEqual(receipt['checks']['rest_ready']['http_status'], 200)
        self.assertEqual(receipt['password_login_attempts'], 0)
        self.assertFalse(any('/auth/v1/token' in route or 'logout' in route for _, route, _ in self.calls))
        self.assertEqual(set(operator.verified_public_preflight(self.cfg, result['receipt_path'])), set(operator.PUBLIC_CHECKS))
        self.assertNotIn(self.original['publishableKey'], Path(result['receipt_path']).read_text())

    def test_openapi_restriction_does_not_hide_an_invalid_key_or_rpc_failure(self):
        self.overrides[('/rest/v1/', False)] = (401, {'message': 'Invalid API key'})
        result = self.public_flow()
        self.assertFalse(result['public_preflight_passed'])
        self.assertEqual(result['error_code'], 'CHECK_FAILED_OPENAPI_RESTRICTED')
        self.overrides.clear()
        self.overrides[('/rest/v1/rpc/get_active_offers', False)] = (503, {'message': 'Unavailable'})
        self.assertEqual(self.public_flow()['error_code'], 'CHECK_FAILED_REST_READY')
        self.assertFalse(any('/auth/v1/token' in route for _, route, _ in self.calls))

    def test_fresh_preflight_reuse_skips_setup_calls_and_still_allows_only_one_login(self):
        preflight = self.public_flow()
        self.calls.clear()
        with patch.object(operator, 'restrict_output'), patch.object(operator, 'request', side_effect=self.fake_http):
            result = operator.run_checks(self.cfg, 'staff@example.invalid', 'FAKE_AUTH_PASSWORD', preflight['receipt_path'])
        self.assertTrue(result['real_auth_rest_verified'])
        self.assertEqual(self.calls[0][1], '/auth/v1/token?grant_type=password')
        self.assertEqual(sum('/auth/v1/token' in route for _, route, _ in self.calls), 1)
        self.assertFalse(any(route == '/rest/v1/' for _, route, _ in self.calls))

    def test_stale_or_changed_config_preflight_cannot_start_password_grant(self):
        preflight = self.public_flow()
        path = Path(preflight['receipt_path'])
        receipt = json.loads(path.read_text())
        receipt['finished_at'] = (datetime.now(timezone.utc)-timedelta(minutes=11)).isoformat()
        path.write_text(json.dumps(receipt))
        self.calls.clear()
        with patch.object(operator, 'restrict_output'), patch.object(operator, 'request', side_effect=self.fake_http):
            result = operator.run_checks(self.cfg, 'staff@example.invalid', 'FAKE_AUTH_PASSWORD', path)
        self.assertFalse(result['real_auth_rest_verified'])
        self.assertFalse(self.calls)
        receipt['finished_at'] = datetime.now(timezone.utc).isoformat()
        receipt['configuration_sha256'] = '0'*64
        path.write_text(json.dumps(receipt))
        with self.assertRaises(operator.AuthRestError): operator.verified_public_preflight(self.cfg, path)

    def test_headless_gui_unlocks_credentials_only_after_fresh_public_preflight(self):
        preflight = self.public_flow()
        self.calls.clear()
        widgets = []
        class Variable:
            def __init__(self, value=None): self.value = value
            def set(self, value): self.value = value
            def get(self): return self.value
        class Widget:
            def __init__(self, *_args, **kwargs):
                self.options, self.value, self.get_count = kwargs, '', 0
                widgets.append(self)
            def pack(self, **_kwargs): pass
            def configure(self, **kwargs): self.options.update(kwargs)
            def get(self):
                self.get_count += 1
                return self.value
            def delete(self, *_args): self.value = ''
        def exercise():
            inputs = [w for w in widgets if w.options.get('width') == 65]
            login = next(w for w in widgets if w.options.get('text', '').startswith('Tek giriş'))
            public = next(w for w in widgets if w.options.get('text', '').startswith('Yalnız public kontrolü'))
            self.assertTrue(all(w.options['state'] == 'disabled' for w in inputs))
            self.assertEqual(login.options['state'], 'disabled')
            login.options['command']()
            self.assertTrue(all(w.get_count == 0 for w in inputs))
            public.options['command']()
            self.assertTrue(all(w.options['state'] == 'normal' for w in inputs))
            self.assertEqual(login.options['state'], 'normal')
            receipt = json.loads(Path(preflight['receipt_path']).read_text())
            receipt['finished_at'] = (datetime.now(timezone.utc)-timedelta(minutes=11)).isoformat()
            Path(preflight['receipt_path']).write_text(json.dumps(receipt))
            login.options['command']()
            self.assertTrue(all(w.get_count == 0 for w in inputs))
            self.assertEqual(login.options['state'], 'disabled')
        window = SimpleNamespace(title=lambda *_: None, protocol=lambda *_: None, destroy=lambda: None,
                                 after=lambda delay, callback: callback() if delay == 0 else None, mainloop=exercise)
        ttk = SimpleNamespace(Frame=Widget, Label=Widget, Entry=Widget, Button=Widget)
        tkinter = SimpleNamespace(Tk=lambda: window, StringVar=Variable, ttk=ttk)
        with patch.dict('sys.modules', {'tkinter': tkinter, 'tkinter.ttk': ttk}), \
             patch.object(operator, 'run_public_preflight', return_value=preflight), \
             patch.object(operator.threading, 'Thread', side_effect=lambda *, target, **_kwargs: SimpleNamespace(start=target)), \
             patch.object(operator, 'request') as http:
            operator.launch_gui(self.cfg)
            http.assert_not_called()

    def test_private_core_must_fail_with_exact_schema_denial_before_sign_in(self):
        for status, payload in ((200, []), (403, {'code': '42501'}), (406, {'code': 'other'})):
            self.calls.clear()
            self.overrides[('/rest/v1/customers?select=id&limit=0', False)] = (status, payload)
            result = self.run_flow()
            self.assertFalse(result['real_auth_rest_verified'])
            self.assertFalse(any('/auth/v1/token' in route for _, route, _ in self.calls))

    def test_anonymous_queue_success_is_failure_not_empty_data_proof(self):
        self.overrides[('/rest/v1/rpc/crm_follow_up_queue_v1', False)] = (200, {})
        result = self.run_flow()
        self.assertEqual(result['error_code'], 'CHECK_FAILED_ANON_QUEUE_DENIED')
        self.assertEqual(self.read_receipt(result)['password_login_attempts'], 0)

    def test_password_rejection_is_one_attempt_and_never_sends_reset_email(self):
        self.overrides[('/auth/v1/token?grant_type=password', False)] = (400, {'error_description': 'FAKE PRIVATE DETAILS'})
        result = self.run_flow()
        self.assertEqual(result['error_code'], 'CHECK_FAILED_PASSWORD_SIGN_IN')
        self.assertEqual(self.read_receipt(result)['password_login_attempts'], 1)
        self.assertFalse(any('recover' in route or 'signup' in route or 'admin' in route for _, route, _ in self.calls))
        self.assertFalse(any('/auth/v1/logout' in route for _, route, _ in self.calls))

    def test_wrong_issuer_or_role_logs_out_only_current_sandbox_session(self):
        for token in (self.jwt(iss='https://'+'b'*20+'.supabase.co/auth/v1'), self.jwt(role='service_role'), self.jwt(exp=0)):
            self.calls.clear()
            self.token = token
            result = self.run_flow()
            self.assertEqual(result['error_code'], 'CHECK_FAILED_JWT_TARGET_CLAIMS')
            self.assertEqual(self.calls[-1][1], '/auth/v1/logout?scope=local')
            self.assertFalse(any(route.endswith('crm_staff_authorized_v1') for _, route, _ in self.calls))

    def test_staff_authorization_failure_still_attempts_local_logout(self):
        self.overrides[('/rest/v1/rpc/crm_staff_authorized_v1', True)] = (200, False)
        result = self.run_flow()
        self.assertFalse(result['real_auth_rest_verified'])
        self.assertEqual(self.calls[-1][1], '/auth/v1/logout?scope=local')

    def test_queue_shape_errors_and_staff_core_exposure_cannot_pass(self):
        self.overrides[('/rest/v1/rpc/crm_follow_up_queue_v1', True)] = (200, {'items': []})
        self.assertEqual(self.run_flow()['error_code'], 'CHECK_FAILED_STAFF_QUEUE_READ')
        self.overrides.clear()
        self.overrides[('/rest/v1/customers?select=id&limit=0', True)] = (200, [])
        self.assertEqual(self.run_flow()['error_code'], 'CHECK_FAILED_STAFF_CORE_DENIED')

    def test_logout_failure_prevents_acceptance(self):
        self.overrides[('/auth/v1/logout?scope=local', True)] = (500, {'message': 'PRIVATE'})
        result = self.run_flow()
        self.assertFalse(result['real_auth_rest_verified'])
        self.assertEqual(result['error_code'], 'LOCAL_SESSION_LOGOUT_NOT_VERIFIED')

    def test_raw_transport_exceptions_do_not_reach_receipts_and_are_not_retried(self):
        self.overrides[('/auth/v1/token?grant_type=password', False)] = RuntimeError('FAKE_PASSWORD AND PRIVATE TOKEN')
        result = self.run_flow()
        self.assertNotIn('PRIVATE', json.dumps(self.read_receipt(result)))
        self.assertEqual(sum('/auth/v1/token' in route for _, route, _ in self.calls), 1)

    def test_route_allowlist_blocks_writes_and_global_logout_before_http(self):
        for method, route in [('POST', '/auth/v1/recover'), ('POST', '/auth/v1/admin/users'),
                              ('POST', '/rest/v1/rpc/crm_add_note'), ('POST', '/auth/v1/logout?scope=global')]:
            with patch.object(operator.urllib.request, 'build_opener') as opener:
                with self.assertRaises(operator.AuthRestError): operator.request(self.cfg, method, route)
                opener.assert_not_called()

    def test_http_uses_verified_tls_no_proxy_redirect_and_profile_header(self):
        response = MagicMock()
        response.code = 406
        response.read.return_value = b'{"code":"PGRST106"}'
        response.__enter__.return_value = response
        opener = MagicMock()
        opener.open.return_value = response
        with patch.object(operator.urllib.request, 'build_opener', return_value=opener) as build:
            status, body = operator.request(self.cfg, 'GET', '/rest/v1/customers?select=id&limit=0', profile='core')
        self.assertEqual((status, body['code']), (406, 'PGRST106'))
        req = opener.open.call_args.args[0]
        self.assertEqual(req.headers['Accept-profile'], 'core')
        self.assertNotIn('Authorization', req.headers)
        self.assertTrue(any(isinstance(x, operator.NoRedirect) for x in build.call_args.args))
        https = next(x for x in build.call_args.args if isinstance(x, operator.urllib.request.HTTPSHandler))
        self.assertTrue(https._context.check_hostname)
        self.assertEqual(https._context.verify_mode, operator.ssl.CERT_REQUIRED)
        self.assertIsNone(operator.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.invalid'))

    def test_blank_or_malformed_credentials_never_make_http_calls(self):
        for email, password in (('', 'FAKE'), ('invalid', 'FAKE'), ('staff@example.invalid', '')):
            with patch.object(operator, 'request') as http:
                with self.assertRaises(operator.AuthRestError): operator.run_checks(self.cfg, email, password)
                http.assert_not_called()


if __name__ == '__main__':
    unittest.main()
