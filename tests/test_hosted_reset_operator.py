"""No network, GUI, real credential, or PostgreSQL execution in these tests."""
import contextlib
from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch


SOURCE = Path(__file__).resolve().parents[1] / 'tools/test-env/hosted-reset-operator.py'
SPEC = importlib.util.spec_from_file_location('hosted_reset_operator', SOURCE)
operator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(operator)


class OperatorTests(unittest.TestCase):
    def setUp(self):
        self.fixture_parent = Path(__file__).resolve().parents[3] / 'tmp'
        self.temporary = tempfile.TemporaryDirectory(prefix='k3-operator-unit-', dir=self.fixture_parent)
        self.root = Path(self.temporary.name).resolve()
        self.private = self.root / 'private'
        self.private.mkdir()
        self.pg = self.root / 'pg'
        self.pg.mkdir()
        (self.pg / 'psql.exe').write_bytes(b'NOT AN EXECUTABLE')
        self.node = self.root / 'node.exe'
        self.node.write_bytes(b'NOT AN EXECUTABLE')
        self.ca = self.root / 'ca.crt'
        self.ca.write_text('TEST CA PLACEHOLDER')
        self.plan_path = self.private / 'operator-plan.json'
        self.plan_path.write_text('{}')
        self.sql = self.plan_path.with_suffix('.sql')
        self.sql.write_text('BEGIN; SELECT 1; COMMIT;')
        self.validator = self.root / 'validator.mjs'
        self.validator.write_text('// inert test placeholder')
        self.inspection_sql = self.root / 'inspect.sql'
        self.inspection_sql.write_text('BEGIN READ ONLY; SELECT 1; ROLLBACK;')
        self.constants = patch.multiple(operator, PLAN_VERIFIER=self.validator, INSPECTION_SQL=self.inspection_sql)
        self.constants.start()
        self.env = {
            'K3_SANDBOX_PROJECT_REF': 'a' * 20,
            'K3_PRODUCTION_PROJECT_REF': 'b' * 20,
            'K3_SANDBOX_HOST': 'aws-0-us-east-1.pooler.supabase.com',
            'K3_SANDBOX_PORT': '5432',
            'K3_SANDBOX_USER': 'postgres.' + 'a' * 20,
            'K3_SANDBOX_DATABASE': 'postgres',
            'K3_SANDBOX_SSLROOTCERT': str(self.ca),
            'K3_PG_BIN': str(self.pg), 'K3_NODE': str(self.node),
            'K3_RESET_PLAN': str(self.plan_path),
            'K3_RESET_PRIVATE_ROOT': str(self.private), 'K3_STAFF_ROLE': 'staff',
        }
        self.cfg = operator.config_for(self.env)
        self.plan = {
            'ready': True, 'scope': operator.VALIDATED_SCOPE,
            'expectedTestRef': 'a' * 20, 'expectedProdRef': 'b' * 20, 'staffRole': 'staff',
            'phase': 'legacy_sandbox',
            'sqlPath': str(self.sql), 'sqlSha256': operator.digest(self.sql),
            'planSha256': operator.digest(self.plan_path), 'gatesReceiptSha256': 'c' * 64,
            'sql_path': self.sql,
        }
        self.metadata_path = self.private / 'metadata.json'
        self.metadata_path.write_text('{}')
        self.inspection = {
            'scope': 'K3_OPERATOR_READ_ONLY_INSPECTION', 'sandbox_project_ref': 'a' * 20,
            'captured_at': datetime.now(timezone.utc).isoformat(),
            'metadata_path': str(self.metadata_path), 'metadata_sha256': operator.digest(self.metadata_path),
            'inspection_sql_sha256': self.cfg['inspection_sql_sha256'],
            'password_recorded': False, 'application_write_performed': False,
        }

    def tearDown(self):
        self.constants.stop()
        self.assertIn(self.fixture_parent.resolve(), self.root.parents)
        self.temporary.cleanup()

    def fake_validated_stdout(self, **changes):
        value = {k: v for k, v in self.plan.items() if k != 'sql_path'}
        value.update(changes)
        return subprocess.CompletedProcess([], 0, json.dumps(value).encode(), b'')

    def fake_process(self, *, returncode=0, stdout=None):
        process = MagicMock()
        process.returncode = returncode
        process.poll.return_value = returncode
        if stdout is None:
            stdout = json.dumps({'scope': operator.RESULT_SCOPE, 'reset_completed': True,
                                 'expected_test_ref': 'a' * 20, 'phase': 'legacy_sandbox',
                                 'configured_staff_role': 'staff', 'application_catalog_md5': 'e' * 32,
                                 'staff_identity_preserved': True, 'staff_active_preserved': True,
                                 'auth_identity_exported': False, 'managed_platform_preserved': True,
                                 'real_auth_rest_verified': False,
                                 'seed_counts': dict(operator.EXPECTED_SEED_COUNTS)}).encode()
        process.communicate.return_value = (stdout, b'PRIVATE SQL OR PASSWORD MUST NOT BE LOGGED')
        return process

    def test_configuration_is_local_only(self):
        with patch.object(operator.subprocess, 'run') as run, patch.object(operator.subprocess, 'Popen') as popen:
            self.assertEqual(operator.config_for(self.env)['STAFF_ROLE'], 'staff')
            run.assert_not_called()
            popen.assert_not_called()

    def test_distinct_target_refs_are_mandatory(self):
        for change in ({'K3_PRODUCTION_PROJECT_REF': 'a' * 20}, {'K3_SANDBOX_PROJECT_REF': 'invalid'}):
            with self.subTest(change=change), self.assertRaises(operator.OperatorError):
                operator.config_for(dict(self.env, **change))

    def test_only_bound_session_pooler_is_accepted(self):
        for key, value in [('K3_SANDBOX_HOST', 'db.' + 'a' * 20 + '.supabase.co'),
                           ('K3_SANDBOX_USER', 'postgres.' + 'b' * 20),
                           ('K3_SANDBOX_PORT', '6543'), ('K3_SANDBOX_DATABASE', 'other')]:
            with self.subTest(key=key), self.assertRaises(operator.OperatorError):
                operator.config_for(dict(self.env, **{key: value}))

    def test_staff_role_has_no_default_or_inference(self):
        for role in ('', 'admin', 'active'):
            with self.subTest(role=role), self.assertRaises(operator.OperatorError):
                operator.config_for(dict(self.env, K3_STAFF_ROLE=role))

    def test_plan_must_be_private_local_and_under_root(self):
        outside = self.root / 'outside.json'
        outside.write_text('{}')
        for value in (str(outside), '//remote/share/plan.json'):
            with self.subTest(value=value), self.assertRaises(operator.OperatorError):
                operator.config_for(dict(self.env, K3_RESET_PLAN=value))
        (self.private / '.git').mkdir()
        with self.assertRaises(operator.OperatorError):
            operator.config_for(self.env)

    def test_environment_is_minimal_and_tls_is_not_downgraded(self):
        env = operator.postgres_environment(self.cfg, 'FAKE-NOT-A-REAL-PASSWORD', {
            'PATH': 'os-path', 'PGHOST': 'wrong', 'PGPASSWORD': 'old', 'PGSERVICE': 'wrong',
            'DATABASE_URL': 'bad', 'NODE_OPTIONS': '--require=bad', 'API_TOKEN': 'bad',
        })
        self.assertEqual(env['PGSSLMODE'], 'verify-full')
        self.assertEqual(env['PGUSER'], 'postgres.' + 'a' * 20)
        self.assertEqual(env['PGPASSWORD'], 'FAKE-NOT-A-REAL-PASSWORD')
        self.assertNotIn('PGSERVICE', env)
        for name in ('DATABASE_URL', 'NODE_OPTIONS', 'API_TOKEN'):
            self.assertNotIn(name, env)
        read = operator.postgres_environment(self.cfg, 'FAKE', read_only=True)
        self.assertIn('default_transaction_read_only=on', read['PGOPTIONS'])

    def test_plan_validation_rechecks_target_role_and_hashes(self):
        for changes in ({'ready': False}, {'expectedTestRef': 'b' * 20}, {'staffRole': 'owner'},
                        {'scope': 'other'}, {'gatesReceiptSha256': ''}, {'sqlSha256': 'd' * 64}):
            with self.subTest(changes=changes), patch.object(operator.subprocess, 'run',
                 return_value=self.fake_validated_stdout(**changes)), self.assertRaises(operator.OperatorError):
                operator.validated_plan(self.cfg)

    def test_plan_validation_suppresses_child_diagnostics(self):
        failed = subprocess.CompletedProcess([], 2, b'PRIVATE', b'PASSWORD PRIVATE')
        with patch.object(operator.subprocess, 'run', return_value=failed):
            with self.assertRaisesRegex(operator.OperatorError, '^LOCAL_PLAN_OR_GATES_NOT_READY$'):
                operator.validated_plan(self.cfg)

    def test_successful_plan_validation_has_no_pg_environment_or_password(self):
        with patch.object(operator.subprocess, 'run', return_value=self.fake_validated_stdout()) as run:
            self.assertEqual(operator.validated_plan(self.cfg)['sql_path'], self.sql)
            args, kwargs = run.call_args
            self.assertIn('--validate-plan', args[0])
            self.assertNotIn('PGPASSWORD', kwargs['env'])
            self.assertNotIn('password', ' '.join(args[0]).lower())

    def test_ca_replacement_fails_before_verifier(self):
        self.ca.write_text('CHANGED')
        with patch.object(operator.subprocess, 'run') as run, self.assertRaises(operator.OperatorError):
            operator.validated_plan(self.cfg)
        run.assert_not_called()

    def test_read_only_inspection_uses_only_reviewed_sql_and_safe_receipt(self):
        stdout = json.dumps({'scope': 'approved_sandbox_read_only_metadata_not_install_or_restore',
                             'transaction_read_only': 'on', 'auth_identities_included': False,
                             'function_bodies_included': False}).encode()
        observed = {}
        def fake(args, **kwargs):
            observed.update(args=args, env=dict(kwargs['env']), sql=kwargs['input'])
            return subprocess.CompletedProcess(args, 0, stdout, b'PRIVATE')
        with patch.object(operator, 'restrict_directory'), patch.object(operator.subprocess, 'run', side_effect=fake):
            proof = operator.inspect_read_only(self.cfg, 'FAKE-NOT-A-REAL-PASSWORD')
        self.assertEqual(proof['application_write_performed'], False)
        self.assertIn('default_transaction_read_only=on', observed['env']['PGOPTIONS'])
        self.assertEqual(observed['sql'], self.inspection_sql.read_bytes())
        self.assertNotIn('FAKE-NOT-A-REAL-PASSWORD', ' '.join(observed['args']))
        operator.validate_inspection(self.cfg, proof)

    def test_read_only_inspection_failure_never_persists_native_output(self):
        failed = subprocess.CompletedProcess([], 1, b'PRIVATE', b'PASSWORD PRIVATE')
        with patch.object(operator, 'restrict_directory'), patch.object(operator.subprocess, 'run', return_value=failed):
            with self.assertRaisesRegex(operator.OperatorError, '^READ_ONLY_INSPECTION_FAILED$'):
                operator.inspect_read_only(self.cfg, 'FAKE')
        self.assertFalse(any(self.private.rglob('read-only-metadata.json')))
        diagnostic = json.loads((self.private/'operator-inspection-status.json').read_text())
        self.assertEqual(diagnostic['state'], 'failed')
        self.assertFalse(diagnostic['native_stderr_recorded'])
        self.assertFalse(diagnostic['application_write_performed'])
        self.assertNotIn('PASSWORD PRIVATE', json.dumps(diagnostic))

    def test_native_read_only_failures_are_fixed_categories_only(self):
        cases = [(b'could not translate host name: access is denied; PRIVATE', 'DNS_FAILED'),
                 (b'could not connect: Access is denied PRIVATE', 'NETWORK_ACCESS_DENIED'),
                 (b'password authentication failed PRIVATE', 'DATABASE_PASSWORD_REJECTED'),
                 (b'server certificate verify failed PRIVATE', 'TLS_VERIFY_FAILED'),
                 (b'permission denied for relation PRIVATE', 'READ_PERMISSION_DENIED'),
                 (b'connection timed out PRIVATE', 'CONNECTION_TIMEOUT')]
        for stderr, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(operator.safe_inspection_error(stderr), expected)
        failed = subprocess.CompletedProcess([], 1, b'', b'could not translate host name: PRIVATE')
        with patch.object(operator, 'restrict_directory'), patch.object(operator.subprocess, 'run', return_value=failed):
            with self.assertRaisesRegex(operator.OperatorError, '^DNS_FAILED$'):
                operator.inspect_read_only(self.cfg, 'FAKE')
        diagnostic = json.loads((self.private/'operator-inspection-status.json').read_text())
        self.assertEqual(diagnostic['error_code'], 'DNS_FAILED')
        self.assertNotIn('PRIVATE', json.dumps(diagnostic))

    def test_control_reason_distinguishes_pending_inspection_and_unchecked_target(self):
        state = dict(plan_ready=True, inspected=False, confirmed=False, held_password=False,
                     entered_password=True, busy=False, attempted=False)
        first = operator.gui_control_state(**state)
        self.assertTrue(first['inspect_enabled'])
        self.assertFalse(first['reset_enabled'])
        self.assertIn('1.', first['hint'])
        checked = operator.gui_control_state(**dict(state, inspected=True, held_password=True, entered_password=False))
        self.assertFalse(checked['reset_enabled'])
        self.assertIn('onay kutusunu', checked['hint'])
        self.assertTrue(operator.gui_control_state(**dict(state, inspected=True, held_password=True,
                                                        confirmed=True))['reset_enabled'])
        for change in ({'busy': True}, {'attempted': True}, {'plan_ready': False}, {'held_password': False}):
            candidate = dict(state, inspected=True, held_password=True, confirmed=True)
            candidate.update(change)
            self.assertFalse(operator.gui_control_state(**candidate)['reset_enabled'])

    def test_headless_gui_preserves_success_across_refresh_and_explains_checkbox(self):
        widgets, variables = [], []
        class Variable:
            def __init__(self, value=None):
                self.initial = self.value = value
                self.callbacks = []
                variables.append(self)
            def get(self): return self.value
            def set(self, value):
                self.value = value
                for callback in self.callbacks: callback('', '', '')
            def trace_add(self, _kind, callback): self.callbacks.append(callback)
        class Widget:
            def __init__(self, *_args, **kwargs):
                self.options, self.value, self.callbacks = kwargs, '', {}
                widgets.append(self)
            def pack(self, **_kwargs): pass
            def configure(self, **kwargs): self.options.update(kwargs)
            def get(self): return self.value
            def delete(self, *_args): self.value = ''
            def bind(self, event, callback): self.callbacks[event] = callback
        def exercise():
            password = next(w for w in widgets if w.options.get('show'))
            check = next(w for w in widgets if 'variable' in w.options)
            inspect = next(w for w in widgets if w.options.get('text', '').startswith('1.'))
            reset = next(w for w in widgets if w.options.get('text', '').startswith('2.'))
            refresh = next(w for w in widgets if w.options.get('text') == 'Yerel kanıtları tekrar kontrol et')
            password.value = 'FAKE-NOT-A-REAL-PASSWORD'
            password.callbacks['<KeyRelease>']()
            inspect.options['command']()
            status = next(v for v in variables if v.initial == 'Read-only kontrol henüz başlatılmadı.')
            self.assertIn('Read-only metadata kontrolü tamamlandı', status.get())
            self.assertEqual(reset.options['state'], 'disabled')
            refresh.options['command']()
            self.assertIn('Read-only metadata kontrolü tamamlandı', status.get())
            self.assertNotIn('Bağlantı henüz açılmadı', status.get())
            check.options['variable'].set(True)
            self.assertEqual(reset.options['state'], 'normal')
        window = SimpleNamespace(title=lambda *_: None, geometry=lambda *_: None,
                                 protocol=lambda *_: None, destroy=lambda: None,
                                 after=lambda delay, callback: callback() if delay == 0 else None,
                                 mainloop=exercise)
        tkinter = SimpleNamespace(Tk=lambda: window, StringVar=Variable, BooleanVar=Variable)
        ttk = SimpleNamespace(Frame=Widget, Label=Widget, Entry=Widget, Checkbutton=Widget, Button=Widget)
        tkinter.ttk = ttk
        with patch.dict('sys.modules', {'tkinter': tkinter, 'tkinter.ttk': ttk}), \
             patch.object(operator, 'config_for', return_value=self.cfg), \
             patch.object(operator, 'validated_plan', return_value=self.plan), \
             patch.object(operator, 'inspect_read_only', return_value=self.inspection), \
             patch.object(operator.threading, 'Thread', side_effect=lambda *, target, **_kwargs: SimpleNamespace(start=target)), \
             patch.object(operator.subprocess, 'Popen') as native:
            operator.launch_gui()
            native.assert_not_called()

    def test_inspection_must_be_fresh_target_bound_and_unchanged(self):
        bad_cases = [dict(self.inspection, sandbox_project_ref='b' * 20),
                     dict(self.inspection, captured_at=(datetime.now(timezone.utc)-timedelta(minutes=11)).isoformat()),
                     dict(self.inspection, metadata_sha256='e' * 64)]
        for case in bad_cases:
            with self.subTest(case=case), self.assertRaises(operator.OperatorError):
                operator.validate_inspection(self.cfg, case)

    def test_apply_requires_confirmation_and_inspection_before_any_process(self):
        for phrase, inspected in (('', self.inspection), (operator.CONFIRMATION, {})):
            with patch.object(operator.subprocess, 'Popen') as process, patch.object(operator, 'validated_plan') as check:
                with self.assertRaises(operator.OperatorError):
                    operator.operate(self.cfg, 'FAKE', phrase, self.plan, inspected)
                process.assert_not_called()
                check.assert_not_called()

    def test_apply_gates_are_rechecked_after_operator_confirmation(self):
        changed = dict(self.plan, gatesReceiptSha256='d' * 64)
        with patch.object(operator, 'validated_plan', side_effect=[self.plan, changed]), \
             patch.object(operator, 'restrict_directory'), patch.object(operator.subprocess, 'Popen') as process:
            with self.assertRaisesRegex(operator.OperatorError, 'PLAN_OR_GATES_CHANGED_NO_CONNECTION'):
                operator.operate(self.cfg, 'FAKE', operator.CONFIRMATION, self.plan, self.inspection)
            process.assert_not_called()

    def test_apply_sends_password_only_in_environment_and_does_not_save_native_output(self):
        process = self.fake_process()
        observed = {}
        def fake(args, **kwargs):
            observed.update(args=args, env=dict(kwargs['env']))
            return process
        with patch.object(operator, 'validated_plan', return_value=self.plan), \
             patch.object(operator, 'restrict_directory'), patch.object(operator.subprocess, 'Popen', side_effect=fake):
            proof = operator.operate(self.cfg, 'FAKE-NOT-A-REAL-PASSWORD', operator.CONFIRMATION, self.plan, self.inspection)
        self.assertTrue(proof['reset_completed'])
        self.assertTrue(proof['independent_read_only_readback_pending'])
        self.assertEqual(proof['application_catalog_md5'], 'e' * 32)
        self.assertEqual(proof['phase'], 'legacy_sandbox')
        self.assertEqual(proof['configured_staff_role'], 'staff')
        self.assertEqual(proof['expected_test_ref'], self.cfg['SANDBOX_PROJECT_REF'])
        self.assertEqual(proof['seed_counts'], operator.EXPECTED_SEED_COUNTS)
        self.assertNotIn('FAKE-NOT-A-REAL-PASSWORD', ' '.join(observed['args']))
        self.assertEqual(observed['env']['PGPASSWORD'], 'FAKE-NOT-A-REAL-PASSWORD')
        self.assertEqual(process.communicate.call_args.kwargs['input'], self.sql.read_bytes())
        serialized = '\n'.join(p.read_text() for p in self.private.rglob('*.json'))
        self.assertNotIn('FAKE-NOT-A-REAL-PASSWORD', serialized)
        self.assertNotIn('PRIVATE SQL OR PASSWORD', serialized)

    def test_success_receipt_requires_exact_target_phase_role_and_seed_contract(self):
        raw = self.fake_process().communicate.return_value[0]
        original = json.loads(raw)
        changes = [
            {'expected_test_ref': 'b' * 20}, {'configured_staff_role': 'owner'},
            {'phase': 'reviewed_baseline'}, {'phase': 'unknown'},
            {'application_catalog_md5': 'not-a-hash'}, {'staff_active_preserved': False},
            {'managed_platform_preserved': False}, {'real_auth_rest_verified': True},
            {'seed_counts': dict(operator.EXPECTED_SEED_COUNTS, customers=4)},
            {'seed_counts': dict(operator.EXPECTED_SEED_COUNTS, businesses=True)},
        ]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(operator.OperatorError):
                operator.parse_success(json.dumps(dict(original, **change)).encode(), self.cfg, self.plan)

    def test_success_receipt_drops_unexpected_native_values(self):
        original = json.loads(self.fake_process().communicate.return_value[0])
        original.update(auth_user_id='MUST NOT BE PERSISTED', raw_output='MUST NOT BE PERSISTED')
        safe = operator.parse_success(json.dumps(original).encode(), self.cfg, self.plan)
        self.assertNotIn('auth_user_id', safe)
        self.assertNotIn('raw_output', safe)

    def test_nonzero_exit_is_unknown_even_if_success_receipt_was_printed(self):
        process = self.fake_process(returncode=1)
        with patch.object(operator, 'validated_plan', return_value=self.plan), \
             patch.object(operator, 'restrict_directory'), patch.object(operator.subprocess, 'Popen', return_value=process):
            with self.assertRaisesRegex(operator.OperatorError, '^RESET_OUTCOME_UNKNOWN_NO_RETRY$'):
                operator.operate(self.cfg, 'FAKE', operator.CONFIRMATION, self.plan, self.inspection)
        self.assertFalse(any(self.private.rglob('operator-result.json')))
        self.assertEqual(json.loads((self.private/'operator-status.json').read_text())['status'], 'outcome_unknown')

    def test_missing_success_receipt_is_unknown(self):
        process = self.fake_process(stdout=b'not the expected receipt')
        with patch.object(operator, 'validated_plan', return_value=self.plan), \
             patch.object(operator, 'restrict_directory'), patch.object(operator.subprocess, 'Popen', return_value=process):
            with self.assertRaises(operator.OperatorError):
                operator.operate(self.cfg, 'FAKE', operator.CONFIRMATION, self.plan, self.inspection)
        self.assertFalse(any(self.private.rglob('operator-result.json')))

    def test_used_plan_cannot_be_retried(self):
        (self.private/('attempt-'+self.plan['planSha256']+'.json')).write_text('{}')
        with patch.object(operator, 'validated_plan', return_value=self.plan), patch.object(operator.subprocess, 'Popen') as process:
            with self.assertRaisesRegex(operator.OperatorError, 'PLAN_ALREADY_ATTEMPTED'):
                operator.operate(self.cfg, 'FAKE', operator.CONFIRMATION, self.plan, self.inspection)
            process.assert_not_called()

    def test_timeout_is_unknown_and_never_automatically_resubmitted(self):
        process = self.fake_process()
        process.communicate.side_effect = [subprocess.TimeoutExpired('psql', 240), (b'', b'')]
        with patch.object(operator, 'validated_plan', return_value=self.plan), \
             patch.object(operator, 'restrict_directory'), patch.object(operator.subprocess, 'Popen', return_value=process) as popen:
            with self.assertRaisesRegex(operator.OperatorError, '^RESET_OUTCOME_UNKNOWN_NO_RETRY$'):
                operator.operate(self.cfg, 'FAKE', operator.CONFIRMATION, self.plan, self.inspection)
        self.assertEqual(popen.call_count, 1)
        process.kill.assert_called_once()

    def test_console_validation_never_launches_operator(self):
        with patch('sys.argv', ['operator', '--validate-config']), patch.object(operator, 'config_for', return_value=self.cfg), \
             patch.object(operator, 'validated_plan', return_value=self.plan), patch.object(operator, 'operate') as apply, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            operator.main()
            self.assertFalse(json.loads(output.getvalue())['database_connection_started'])
            apply.assert_not_called()

    def test_no_cli_password_or_execute_argument(self):
        with patch('sys.argv', ['operator', '--execute']), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                operator.main()


if __name__ == '__main__':
    unittest.main()
