"""K5 operator security tests. Inert files, mocked subprocess and Tk only.

No executable/database/provider/Auth/account or password source is accessed.
"""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'tools/test-env/k5-migrate.py'
SPEC = importlib.util.spec_from_file_location('k5_operator', SOURCE)
operator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(operator)


def acceptance():
    checks = [{'name': 'synthetic_check_' + str(i), 'passed': True} for i in range(17)]
    return {'scope': operator.ACCEPTANCE_SCOPE, 'passed': 17, 'failed': 0, 'checks': checks,
            'missing': [], 'provider_calls': 0, 'account_operations': 0,
            'auth_http_claimed': False, 'fixtures_rolled_back': True}


def preflight(target='test'):
    return {'scope': 'K5_READ_ONLY_PREFLIGHT', 'read_only': True, 'database': 'postgres',
            'business_count': 1, 'business_marked_test': target == 'test',
            'all_businesses_test': target == 'test', 'core_closed': True,
            'baseline_and_k4_present': True, 'k5_objects': 0}


class K5OperatorTests(unittest.TestCase):
    def setUp(self):
        checkout = Path(__file__).resolve().parents[1]
        self.temp = tempfile.TemporaryDirectory(prefix='k5-operator-unit-', dir=checkout)
        self.root = Path(self.temp.name).resolve()
        self.assertTrue(self.root.is_relative_to(checkout))
        self.addCleanup(self.temp.cleanup)
        self.migration = self.root / 'migration.sql'
        self.migration.write_bytes(b'BEGIN;\nSELECT 42;\nCOMMIT;\n')
        self.acceptance = self.root / 'acceptance.sql'
        self.acceptance.write_bytes(b'BEGIN;\nSELECT 17;\nROLLBACK;\n')
        self.psql = self.root / 'psql.exe'
        self.psql.write_bytes(b'INERT_SYNTHETIC_PSQL')
        self.ca = self.root / 'fixture-ca.pem'
        self.ca.write_bytes(b'INERT_SYNTHETIC_CA')
        self.receipts = self.root / 'receipts'
        self.receipts.mkdir()
        self.path = self.root / 'config.json'
        self.config = {
            'migration': str(self.migration), 'migration_sha256': operator.sha(self.migration),
            'acceptance': str(self.acceptance), 'acceptance_sha256': operator.sha(self.acceptance),
            'psql_path': str(self.psql), 'psql_binary_sha256': operator.sha(self.psql),
            'psql_version': operator.PSQL_VERSION, 'ca_path': str(self.ca), 'ca_sha256': operator.sha(self.ca),
            'receipt_directory': str(self.receipts), 'acceptance_minimum_checks': 17,
            'targets': {
                'test': {'name': 'Synthetic test', 'ref': 'a' * 20,
                         'host': 'aws-0-us-east-1.pooler.supabase.com', 'port': 5432,
                         'business_id': '11111111-2222-3333-4444-555555555555'},
                'production': {'name': 'Synthetic production', 'ref': 'b' * 20,
                               'host': 'aws-0-us-east-1.pooler.supabase.com', 'port': 5432,
                               'business_id': '11111111-2222-3333-4444-555555555555'},
            },
        }
        self.write_config()
        self.hash_patch = patch.object(operator, 'APPROVED_MIGRATION_SHA256', self.config['migration_sha256'])
        self.hash_patch.start(); self.addCleanup(self.hash_patch.stop)
        self.runner = patch.object(operator.subprocess, 'run', side_effect=self.version_only)
        self.mock_run = self.runner.start(); self.addCleanup(self.runner.stop)
        self.calls = []

    def write_config(self):
        self.path.write_text(json.dumps(self.config), encoding='utf8')

    def version_only(self, args, **kwargs):
        self.assertEqual(args, [str(self.psql), '--version'])
        self.assertEqual(kwargs['timeout'], 10)
        self.assertFalse(any(key.upper().startswith('PG') for key in kwargs['env']))
        return subprocess.CompletedProcess(args, 0, (operator.PSQL_VERSION + '\n').encode(), b'')

    def validated(self, target='test', allow_production=False):
        return operator.validate(self.path, target, allow_production)

    def fake_psql(self, target='test', *, inventory=None, checks=None, inspect=None):
        def run(args, **kwargs):
            self.calls.append((list(args), kwargs))
            self.assertTrue((Path(self.config['receipt_directory']) / (target + '-attempt.json')).is_file())
            self.assertIn('-X', args); self.assertIn('--no-password', args)
            self.assertIn('--set=ON_ERROR_STOP=1', args)
            self.assertLessEqual(kwargs['timeout'], 120)
            if inspect:
                inspect(args, kwargs)
            if '--file' not in args:
                self.assertIn(b'BEGIN READ ONLY;', kwargs['input'])
                self.assertIn(b'ROLLBACK;', kwargs['input'])
                result = preflight(target) if inventory is None else inventory
            elif Path(args[-1]).name == 'acceptance.sql':
                self.assertIn('k5.test_business_id=' + self.config['targets']['test']['business_id'], kwargs['env']['PGOPTIONS'])
                result = acceptance() if checks is None else checks
            else:
                self.assertEqual(Path(args[-1]).read_bytes(), self.migration.read_bytes())
                self.assertNotIn('k5.test_business_id=', kwargs['env']['PGOPTIONS'])
                result = ''
            output = result if isinstance(result, str) else json.dumps(result)
            return subprocess.CompletedProcess(args, 0, output.encode(), b'')
        return run

    def successful_test_proof(self):
        path = self.root / 'reviewed-test-success.json'
        proof = {'scope': 'K5_HUMAN_PSQL_MIGRATION', 'status': 'completed', 'target': 'test',
                 'target_ref': self.config['targets']['test']['ref'],
                 'business_id': self.config['targets']['test']['business_id'],
                 'migration_sha256': self.config['migration_sha256'],
                 'acceptance_sha256': self.config['acceptance_sha256'],
                 'psql_version': operator.PSQL_VERSION, 'psql_binary_sha256': self.config['psql_binary_sha256'],
                 'ca_sha256': self.config['ca_sha256'], 'operator_sha256': operator.sha(SOURCE),
                 'password_recorded': False, 'automatic_retry': False, 'preflight': preflight(),
                 'acceptance': acceptance()}
        path.write_text(json.dumps(proof), encoding='utf8')
        self.config['test_success_path'] = str(path)
        self.config['test_success_sha256'] = operator.sha(path)
        self.write_config()
        return path, proof

    def test_reviewed_config_validation_starts_no_connection_and_cleans_all_inherited_pg_options(self):
        with patch.dict(os.environ, {'PGHOST': 'wrong.invalid', 'PGPASSWORD': 'PRIVATE', 'PGSERVICE': 'wrong', 'pgsslmode': 'disable'}):
            cfg = self.validated()
        self.assertEqual(cfg['_config_sha256'], operator.sha(self.path))
        self.assertEqual(cfg['_operator_sha256'], operator.sha(SOURCE))
        self.assertEqual(list(self.receipts.iterdir()), [])
        self.assertEqual(self.mock_run.call_count, 1)

    def test_production_never_opens_without_human_flag_and_pinned_identical_success(self):
        self.mock_run.reset_mock()
        with self.assertRaisesRegex(ValueError, '^HUMAN_PRODUCTION_FLAG_REQUIRED$'):
            self.validated('production')
        with self.assertRaisesRegex(ValueError, '^PINNED_TEST_SUCCESS_REQUIRED$'):
            self.validated('production', True)
        self.mock_run.assert_not_called()
        self.successful_test_proof()
        self.assertTrue(self.validated('production', True)['_allow_production'])

    def test_lf_exact_reviewed_hash_and_transaction_ending_are_mandatory(self):
        self.migration.write_bytes(self.migration.read_bytes().replace(b'\n', b'\r\n'))
        with self.assertRaisesRegex(ValueError, '^LF_SOURCE_HASH_MISMATCH$'):
            self.validated()
        self.migration.write_bytes(b'BEGIN;\nSELECT 42;\nCOMMIT;\n')
        self.config['migration_sha256'] = '0' * 64; self.write_config()
        with self.assertRaisesRegex(ValueError, '^K5_APPROVED_MIGRATION_REQUIRED$'):
            self.validated()
        self.config['migration_sha256'] = operator.sha(self.migration)
        self.acceptance.write_bytes(b'BEGIN;\nCOMMIT;\n')
        self.config['acceptance_sha256'] = operator.sha(self.acceptance); self.write_config()
        with self.assertRaisesRegex(ValueError, '^REVIEWED_TRANSACTION_SQL_REQUIRED$'):
            self.validated()

    def test_config_disallows_secret_fields_arbitrary_hosts_ports_and_reused_project_refs(self):
        original = json.loads(json.dumps(self.config))
        for mutate in [
            lambda c: c.update(password='PRIVATE'),
            lambda c: c['targets']['test'].update(host='unreviewed.invalid'),
            lambda c: c['targets']['test'].update(port=6543),
            lambda c: c['targets']['test'].update(ref=c['targets']['production']['ref']),
            lambda c: c['targets']['test'].update(business_id="bad'; DROP SCHEMA core;"),
        ]:
            self.config = json.loads(json.dumps(original)); mutate(self.config); self.write_config()
            with self.assertRaises(ValueError): self.validated()
        self.mock_run.assert_not_called()

    def test_psql_binary_ca_pins_and_exact_18_6_version_are_checked_before_password_window(self):
        for file in (self.psql, self.ca):
            before = file.read_bytes(); file.write_bytes(before + b'changed')
            with self.assertRaisesRegex(ValueError, '^REVIEWED_TOOL_OR_CA_HASH_MISMATCH$'):
                self.validated()
            file.write_bytes(before)
        self.mock_run.side_effect = lambda args, **kwargs: subprocess.CompletedProcess(args, 0, b'psql (PostgreSQL) 17.6\n', b'')
        with self.assertRaisesRegex(ValueError, '^REVIEWED_PSQL_VERSION_REQUIRED$'): self.validated()

    def test_any_existing_receipt_attempt_or_arbitrary_file_blocks_new_window(self):
        for name in ['test-attempt.json', 'test-success.json', 'unexpected.json']:
            marker = self.receipts / name; marker.write_text('{}')
            with self.assertRaisesRegex(ValueError, '^FRESH_EMPTY_RECEIPT_DIRECTORY_REQUIRED$'): self.validated()
            marker.unlink()
        self.mock_run.assert_not_called()

    def test_test_execution_uses_frozen_identical_files_tls_binding_no_inherited_pg_and_synthetic_rollback(self):
        cfg = self.validated()
        self.mock_run.side_effect = self.fake_psql()
        with patch.dict(os.environ, {'PGHOST': 'evil.invalid', 'PGSERVICEFILE': 'private', 'PGSSLMODE': 'disable'}):
            result = operator.execute(cfg, 'test', 'SYNTHETIC_PASSWORD')
        self.assertEqual(len(self.calls), 3)
        for args, kwargs in self.calls:
            env = kwargs['env']
            self.assertEqual(env['PGHOST'], self.config['targets']['test']['host'])
            self.assertEqual(env['PGUSER'], 'postgres.' + self.config['targets']['test']['ref'])
            self.assertEqual(env['PGPORT'], '5432'); self.assertEqual(env['PGDATABASE'], 'postgres')
            self.assertEqual(env['PGSSLMODE'], 'verify-full'); self.assertEqual(env['PGSSLROOTCERT'], str(self.ca))
            self.assertNotIn('PGSERVICEFILE', env)
            self.assertNotIn('SYNTHETIC_PASSWORD', repr(args))
        self.assertEqual(result['acceptance']['passed'], 17)
        self.assertEqual(result['ca_sha256'], operator.sha(self.ca))
        self.assertEqual(result['preflight']['k5_objects'], 0)
        self.assertTrue((self.receipts / 'test-success.json').exists())
        for path in self.receipts.rglob('*'):
            if path.is_file(): self.assertNotIn(b'SYNTHETIC_PASSWORD', path.read_bytes())

    def test_read_only_classification_missing_business_core_access_or_existing_k5_stops_before_ddl(self):
        cfg = self.validated()
        for key, value in [('business_count', 0), ('business_marked_test', False), ('all_businesses_test', False),
                           ('core_closed', False), ('baseline_and_k4_present', False), ('k5_objects', 1), ('read_only', False)]:
            with self.subTest(key=key):
                marker = self.receipts / 'test-attempt.json'
                if marker.exists(): marker.unlink()
                self.calls.clear()
                self.mock_run.side_effect = self.fake_psql(inventory={**preflight(), key: value})
                with self.assertRaisesRegex(ValueError, '^READ_ONLY_TARGET_OR_K5_ABSENCE_CHECK_FAILED$'):
                    operator.execute(cfg, 'test', 'SYNTHETIC_PASSWORD')
                self.assertEqual(len(self.calls), 1)
                self.assertNotIn('--file', self.calls[0][0])
                self.assertFalse((self.receipts / 'test-success.json').exists())

    def test_exclusive_attempt_is_created_before_connection_and_second_click_cannot_retry(self):
        cfg = self.validated()
        marker = self.receipts / 'test-attempt.json'; marker.write_text('{"preserve":true}')
        self.mock_run.reset_mock()
        with self.assertRaises(FileExistsError): operator.execute(cfg, 'test', 'PRIVATE')
        self.mock_run.assert_not_called()
        self.assertEqual(json.loads(marker.read_text()), {'preserve': True})

    def test_changed_source_tool_ca_or_config_after_validation_stops_before_connection(self):
        cfg = self.validated()
        for file in (self.migration, self.psql, self.ca, self.path):
            with self.subTest(file=file.name):
                marker = self.receipts / 'test-attempt.json'
                if marker.exists(): marker.unlink()
                before = file.read_bytes(); file.write_bytes(before + b' ')
                self.mock_run.reset_mock()
                with self.assertRaises(ValueError): operator.execute(cfg, 'test', 'PRIVATE')
                self.mock_run.assert_not_called()
                file.write_bytes(before)

    def test_source_change_after_read_only_probe_is_rejected_before_any_ddl(self):
        cfg = self.validated()
        def tamper(args, kwargs):
            self.migration.write_bytes(self.migration.read_bytes() + b' ')
        self.mock_run.side_effect = self.fake_psql(inspect=tamper)
        with self.assertRaisesRegex(ValueError, '^FROZEN_OR_REVIEWED_SOURCE_CHANGED$'):
            operator.execute(cfg, 'test', 'PRIVATE')
        self.assertEqual(len(self.calls), 1)

    def test_timeout_and_psql_failure_never_retry_or_echo_raw_error(self):
        cfg = self.validated()
        for failure, expected in [
            (subprocess.TimeoutExpired(['psql'], 120, output=b'RAW_PRIVATE', stderr=b'RAW_PASSWORD'), 'K5_PROCESS_TIMEOUT_OUTCOME_REVIEW_REQUIRED'),
            (subprocess.CompletedProcess([], 1, b'RAW_PRIVATE', b'password authentication failed RAW_PASSWORD'), 'AUTH_REJECTED'),
        ]:
            marker = self.receipts / 'test-attempt.json'
            if marker.exists(): marker.unlink()
            self.mock_run.reset_mock()
            self.mock_run.side_effect = failure if isinstance(failure, Exception) else lambda *a, **k: failure
            with self.assertRaisesRegex(ValueError, '^' + expected + '$'):
                operator.execute(cfg, 'test', 'PRIVATE')
            self.assertEqual(self.mock_run.call_count, 1)
            self.assertFalse((self.receipts / 'test-success.json').exists())
            self.assertNotIn('RAW', marker.read_text())

    def test_total_deadline_can_stop_before_process_and_no_automatic_second_attempt(self):
        cfg = self.validated(); self.mock_run.reset_mock()
        with patch.object(operator.time, 'monotonic', side_effect=[0, 301]):
            with self.assertRaisesRegex(ValueError, '^K5_PROCESS_DEADLINE_EXCEEDED$'):
                operator.execute(cfg, 'test', 'PRIVATE')
        self.mock_run.assert_not_called()
        self.assertTrue((self.receipts / 'test-attempt.json').exists())

    def test_acceptance_missing_staff_failure_or_unrolled_fixtures_cannot_create_success(self):
        cfg = self.validated()
        for override in [{'failed': 1}, {'missing': ['existing_active_staff']}, {'fixtures_rolled_back': False},
                         {'provider_calls': 1}, {'account_operations': 1}, {'auth_http_claimed': True},
                         {'passed': 16}, {'checks': [{'name': 'one', 'passed': True}]}, {'scope': 'other'}]:
            marker = self.receipts / 'test-attempt.json'
            if marker.exists(): marker.unlink()
            self.calls.clear()
            self.mock_run.side_effect = self.fake_psql(checks={**acceptance(), **override})
            with self.assertRaisesRegex(ValueError, '^ACCEPTANCE_RECEIPT_INVALID$'):
                operator.execute(cfg, 'test', 'PRIVATE')
            self.assertEqual(len(self.calls), 3)
            self.assertFalse((self.receipts / 'test-success.json').exists())
            self.assertEqual(json.loads(marker.read_text())['phase'], 'synthetic_acceptance_running_after_commit')

    def test_production_proof_requires_same_migration_acceptance_psql_ca_operator_and_successful_test(self):
        path, proof = self.successful_test_proof()
        for key in ['migration_sha256', 'acceptance_sha256', 'psql_binary_sha256', 'ca_sha256',
                    'operator_sha256', 'target_ref', 'business_id', 'psql_version']:
            changed = {**proof, key: 'changed'}
            path.write_text(json.dumps(changed)); self.config['test_success_sha256'] = operator.sha(path); self.write_config()
            with self.assertRaisesRegex(ValueError, '^SAME_MIGRATION_TOOL_CA_TEST_SUCCESS_REQUIRED$'):
                self.validated('production', True)
        path.write_text(json.dumps(proof)); self.config['test_success_sha256'] = operator.sha(path); self.write_config()
        cfg = self.validated('production', True)
        self.mock_run.side_effect = self.fake_psql('production')
        result = operator.execute(cfg, 'production', 'PRIVATE')
        self.assertEqual(len(self.calls), 2)
        self.assertNotIn('acceptance', result)
        self.assertEqual(result['test_success_sha256'], operator.sha(path))

    def fake_tk(self, confirm=True, click=True):
        state = SimpleNamespace(entry=None, confirmed=None, button=None, messages=[], labels=[])
        class Variable:
            def __init__(self, value=False):
                self.value = value
                if isinstance(value, bool): state.confirmed = self
            def get(self): return self.value
            def set(self, value): self.value = value; state.messages.append(value)
        class Widget:
            def __init__(self, *args, **kwargs):
                self.value = ''; self.command = kwargs.get('command')
                if 'text' in kwargs: state.labels.append(kwargs['text'])
            def pack(self, **kwargs): pass
            def config(self, **kwargs): pass
            def title(self, *args): pass
            def geometry(self, *args): pass
            def focus_set(self): pass
            def protocol(self, *args): pass
            def destroy(self): pass
            def get(self): return self.value
            def delete(self, *args): self.value = ''
            def after(self, delay, callback): callback()
            def mainloop(self):
                if click:
                    state.entry.value = 'SYNTHETIC_GUI_PASSWORD'; state.confirmed.value = confirm
                    state.button.command()
        def entry(*args, **kwargs): state.entry = Widget(*args, **kwargs); return state.entry
        def button(*args, **kwargs): state.button = Widget(*args, **kwargs); return state.button
        return SimpleNamespace(Tk=Widget, Label=Widget, Entry=entry, BooleanVar=Variable,
                               Checkbutton=Widget, StringVar=Variable, Button=button), state

    def test_gui_ready_is_no_connection_human_confirmation_required_and_target_is_visible(self):
        tk, state = self.fake_tk(confirm=False)
        with patch.dict(sys.modules, {'tkinter': tk}), patch.object(operator.threading, 'Thread') as thread:
            operator.gui(self.path, 'test')
        thread.assert_not_called()
        self.assertEqual(self.mock_run.call_count, 1)
        ready = json.loads((self.receipts / 'gui-ready.json').read_text())
        self.assertEqual(ready['scope'], 'K5_GUI_READY'); self.assertFalse(ready['connection_started'])
        self.assertTrue(any('Synthetic test' in label and 'a' * 20 in label for label in state.labels))
        self.assertFalse((self.receipts / 'test-attempt.json').exists())

    def test_gui_clears_password_before_work_and_revalidates_displayed_plan(self):
        tk, state = self.fake_tk()
        cfg = self.validated(); cfg['_gui_token'] = 'synthetic-token'
        class ImmediateThread:
            def __init__(self, target, args=(), **kwargs): self.target = target; self.args = args
            def start(self):
                self_test.assertEqual(state.entry.value, '')
                self.target(*self.args)
        self_test = self
        def execute(*args):
            self.assertEqual(state.entry.value, '')
            self.assertEqual(args[2], 'SYNTHETIC_GUI_PASSWORD')
        with patch.dict(sys.modules, {'tkinter': tk}), patch.object(operator.threading, 'Thread', ImmediateThread), \
             patch.object(operator, 'execute', side_effect=execute) as run:
            operator.gui(self.path, 'test')
        run.assert_called_once()
        self.assertEqual(self.mock_run.call_count, 3)  # explicit validated() plus both GUI validations
        self.assertNotIn('SYNTHETIC_GUI_PASSWORD', (self.receipts / 'gui-ready.json').read_text())

    def test_safe_error_classifier_never_echoes_unknown_raw_even_uppercase_errors(self):
        self.assertEqual(operator.safe_code(ValueError('RAW_PRIVATE_PASSWORD')), 'K5_STOP_RESULT_REVIEW_REQUIRED')
        self.assertEqual(operator.classify_psql_error(b'unknown PRIVATE_PASSWORD'), 'PSQL_FAILED_STOP_NO_RETRY')
        self.assertEqual(operator.classify_psql_error(b'certificate verification failed PRIVATE'), 'TLS_VERIFICATION_FAILED')


class ApprovedSources(unittest.TestCase):
    def test_actual_migration_uses_reviewed_exact_lf_bytes(self):
        migration = SOURCE.parents[2] / 'supabase/migrations/20261019000300_klaviyo_profile_sync.sql'
        self.assertEqual(operator.sha(migration), operator.APPROVED_MIGRATION_SHA256)
        self.assertNotIn(b'\r', migration.read_bytes())


if __name__ == '__main__':
    unittest.main(verbosity=2)
