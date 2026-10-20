"""Isolated schema-capture tests. No database, network or real credentials."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('schema_capture', Path(__file__).resolve().parents[1] / 'tools/test-env/capture-schema.py')
capture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capture)


class SchemaCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='nazar-schema-unit-', dir=Path(__file__).resolve().parents[2])
        self.root = Path(self.temp.name).resolve()
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name in ('psql', 'pg_dump', 'pg_restore'):
            (self.bin / (name + '.exe')).write_text('inert test fixture')
        self.cert = self.root / 'ca.crt'
        self.cert.write_text('inert CA fixture')
        self.private = self.root / 'private'
        self.private.mkdir()
        self.env = {'SCHEMA_PG_BIN': str(self.bin), 'SCHEMA_PRIVATE_ROOT': str(self.private)}
        for mode, ref in (('PRODUCTION', 'a' * 20), ('SANDBOX', 'b' * 20)):
            prefix = 'SCHEMA_' + mode + '_'
            self.env.update({prefix + 'PROJECT_REF': ref, prefix + 'HOST': 'db.' + ref + '.supabase.co',
                             prefix + 'PORT': '5432', prefix + 'USER': 'postgres', prefix + 'DATABASE': 'postgres',
                             prefix + 'SSLROOTCERT': str(self.cert)})

    def tearDown(self):
        # Cleanup only the uniquely created fixture below the known workspace tmp.
        self.assertEqual(self.root.parent, Path(__file__).resolve().parents[2])
        self.assertTrue(self.root.name.startswith('nazar-schema-unit-'))
        self.temp.cleanup()

    def cfg(self, mode='PRODUCTION'):
        return capture.config_for(mode, self.env)

    def test_import_does_not_connect_or_launch_gui(self):
        self.assertTrue(callable(capture.launch_gui))

    def test_configuration_direct_and_mode_specific_root(self):
        self.assertEqual(self.cfg()['mode'], 'PRODUCTION')
        other = self.root / 'other-private'
        other.mkdir()
        self.env['SCHEMA_SANDBOX_PRIVATE_ROOT'] = str(other)
        self.assertEqual(self.cfg('SANDBOX')['private_root'], other)

    def test_session_pooler_requires_matching_project_user(self):
        self.env['SCHEMA_PRODUCTION_HOST'] = 'aws-0-us-east-1.pooler.supabase.com'
        with self.assertRaisesRegex(capture.CaptureError, 'TARGET_BINDING'):
            self.cfg()
        self.env['SCHEMA_PRODUCTION_USER'] = 'postgres.' + 'a' * 20
        self.cfg()

    def test_transaction_pooler_arbitrary_host_and_uri_rejected(self):
        for field, value in (('PORT', '6543'), ('HOST', 'attacker.invalid'), ('DATABASE', 'postgresql://hidden')):
            env = {**self.env, 'SCHEMA_PRODUCTION_' + field: value}
            with self.assertRaises(capture.CaptureError):
                capture.config_for('PRODUCTION', env)

    def test_same_source_target_and_missing_ca_rejected(self):
        self.env['SCHEMA_SANDBOX_PROJECT_REF'] = 'a' * 20
        with self.assertRaisesRegex(capture.CaptureError, 'MUST_DIFFER'):
            self.cfg()
        self.env['SCHEMA_SANDBOX_PROJECT_REF'] = 'b' * 20
        self.cert.unlink()
        with self.assertRaisesRegex(capture.CaptureError, 'CA_FILE'):
            self.cfg()

    def test_git_private_root_rejected(self):
        (self.private / '.git').write_text('gitdir: fixture')
        with self.assertRaisesRegex(capture.CaptureError, 'OUTSIDE_GIT'):
            self.cfg()

    def test_connection_environment_is_explicit_read_only_and_tls_verified(self):
        env = capture.child_env(self.cfg(), 'secret-not-for-log', {'PGSERVICE': 'bad', 'pghostaddr': 'bad', 'PGOPTIONS': '-c transaction_read_only=off', 'PATH': 'kept'})
        self.assertNotIn('PGSERVICE', env)
        self.assertNotIn('pghostaddr', env)
        self.assertEqual(env['PGSSLMODE'], 'verify-full')
        self.assertIn('default_transaction_read_only=on', env['PGOPTIONS'])
        self.assertEqual(env['PATH'], 'kept')
        self.assertEqual(env['PGPASSWORD'], 'secret-not-for-log')

    def test_dump_arguments_schema_only_and_no_secret_or_other_schema(self):
        args = capture.pg_args('pg_dump', self.private)
        self.assertIn('--schema-only', args)
        self.assertIn('--schema=core', args)
        self.assertIn('--schema=public', args)
        self.assertIn('--no-password', args)
        self.assertFalse(any(v in ' '.join(args) for v in ('--data-only', '--inserts', '--schema=auth', '--schema=storage', '--dbname')))

    def test_restore_is_file_only_and_catalog_is_metadata_only(self):
        args = capture.render_args(self.private)
        self.assertIn('--schema-only', args)
        self.assertFalse(any(v in ' '.join(args) for v in ('--dbname', '--clean', '--create')))
        self.assertIn('BEGIN TRANSACTION READ ONLY', capture.CATALOG_SQL)
        self.assertNotIn('FROM core.', capture.CATALOG_SQL)
        self.assertNotIn('FROM public.', capture.CATALOG_SQL)
        self.assertIn("d.deptype='e'", capture.CATALOG_SQL)

    def test_toc_allowlist_never_auto_approves_or_trusts_names(self):
        objects = [{'class_id': 1259, 'object_id': 100, 'schema_name': 'core', 'identity': 'table core.customers'}]
        result = capture.inspect_toc('; header\n1; 1259 100 TABLE core customers owner\n2; 1255 200 FUNCTION public platform_fn() owner\n3; 0 0 ACL core TABLE customers owner\n', objects)
        self.assertEqual(len(result['application_candidates']), 1)
        self.assertFalse(result['application_candidates'][0]['include'])
        self.assertEqual(len(result['excluded_non_application_or_extension_owned']), 1)
        self.assertEqual(len(result['unresolved_dependency_or_acl_entries']), 1)

    def test_toc_rejects_data_entries(self):
        for descriptor in ('TABLE DATA', 'MATERIALIZED VIEW DATA', 'SEQUENCE SET', 'BLOBS', 'BLOB DATA', 'LARGE OBJECT'):
            with self.assertRaisesRegex(capture.CaptureError, 'DATA_ENTRY'):
                capture.inspect_toc('2; 0 100 ' + descriptor + ' core fixture owner', [])

    def fake_run(self, calls, sandbox=False):
        def run(config, tool, args, env, stdin=None):
            calls.append((tool, list(args), dict(env), stdin))
            directory = next(self.private.iterdir())
            if args == ['--version']:
                return b'pg_dump (PostgreSQL) 18.0\n'
            if tool == 'psql':
                if stdin == capture.SANDBOX_RECOVERY_SQL.encode():
                    return json.dumps(self.envelope()).encode()
                return json.dumps({'server_version_num': 170011, 'read_only': 'on', 'objects': [
                    {'class_id': 1259, 'object_id': 100, 'schema_name': 'core', 'identity': 'table core.fixture'}]}).encode()
            if tool == 'pg_dump':
                (directory / 'raw-schema.dump').write_bytes(b'inert custom archive fixture')
                return b''
            if '--list' in args:
                return b'1; 1259 100 TABLE core fixture owner\n'
            (directory / 'schema.sql').write_text('-- inert schema-only fixture')
            return b''
        return run

    def test_mock_capture_keeps_password_out_of_files_and_offline_restore_env(self):
        calls = []
        with patch.object(capture, 'restrict_capture_dir'), patch.object(capture, 'run_pg', self.fake_run(calls)):
            directory = capture.capture(self.cfg(), 'super-secret-only-in-memory')
        proof = json.loads((directory / 'source-proof.json').read_text())
        self.assertFalse(proof['replay_ready'])
        self.assertFalse(proof['data_exported'])
        for tool, args, env, _ in calls:
            self.assertNotIn('super-secret-only-in-memory', ' '.join(args))
            if tool == 'pg_restore' and '--list' not in args:
                self.assertFalse(any(key.upper().startswith('PG') for key in env))
        for file in directory.iterdir():
            self.assertNotIn(b'super-secret-only-in-memory', file.read_bytes())
        self.assertEqual(len([c for c in calls if c[0] == 'psql']), 1)

    def test_failed_acl_prevents_any_database_or_tool_call(self):
        with patch.object(capture, 'restrict_capture_dir', side_effect=capture.CaptureError('PRIVATE_ACL_FAILED')), patch.object(capture, 'run_pg') as run:
            with self.assertRaisesRegex(capture.CaptureError, 'ACL'):
                capture.capture(self.cfg(), 'password')
            run.assert_not_called()

    def test_tool_errors_never_echo_stderr_or_password(self):
        result = type('Result', (), {'returncode': 1, 'stderr': b'private password and SQL', 'stdout': b''})()
        with patch.object(capture.subprocess, 'run', return_value=result):
            with self.assertRaises(capture.CaptureError) as caught:
                capture.run_pg(self.cfg(), 'psql', [], {})
        self.assertNotIn('private password', str(caught.exception))

    def test_error_classification_is_fixed_and_safe(self):
        for message, code in ((b'password authentication failed for private user', 'DATABASE_PASSWORD_REJECTED'),
                              (b'SSL error: certificate verify failed', 'TLS_VERIFY_FAILED'),
                              (b'could not translate host private-host', 'DNS_FAILED'),
                              (b'connection timeout expired', 'CONNECTION_TIMEOUT'),
                              (b'permission denied for private table', 'READ_PERMISSION_DENIED'),
                              (b'unexpected private content', 'POSTGRES_OPERATION_FAILED')):
            self.assertEqual(capture.safe_error_code(message), code)

    def test_durable_status_has_only_safe_fields_and_no_connection_contents(self):
        status_file = self.private / 'capture-status.json'
        with patch.dict(os.environ, {'SCHEMA_STATUS_FILE': str(status_file)}):
            capture.record_status(self.cfg(), 'schema_dump', self.private)
            capture.record_status(self.cfg(), 'error', self.private, 'DATABASE_PASSWORD_REJECTED')
        value = json.loads(status_file.read_text())
        self.assertEqual(set(value), {'mode', 'status', 'updated_at', 'directory', 'error_code'})
        self.assertEqual(value['error_code'], 'DATABASE_PASSWORD_REJECTED')
        self.assertNotIn('PROJECT_REF', status_file.read_text())
        self.assertEqual(list(self.private.glob('.capture-status-*.tmp')), [])

    def envelope(self):
        rows = '[\n {"id":"fixture-1"}, {"id":"fixture-2"}, {"id":"fixture-3"}, {"id":"fixture-4"}\n]'
        return {'total': 4, 'marked': 4, 'staff_count': 1, 'rows_json': rows,
                'staff_json': '[{"staff_ref":"sandbox-staff-1","active":true,"auth_linked":true,"role":null}]',
                'rows_sha256': hashlib.sha256(rows.encode()).hexdigest()}

    def test_sandbox_exact_source_bytes_and_pending_review(self):
        envelope = self.envelope()
        capture.write_sandbox_recovery(self.private, envelope)
        self.assertEqual((self.private / 'catering-orders.json').read_bytes(), envelope['rows_json'].encode())
        proof = json.loads((self.private / 'recovery-source-proof.json').read_text())
        self.assertFalse(proof['allRowsReviewedSynthetic'])
        self.assertTrue(proof['markerClassificationPassed'])
        self.assertTrue(proof['freeFormReviewPending'])
        self.assertFalse(proof['localRestoreProof'])

    def test_sandbox_count_hash_and_identity_errors_fail_closed(self):
        for change in ({'total': 5}, {'marked': 3}, {'staff_count': 2}, {'rows_sha256': '0' * 64},
                       {'staff_json': '[{"staff_ref":"sandbox-staff-1","active":true,"auth_linked":true,"role":null,"auth_user_id":"private-id"}]'}):
            with self.assertRaises(capture.CaptureError):
                capture.write_sandbox_recovery(self.private, {**self.envelope(), **change})
        self.assertFalse((self.private / 'catering-orders.json').exists())

    def test_sandbox_rows_are_never_requested_for_production(self):
        calls = []
        with patch.object(capture, 'restrict_capture_dir'), patch.object(capture, 'run_pg', self.fake_run(calls)):
            directory = capture.capture(self.cfg('SANDBOX'), 'sandbox-only-password')
        self.assertEqual(len([c for c in calls if c[0] == 'psql']), 2)
        self.assertTrue((directory / 'catering-orders.json').is_file())

    def test_real_private_acl_on_local_temporary_directory_only(self):
        directory = self.private / 'acl-fixture'
        directory.mkdir()
        capture.restrict_capture_dir(directory)
        (directory / 'probe.txt').write_text('local fixture only')
        self.assertTrue((directory / 'probe.txt').is_file())


if __name__ == '__main__':
    unittest.main()
