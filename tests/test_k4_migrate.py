"""K4 operator unit tests: temporary files and mocked psql/Tk only.

No real executable, connection, database, Auth account, browser or email is used.
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


SOURCE = Path(__file__).resolve().parents[1] / 'tools/test-env/k4-migrate.py'
SPEC = importlib.util.spec_from_file_location('k4_migrate_operator', SOURCE)
operator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(operator)


class K4MigrationTests(unittest.TestCase):
    def setUp(self):
        # Keep temporary fixtures inside the writable checkout. Some Windows
        # sandbox TEMP directories permit creation but deny child file access.
        self.temp = tempfile.TemporaryDirectory(prefix='k4-operator-unit-', dir=Path(__file__).resolve().parents[1])
        self.root = Path(self.temp.name).resolve()
        self.pg_bin = self.root / 'pg-bin'
        self.pg_bin.mkdir()
        # Inert fixture bytes. subprocess.run is mocked in every code path.
        self.psql = self.pg_bin / 'psql.exe'
        self.psql.write_bytes(b'SYNTHETIC_INERT_PSQL_BINARY')
        self.ca = self.root / 'fixture-ca.pem'
        self.ca.write_bytes(b'SYNTHETIC_TLS_CA')
        self.migration = self.root / 'migration.sql'
        self.migration_bytes = b'BEGIN;\nSELECT 42;\nCOMMIT;\n'
        self.migration.write_bytes(self.migration_bytes)
        self.acceptance = self.root / 'acceptance.sql'
        self.acceptance_bytes = b'BEGIN;\nSELECT 11;\nROLLBACK;\n'
        self.acceptance.write_bytes(self.acceptance_bytes)
        self.receipts = self.root / 'receipts'
        self.receipts.mkdir()
        self.config_path = self.root / 'config.json'
        self.config = {
            'test_ref': 'a' * 20, 'production_ref': 'b' * 20,
            'host': 'aws-0-us-east-1.pooler.supabase.com',
            'pg_bin': str(self.pg_bin), 'ca_path': str(self.ca),
            'migration': str(self.migration), 'migration_sha256': operator.sha(self.migration),
            'acceptance': str(self.acceptance), 'acceptance_sha256': operator.sha(self.acceptance),
            'receipt_directory': str(self.receipts),
        }
        self.write_config()
        self.version = 'psql (PostgreSQL) 17.6 synthetic'
        self.calls = []
        self.runner = patch.object(operator.subprocess, 'run', side_effect=self.version_only)
        self.mock_run = self.runner.start()
        self.addCleanup(self.runner.stop)
        self.addCleanup(self.temp.cleanup)

    def write_config(self, **changes):
        self.config.update(changes)
        self.config_path.write_text(json.dumps(self.config), encoding='utf8')

    def version_only(self, args, **kwargs):
        self.assertEqual(args, [str(self.psql), '--version'])
        self.assertTrue(kwargs['check'])
        self.assertEqual(kwargs['timeout'], 10)
        return subprocess.CompletedProcess(args, 0, (self.version + '\n').encode(), b'')

    def validated(self, target='test'):
        return operator.validate(self.config_path, target)

    def write_test_proof(self, **changes):
        proof = {
            'status': 'completed', 'target_ref': self.config['test_ref'],
            'migration_sha256': self.config['migration_sha256'],
            'acceptance_sha256': self.config['acceptance_sha256'],
            'psql_version': self.version, 'psql_binary_sha256': operator.sha(self.psql),
            'acceptance': {'passed': 11, 'failed': 0},
        }
        proof.update(changes)
        (self.receipts / 'test-success.json').write_text(json.dumps(proof), encoding='utf8')
        return proof

    def fake_psql(self, *, classification='t', acceptance=None, inspect=None):
        if acceptance is None:
            acceptance = {'passed': 11, 'failed': 0, 'synthetic_only': True}

        def run(args, **kwargs):
            self.calls.append((list(args), kwargs))
            self.assertNotIn('--version', args)
            self.assertIn('-X', args)
            self.assertIn('--no-password', args)
            self.assertIn('--set=ON_ERROR_STOP=1', args)
            self.assertEqual(kwargs['timeout'], 150)
            if inspect:
                inspect(args, kwargs)
            if '--file' not in args:
                self.assertIn(b'BEGIN READ ONLY;', kwargs['input'])
                self.assertIn(b'ROLLBACK;', kwargs['input'])
                output = classification
            elif Path(args[args.index('--file') + 1]).name == 'acceptance.sql':
                output = acceptance if isinstance(acceptance, str) else json.dumps(acceptance)
            else:
                output = ''
            return subprocess.CompletedProcess(args, 0, output.encode(), b'')

        return run

    def assert_no_success(self, target='test'):
        self.assertFalse((self.receipts / (target + '-success.json')).exists())

    def test_valid_config_only_invokes_mocked_version_and_captures_tool_hashes(self):
        cfg, version = self.validated()
        self.assertEqual(version, self.version)
        self.assertEqual(cfg['_psql_sha256'], operator.sha(self.psql))
        self.assertEqual(cfg['_ca_sha256'], operator.sha(self.ca))
        self.mock_run.assert_called_once()
        self.assertEqual(list(self.receipts.iterdir()), [])

    def test_target_refs_must_be_distinct_lowercase_twenty_letter_refs(self):
        original = dict(self.config)
        for changes in (
            {'test_ref': original['production_ref']},
            {'production_ref': 'a' * 20}, {'test_ref': 'A' * 20},
            {'test_ref': 'a' * 19}, {'production_ref': '0' * 20},
        ):
            with self.subTest(changes=changes):
                self.config = dict(original)
                self.write_config(**changes)
                with self.assertRaisesRegex(ValueError, '^DISTINCT_TARGET_REFS_REQUIRED$'):
                    self.validated()
        self.mock_run.assert_not_called()

    def test_invalid_pooler_or_missing_fields_stop_before_any_executable(self):
        original = dict(self.config)
        for host in ('example.invalid', 'db.' + 'a' * 20 + '.supabase.co',
                     'aws-0-us-east-1.pooler.supabase.com.evil.invalid'):
            with self.subTest(host=host):
                self.config = dict(original)
                self.write_config(host=host)
                with self.assertRaisesRegex(ValueError, '^SESSION_POOLER_HOST_REQUIRED$'):
                    self.validated()
        self.config = dict(original)
        self.write_config(migration='')
        with self.assertRaisesRegex(ValueError, '^CONFIG_INCOMPLETE$'):
            self.validated()
        self.mock_run.assert_not_called()

    def test_lf_bytes_and_both_source_hashes_are_required(self):
        original = dict(self.config)
        for key in ('migration', 'acceptance'):
            file = Path(original[key])
            valid = file.read_bytes()
            for bad in ('crlf', 'hash'):
                with self.subTest(source=key, mismatch=bad):
                    self.config = dict(original)
                    file.write_bytes(valid.replace(b'\n', b'\r\n') if bad == 'crlf' else valid)
                    self.write_config(**{key + '_sha256': operator.sha(file) if bad == 'crlf' else '0' * 64})
                    with self.assertRaisesRegex(ValueError, '^LF_SOURCE_HASH_MISMATCH$'):
                        self.validated()
                    file.write_bytes(valid)
        self.mock_run.assert_not_called()

    def test_missing_psql_or_ca_is_rejected_without_invocation(self):
        self.psql.unlink()
        with self.assertRaisesRegex(ValueError, '^PSQL_AND_TLS_CA_REQUIRED$'):
            self.validated()
        self.psql.write_bytes(b'SYNTHETIC_INERT_PSQL_BINARY')
        self.ca.unlink()
        with self.assertRaisesRegex(ValueError, '^PSQL_AND_TLS_CA_REQUIRED$'):
            self.validated()
        self.mock_run.assert_not_called()

    def test_existing_attempt_or_success_receipt_blocks_repeat(self):
        for name, code in (
            ('test-attempt.json', 'PRIOR_ATTEMPT_REQUIRES_INDEPENDENT_READBACK'),
            ('test-success.json', 'SUCCESS_RECEIPT_EXISTS_DO_NOT_REPEAT'),
        ):
            marker = self.receipts / name
            marker.write_text('{}', encoding='utf8')
            with self.subTest(marker=name), self.assertRaisesRegex(ValueError, '^' + code + '$'):
                self.validated()
            marker.unlink()
        self.mock_run.assert_not_called()

    def test_production_requires_successful_test_receipt_for_identical_tool_and_sources(self):
        with self.assertRaises(FileNotFoundError):
            self.validated('production')
        bad_proofs = (
            {'status': 'pending'}, {'target_ref': self.config['production_ref']},
            {'migration_sha256': '0' * 64}, {'acceptance_sha256': '0' * 64},
            {'psql_version': 'other tool version'}, {'psql_binary_sha256': '0' * 64},
            {'acceptance': {'passed': 11, 'failed': 1}},
            {'acceptance': {'passed': 10, 'failed': 0}},
        )
        for changes in bad_proofs:
            with self.subTest(changes=changes):
                self.write_test_proof(**changes)
                with self.assertRaisesRegex(ValueError, '^SAME_MIGRATION_TOOL_TEST_SUCCESS_REQUIRED$'):
                    self.validated('production')
        self.write_test_proof()
        cfg, version = self.validated('production')
        self.assertEqual(cfg['production_ref'], 'b' * 20)
        self.assertEqual(version, self.version)
        self.assertTrue(all(call.args[0][-1] == '--version' for call in self.mock_run.call_args_list))

    def test_execute_claims_attempt_and_freezes_exact_sql_before_first_connection(self):
        cfg, version = self.validated()
        self.mock_run.reset_mock()

        def inspect(args, kwargs):
            marker = json.loads((self.receipts / 'test-attempt.json').read_text())
            self.assertFalse(marker['password_recorded'])
            runs = list(self.receipts.glob('test-*'))
            frozen_dirs = [entry for entry in runs if entry.is_dir()]
            self.assertEqual(len(frozen_dirs), 1)
            frozen = frozen_dirs[0]
            self.assertEqual((frozen / 'migration.sql').read_bytes(), self.migration_bytes)
            self.assertEqual((frozen / 'acceptance.sql').read_bytes(), self.acceptance_bytes)
            env = kwargs['env']
            self.assertEqual(env['PGUSER'], 'postgres.' + self.config['test_ref'])
            self.assertEqual(env['PGHOST'], self.config['host'])
            self.assertEqual(env['PGPORT'], '5432')
            self.assertEqual(env['PGSSLMODE'], 'verify-full')
            self.assertEqual(env['PGSSLROOTCERT'], str(self.ca))
            self.assertNotIn('PGSERVICE', env)
            if '--file' not in args:
                self.assertEqual(marker['phase'], 'read_only_preflight')
                # Editing originals after the frozen copy does not alter the SQL
                # whose displayed hashes were approved and sent to psql.
                self.migration.write_bytes(b'SELECT original_changed;\r\n')
                self.acceptance.write_bytes(b'SELECT original_changed;\r\n')
            else:
                submitted = Path(args[args.index('--file') + 1])
                self.assertEqual(submitted.parent, frozen)

        self.mock_run.side_effect = self.fake_psql(inspect=inspect)
        with patch.dict(os.environ, {'PGHOST': 'wrong-host.invalid', 'PGSERVICE': 'wrong-service'}):
            result = operator.execute(cfg, 'test', 'SYNTHETIC_PASSWORD_DO_NOT_RECORD', version)
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(result['acceptance']['passed'], 11)
        self.assertEqual(result['status'], 'completed')
        marker = json.loads((self.receipts / 'test-attempt.json').read_text())
        self.assertEqual(marker['phase'], 'completed_success_receipt_written')
        for receipt in self.receipts.glob('*.json'):
            self.assertNotIn('SYNTHETIC_PASSWORD_DO_NOT_RECORD', receipt.read_text())

    def test_source_change_after_validation_claims_attempt_but_never_connects(self):
        cfg, version = self.validated()
        self.mock_run.reset_mock()
        self.migration.write_bytes(self.migration_bytes + b'-- changed\n')
        with self.assertRaisesRegex(RuntimeError, '^LF_SOURCE_HASH_MISMATCH$'):
            operator.execute(cfg, 'test', 'SYNTHETIC_PASSWORD', version)
        self.mock_run.assert_not_called()
        self.assert_no_success()
        marker = json.loads((self.receipts / 'test-attempt.json').read_text())
        self.assertEqual(marker['phase'], 'source_changed_before_connection')
        self.migration.write_bytes(self.migration_bytes)
        with self.assertRaisesRegex(ValueError, '^PRIOR_ATTEMPT_REQUIRES_INDEPENDENT_READBACK$'):
            self.validated()

    def test_exclusive_attempt_claim_stops_racing_execution_without_connection(self):
        cfg, version = self.validated()
        (self.receipts / 'test-attempt.json').write_text('{"preserve": true}')
        self.mock_run.reset_mock()
        with self.assertRaises(FileExistsError):
            operator.execute(cfg, 'test', 'SYNTHETIC_PASSWORD', version)
        self.mock_run.assert_not_called()
        self.assertEqual(json.loads((self.receipts / 'test-attempt.json').read_text()), {'preserve': True})

    def test_target_classification_mismatch_stops_before_any_file_or_ddl(self):
        for target, classification in (('test', 'f'), ('production', 't')):
            with self.subTest(target=target):
                if target == 'production':
                    self.write_test_proof()
                cfg, version = self.validated(target)
                self.calls = []
                self.mock_run.side_effect = self.fake_psql(classification=classification)
                with self.assertRaisesRegex(RuntimeError, '^TARGET_BUSINESS_CLASSIFICATION_MISMATCH$'):
                    operator.execute(cfg, target, 'SYNTHETIC_PASSWORD', version)
                self.assertEqual(len(self.calls), 1)
                self.assertNotIn('--file', self.calls[0][0])
                self.assertEqual(self.calls[0][1]['env']['PGUSER'], 'postgres.' + cfg['test_ref' if target == 'test' else 'production_ref'])
                self.assert_no_success(target)
                (self.receipts / (target + '-attempt.json')).unlink()
                self.mock_run.side_effect = self.version_only

    def test_changed_frozen_sql_after_probe_is_rejected_before_migration(self):
        cfg, version = self.validated()

        def tamper(args, kwargs):
            if '--file' not in args:
                frozen = next(entry for entry in self.receipts.glob('test-*') if entry.is_dir())
                (frozen / 'migration.sql').write_bytes(b'SELECT tampered;\n')

        self.mock_run.side_effect = self.fake_psql(inspect=tamper)
        with self.assertRaisesRegex(RuntimeError, '^FROZEN_SOURCE_HASH_MISMATCH$'):
            operator.execute(cfg, 'test', 'SYNTHETIC_PASSWORD', version)
        self.assertEqual(len(self.calls), 1)
        self.assert_no_success()
        self.assertEqual(json.loads((self.receipts / 'test-attempt.json').read_text())['phase'], 'frozen_source_changed')

    def test_tool_or_tls_ca_change_after_validation_stops_before_connection(self):
        for file in (self.psql, self.ca):
            with self.subTest(file=file.name):
                cfg, version = self.validated()
                original = file.read_bytes()
                file.write_bytes(original + b'_CHANGED')
                self.mock_run.reset_mock()
                with self.assertRaisesRegex(RuntimeError, '^DISPLAYED_TOOL_OR_TLS_CA_CHANGED$'):
                    operator.execute(cfg, 'test', 'SYNTHETIC_PASSWORD', version)
                self.mock_run.assert_not_called()
                self.assert_no_success()
                file.write_bytes(original)
                (self.receipts / 'test-attempt.json').unlink()

    def test_failed_submission_keeps_attempt_and_sanitizes_raw_server_output(self):
        cfg, version = self.validated()
        success = self.fake_psql()

        def fail_migration(args, **kwargs):
            if '--file' in args:
                self.calls.append((list(args), kwargs))
                return subprocess.CompletedProcess(args, 1, b'', b'ERROR: SYNTHETIC_MIGRATION_FAILED\nprivate row and SYNTHETIC_PASSWORD')
            return success(args, **kwargs)

        self.mock_run.side_effect = fail_migration
        with self.assertRaisesRegex(RuntimeError, '^SYNTHETIC_MIGRATION_FAILED$'):
            operator.execute(cfg, 'test', 'SYNTHETIC_PASSWORD', version)
        self.assertEqual(len(self.calls), 2)
        self.assert_no_success()
        self.assertEqual(json.loads((self.receipts / 'test-attempt.json').read_text())['phase'], 'migration_submitting_outcome_unknown_until_receipt')
        self.mock_run.reset_mock()
        with self.assertRaisesRegex(ValueError, '^PRIOR_ATTEMPT_REQUIRES_INDEPENDENT_READBACK$'):
            self.validated()
        self.mock_run.assert_not_called()
        self.assertNotIn('SYNTHETIC_PASSWORD', (self.receipts / 'test-attempt.json').read_text())

    def test_failed_or_ambiguous_acceptance_never_writes_success(self):
        for acceptance in ({'passed': 11, 'failed': 1}, {'passed': 10, 'failed': 0}, '{}\n{}', 'no-json'):
            with self.subTest(acceptance=acceptance):
                cfg, version = self.validated()
                self.calls = []
                self.mock_run.side_effect = self.fake_psql(acceptance=acceptance)
                with self.assertRaisesRegex(RuntimeError, '^ACCEPTANCE_RECEIPT_INVALID$'):
                    operator.execute(cfg, 'test', 'SYNTHETIC_PASSWORD', version)
                self.assertEqual(len(self.calls), 3)
                self.assert_no_success()
                marker = json.loads((self.receipts / 'test-attempt.json').read_text())
                self.assertEqual(marker['phase'], 'synthetic_acceptance_running_after_migration_commit')
                (self.receipts / 'test-attempt.json').unlink()
                self.mock_run.side_effect = self.version_only

    def test_production_routes_same_frozen_migration_to_production_without_synthetic_seed(self):
        self.write_test_proof()
        cfg, version = self.validated('production')
        self.mock_run.side_effect = self.fake_psql(classification='f')
        result = operator.execute(cfg, 'production', 'SYNTHETIC_PASSWORD', version)
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.calls[0][1]['env']['PGUSER'], 'postgres.' + cfg['production_ref'])
        self.assertEqual(Path(self.calls[1][0][-1]).name, 'migration.sql')
        self.assertEqual(Path(self.calls[1][0][-1]).read_bytes(), self.migration_bytes)
        self.assertNotIn('acceptance', result)
        self.assertEqual(result['migration_sha256'], self.config['migration_sha256'])
        self.assertTrue((self.receipts / 'production-success.json').is_file())

    def fake_tk(self, *, confirmed=True):
        state = SimpleNamespace(entry=None, confirmed=None, button=None, messages=[])

        class Variable:
            def __init__(self, value=False):
                self.value = value
                if isinstance(value, bool):
                    state.confirmed = self

            def get(self):
                return self.value

            def set(self, value):
                self.value = value
                state.messages.append(value)

        class Widget:
            def __init__(self, *args, **kwargs):
                self.command = kwargs.get('command')
                self.value = ''

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
                state.entry.value = 'SYNTHETIC_GUI_PASSWORD'
                state.confirmed.value = confirmed
                state.button.command()

        def entry(*args, **kwargs):
            state.entry = Widget(*args, **kwargs)
            return state.entry

        def button(*args, **kwargs):
            state.button = Widget(*args, **kwargs)
            return state.button

        tk = SimpleNamespace(Tk=Widget, Label=Widget, Entry=entry, BooleanVar=Variable,
                             Checkbutton=Widget, StringVar=Variable, Button=button)
        return tk, state

    def test_gui_revalidates_displayed_config_before_any_execution(self):
        cfg, version = self.validated()
        tk, state = self.fake_tk()

        class ImmediateThread:
            def __init__(self, target, **kwargs): self.target = target
            def start(self): self.target()

        changed = dict(cfg, migration_sha256='0' * 64)
        with patch.dict(sys.modules, {'tkinter': tk}), \
             patch.object(operator, 'validate', side_effect=[(cfg, version), (changed, version)]) as validate, \
             patch.object(operator.threading, 'Thread', ImmediateThread), \
             patch.object(operator, 'execute') as execute:
            operator.gui(self.config_path, 'test')
        self.assertEqual(validate.call_count, 2)
        execute.assert_not_called()
        self.assertEqual(state.entry.value, '')
        failure = json.loads((self.receipts / 'test-last-failure.json').read_text())
        self.assertEqual(failure['code'], 'DISPLAYED_PLAN_CHANGED_REOPEN_REQUIRED')
        self.assertFalse(failure['password_recorded'])
        self.assertTrue(any('DISPLAYED_PLAN_CHANGED_REOPEN_REQUIRED' in str(message) for message in state.messages))

    def test_gui_requires_human_target_confirmation_before_thread_or_revalidation(self):
        cfg, version = self.validated()
        tk, state = self.fake_tk(confirmed=False)
        with patch.dict(sys.modules, {'tkinter': tk}), \
             patch.object(operator, 'validate', return_value=(cfg, version)) as validate, \
             patch.object(operator.threading, 'Thread') as thread, \
             patch.object(operator, 'execute') as execute:
            operator.gui(self.config_path, 'test')
        validate.assert_called_once()
        thread.assert_not_called()
        execute.assert_not_called()
        self.assertIn('Password ve hedef onayı gerekli.', state.messages)
        self.assertEqual(list(self.receipts.iterdir()), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
