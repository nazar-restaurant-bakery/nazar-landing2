"""Offline reviewer safety tests; fixtures are synthetic, not capture evidence."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'tools/test-env/review-schema.py'
spec = importlib.util.spec_from_file_location('k3_schema_review', MODULE)
reviewer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reviewer)


class SchemaReviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nazar-review-unit-', dir=Path(__file__).resolve().parents[2])
        self.root = Path(self.temporary.name).resolve()
        self.capture = self.root / 'production_synthetic_fixture'
        self.capture.mkdir()
        objects = [
            {'class_id': 2615, 'object_id': 1, 'schema_name': 'core', 'kind': 'schema', 'identity': 'core'},
            {'class_id': 2615, 'object_id': 2, 'schema_name': 'public', 'kind': 'schema', 'identity': 'public'},
            {'class_id': 1255, 'object_id': 3, 'schema_name': 'core', 'kind': 'routine', 'identity': 'function core.example()'},
            {'class_id': 1255, 'object_id': 4, 'schema_name': 'public', 'kind': 'routine', 'identity': 'function public.rls_auto_enable()'},
        ]
        toc = '1; 2615 1 SCHEMA - core postgres\n2; 2615 2 SCHEMA - public postgres\n3; 1255 3 FUNCTION core example() postgres\n4; 1255 4 FUNCTION public rls_auto_enable() postgres\n5; 0 0 DEFAULT ACL core DEFAULT PRIVILEGES FOR FUNCTIONS postgres\n6; 0 0 DEFAULT ACL public DEFAULT PRIVILEGES FOR FUNCTIONS postgres\n7; 0 0 ACL public FUNCTION rls_auto_enable() postgres\n'
        (self.capture / 'catalog.json').write_text(json.dumps({'read_only': 'on', 'objects': objects}), encoding='utf8')
        (self.capture / 'raw-schema.dump').write_bytes(b'SYNTHETIC_OFFLINE_UNIT_FIXTURE')
        (self.capture / 'raw-toc.list').write_text(toc, encoding='utf8')
        (self.capture / 'schema.sql').write_text('CREATE SCHEMA core;\n', encoding='utf8')
        (self.capture / 'allowlist-review.json').write_text('{}', encoding='utf8')
        self.manifest = {'mode': 'PRODUCTION', 'schemas': ['core', 'public'], 'read_only': True, 'data_exported': False,
                         'tls': 'verify-full', 'replay_ready': False, 'source_project_ref': 'abcdefghijklmnopqrst',
                         'files': {name: reviewer.digest(self.capture / name) for name in reviewer.CAPTURE_FILES}}
        self.write_manifest()
        self.entries = reviewer.parse_toc(toc, objects)

    def tearDown(self):
        self.assertEqual(self.root.parent, Path(__file__).resolve().parents[2])
        self.assertTrue(self.root.name.startswith('nazar-review-unit-'))
        self.temporary.cleanup()

    def write_manifest(self):
        (self.capture / 'capture-manifest.json').write_text(json.dumps(self.manifest), encoding='utf8')

    def completed(self):
        result = reviewer.template(self.manifest, self.entries)
        result.update(review_complete=True, reviewer='Synthetic unit reviewer')
        result['security_review'] = {key: True for key in reviewer.SECURITY_CHECKS}
        for item in result['entries']:
            item['include'] = item['forced_exclusion'] is None
            item['application_object'] = item['include']
            item['reason'] = item['forced_exclusion'] or 'Synthetic reviewed app object'
        return result

    def test_template_never_auto_approves_application_or_security(self):
        result = reviewer.template(self.manifest, self.entries)
        self.assertFalse(result['review_complete'])
        self.assertTrue(all(item['include'] is False for item in result['entries']))
        self.assertTrue(all(value is False for value in result['security_review'].values()))

    def test_platform_helper_public_defaults_and_public_schema_cannot_be_included(self):
        for number in (2, 4, 6, 7):
            result = self.completed()
            result['entries'][number - 1].update(include=True, application_object=True, reason='Untrusted approval')
            with self.assertRaisesRegex(reviewer.ReviewError, 'MANAGED_PLATFORM_OR_DATA_ENTRY_REFUSED'):
                reviewer.validate_review(result, self.manifest, self.entries)

    def test_core_default_acl_with_synthetic_oid_is_preserved(self):
        result = self.completed()
        selected = reviewer.validate_review(result, self.manifest, self.entries)
        self.assertEqual([item['dump_id'] for item in selected], [1, 3, 5])
        result['entries'][4]['include'] = False
        with self.assertRaisesRegex(reviewer.ReviewError, 'CORE_DEFAULT_ACL_MUST_BE_PRESERVED'):
            reviewer.validate_review(result, self.manifest, self.entries)

    def test_missing_review_security_flag_or_entry_refuses_render(self):
        for mutate in (lambda v: v.update(review_complete=False),
                       lambda v: v['security_review'].update(function_acl_verified=False),
                       lambda v: v['entries'].pop(),
                       lambda v: v['entries'][0].update(reason='')):
            result = self.completed()
            mutate(result)
            with self.assertRaises(reviewer.ReviewError):
                reviewer.validate_review(result, self.manifest, self.entries)

    def test_review_cannot_switch_archive_or_duplicate_ids(self):
        result = self.completed()
        result['capture_archive_sha256'] = '0' * 64
        with self.assertRaises(reviewer.ReviewError):
            reviewer.validate_review(result, self.manifest, self.entries)
        result = self.completed()
        result['entries'][1]['dump_id'] = result['entries'][0]['dump_id']
        with self.assertRaises(reviewer.ReviewError):
            reviewer.validate_review(result, self.manifest, self.entries)

    def test_actual_capture_contract_and_hashes_are_required(self):
        reviewer.load_capture(self.capture, self.root)
        for key, value in [('data_exported', True), ('mode', 'SANDBOX'), ('read_only', False)]:
            original = self.manifest[key]
            self.manifest[key] = value
            self.write_manifest()
            with self.assertRaises(reviewer.ReviewError):
                reviewer.load_capture(self.capture, self.root)
            self.manifest[key] = original
        self.write_manifest()
        (self.capture / 'schema.sql').write_text('changed', encoding='utf8')
        with self.assertRaisesRegex(reviewer.ReviewError, 'CAPTURE_HASH_MISMATCH'):
            reviewer.load_capture(self.capture, self.root)

    def test_data_event_trigger_and_unknown_positive_oids_forced_out(self):
        for text in ('8; 0 0 TABLE DATA core customers postgres', '8; 3466 3 EVENT TRIGGER example postgres', '8; 1255 99 FUNCTION public unknown() postgres'):
            self.assertIsNotNone(reviewer.parse_toc(text, [])[0]['forced_exclusion'])

    def test_embedded_credential_is_refused_without_value_in_error(self):
        secret = 'sb_secret_' + 'syntheticcredential' * 3
        (self.capture / 'schema.sql').write_text(secret, encoding='utf8')
        self.manifest['files']['schema.sql'] = reviewer.digest(self.capture / 'schema.sql')
        self.write_manifest()
        with self.assertRaises(reviewer.ReviewError) as result:
            reviewer.load_capture(self.capture, self.root)
        self.assertNotIn(secret, str(result.exception))

    def test_paths_cannot_escape_private_root_or_enter_git(self):
        with self.assertRaises(reviewer.ReviewError):
            reviewer.private_directory(self.root, self.root)
        (self.root / '.git').mkdir()
        with self.assertRaises(reviewer.ReviewError):
            reviewer.private_directory(self.capture, self.root)

    def test_render_is_file_only_preserves_acl_and_strips_pg_environment(self):
        (self.capture / 'completed-review.json').write_text(json.dumps(self.completed()), encoding='utf8')
        binaries = self.root / 'bin'
        binaries.mkdir()
        (binaries / 'pg_restore.exe').write_bytes(b'SYNTHETIC_NOT_EXECUTED')
        calls = []
        def fake_run(args, **kwargs):
            calls.append((args, kwargs))
            output = Path(next(arg.removeprefix('--file=') for arg in args if arg.startswith('--file=')))
            output.write_text('CREATE SCHEMA core;\n', encoding='utf8')
            return type('Result', (), {'returncode': 0})()
        with patch.object(reviewer.subprocess, 'run', fake_run), patch.dict(reviewer.os.environ, {'PGPASSWORD': 'synthetic_never_forwarded'}):
            proof = reviewer.render_reviewed(self.capture, 'completed-review.json', binaries, self.root)
        args, options = calls[0]
        self.assertTrue(any(arg.startswith('--use-list=') for arg in args))
        self.assertFalse(any(arg.startswith(('--dbname', '--clean', '--create', '--no-acl')) for arg in args))
        self.assertFalse(any(key.upper().startswith('PG') for key in options['env']))
        self.assertFalse(proof['remote_connection'])
        self.assertFalse(proof['local_restore_verified'])
        output = next(self.capture.glob('reviewed_*'))
        reviewer.validate_rendered(output, self.root)
        (output / 'reviewed-baseline.sql').write_text('altered', encoding='utf8')
        with self.assertRaisesRegex(reviewer.ReviewError, 'RENDERED_BASELINE_PROVENANCE_MISMATCH'):
            reviewer.validate_rendered(output, self.root)


if __name__ == '__main__':
    unittest.main()
