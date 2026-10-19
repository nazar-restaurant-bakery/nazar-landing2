"""Synthetic offline review tests. Never start PostgreSQL or use a real capture."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


MODULE = Path(__file__).resolve().parents[1] / 'tools/test-env/review-sandbox-recovery.py'
spec = importlib.util.spec_from_file_location('k3_sandbox_review', MODULE)
reviewer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reviewer)


class SandboxRecoveryReviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='nazar-sandbox-review-unit-', dir=Path(__file__).resolve().parents[2])
        self.root = Path(self.temporary.name).resolve()
        self.capture = self.root / 'sandbox_synthetic_fixture'
        self.capture.mkdir()
        self.ref = 'b' * 20
        objects = [
            {'class_id': 2615, 'object_id': 1, 'schema_name': 'core', 'kind': 'schema', 'identity': 'core'},
            {'class_id': 2615, 'object_id': 2, 'schema_name': 'public', 'kind': 'schema', 'identity': 'public'},
            {'class_id': 1259, 'object_id': 3, 'schema_name': 'public', 'kind': 'relation', 'identity': 'table public.catering_orders'},
            {'class_id': 1259, 'object_id': 4, 'schema_name': 'core', 'kind': 'relation', 'identity': 'table core.crm_staff'},
        ]
        self.toc = '1; 2615 1 SCHEMA - core postgres\n2; 2615 2 SCHEMA - public postgres\n3; 1259 3 TABLE public catering_orders postgres\n4; 1259 4 TABLE core crm_staff postgres\n5; 0 0 DEFAULT ACL core DEFAULT PRIVILEGES FOR FUNCTIONS postgres\n'
        (self.capture / 'catalog.json').write_text(json.dumps({'read_only': 'on', 'objects': objects}), encoding='utf8')
        (self.capture / 'raw-schema.dump').write_bytes(b'SYNTHETIC_OFFLINE_ARCHIVE_NOT_EXECUTED')
        (self.capture / 'raw-toc.list').write_text(self.toc, encoding='utf8')
        self.schema = 'CREATE SCHEMA core;\nCREATE TABLE public.catering_orders(id uuid);\nCREATE TABLE core.crm_staff(auth_user_id uuid);\n'
        (self.capture / 'schema.sql').write_text(self.schema, encoding='utf8')
        (self.capture / 'allowlist-review.json').write_text('{}', encoding='utf8')
        self.order_bytes = b'[{"id":"synthetic-1","amount":9007199254740993.0001},{"id":"synthetic-2","amount":2},{"id":"synthetic-3","amount":3},{"id":"synthetic-4","amount":4}]'
        (self.capture / 'catering-orders.json').write_bytes(self.order_bytes)
        (self.capture / 'staff-anonymous.json').write_text('[{"staff_ref":"sandbox-staff-1","active":true,"auth_linked":true,"role":null}]', encoding='utf8')
        self.source = {'capturedAtUtc': '2026-10-19T12:00:00+00:00', 'expectedCateringRows': 4, 'expectedStaffRows': 1,
                       'cateringRowsSha256': reviewer.digest(self.capture / 'catering-orders.json'),
                       'staffAnonymousSha256': reviewer.digest(self.capture / 'staff-anonymous.json'),
                       'allRowsReviewedSynthetic': False, 'freeFormReviewPending': True, 'localRestoreProof': False,
                       'schemaDumpSucceeded': True, 'authPlatformPreserved': True, 'markerClassificationPassed': True,
                       'scope': 'read_only_source_capture_not_reset_or_restore'}
        (self.capture / 'recovery-source-proof.json').write_text(json.dumps(self.source), encoding='utf8')
        self.manifest = {'mode': 'SANDBOX', 'schemas': ['core', 'public'], 'read_only': True,
                         'schema_data_exported': False, 'data_exported': True, 'syntheticRowsExported': 4,
                         'anonymousStaffRowsExported': 1, 'tls': 'verify-full', 'replay_ready': False,
                         'source_project_ref': self.ref,
                         'files': {name: reviewer.digest(self.capture / name) for name in reviewer.CAPTURE_FILES}}
        self.write_manifest()
        _, _, self.entries, _ = reviewer.load_capture(self.capture, self.ref, self.root)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        (self.bin / 'pg_restore.exe').write_text('SYNTHETIC_NOT_EXECUTED', encoding='utf8')

    def tearDown(self):
        self.assertEqual(self.root.parent, Path(__file__).resolve().parents[2])
        self.assertTrue(self.root.name.startswith('nazar-sandbox-review-unit-'))
        self.temporary.cleanup()

    def write_manifest(self):
        text = json.dumps(self.manifest)
        for name in ('capture-manifest.json', 'source-proof.json'):
            (self.capture / name).write_text(text, encoding='utf8')

    def completed_review(self):
        value = reviewer.template(self.manifest, self.entries)
        value.update(review_complete=True, reviewer='Synthetic offline unit reviewer')
        value['security_review'] = {key: True for key in reviewer.schema_review.SECURITY_CHECKS}
        value['recovery_review'] = {key: True for key in reviewer.RECOVERY_CHECKS}
        for entry in value['entries']:
            entry.update(include=entry['forced_exclusion'] is None,
                         application_object=entry['forced_exclusion'] is None,
                         reason=entry['forced_exclusion'] or 'Synthetic reviewed application object')
        return value

    def render(self, value=None):
        (self.capture / 'completed-review.json').write_text(json.dumps(value or self.completed_review()), encoding='utf8')
        self.calls = []
        def fake_run(args, **options):
            self.calls.append((args, options))
            Path(next(arg.removeprefix('--file=') for arg in args if arg.startswith('--file='))).write_text(self.schema, encoding='utf8')
            return type('Result', (), {'returncode': 0})()
        with patch.object(reviewer.subprocess, 'run', fake_run):
            return reviewer.render_reviewed(self.capture, self.ref, 'completed-review.json', self.bin, self.root)

    def test_template_never_approves_schema_synthetic_values_or_external_io(self):
        value = reviewer.template(self.manifest, self.entries)
        self.assertFalse(value['review_complete'])
        self.assertTrue(all(entry['include'] is False for entry in value['entries']))
        self.assertTrue(all(flag is False for flag in value['recovery_review'].values()))

    def test_actual_sandbox_ref_mode_counts_and_read_only_are_required(self):
        for key, wrong in [('mode', 'PRODUCTION'), ('source_project_ref', 'c' * 20),
                           ('syntheticRowsExported', 5), ('anonymousStaffRowsExported', 0),
                           ('read_only', False), ('schema_data_exported', True), ('data_exported', False)]:
            original = self.manifest[key]
            self.manifest[key] = wrong
            self.write_manifest()
            with self.assertRaises(reviewer.ReviewError):
                reviewer.load_capture(self.capture, self.ref, self.root)
            self.manifest[key] = original
        self.write_manifest()

    def test_source_receipt_and_all_capture_files_are_hash_bound(self):
        (self.capture / 'source-proof.json').write_text('{}', encoding='utf8')
        with self.assertRaisesRegex(reviewer.ReviewError, 'SOURCE_MANIFEST_RECEIPT_MISMATCH'):
            reviewer.load_capture(self.capture, self.ref, self.root)
        self.write_manifest()
        (self.capture / 'catering-orders.json').write_bytes(self.order_bytes + b' ')
        with self.assertRaisesRegex(reviewer.ReviewError, 'CAPTURE_HASH_MISMATCH'):
            reviewer.load_capture(self.capture, self.ref, self.root)

    def test_original_pending_flags_are_not_sufficient_review(self):
        value = self.completed_review()
        for key in reviewer.RECOVERY_CHECKS:
            value['recovery_review'][key] = False
            with self.assertRaisesRegex(reviewer.ReviewError, 'COMPLETE_SYNTHETIC_AND_LOCAL_EXECUTION_REVIEW_REQUIRED'):
                reviewer.validate_review(value, self.manifest, self.entries)
            value['recovery_review'][key] = True

    def test_both_recovery_tables_and_core_defaults_must_be_selected(self):
        for number in (3, 4, 5):
            value = self.completed_review()
            next(entry for entry in value['entries'] if entry['dump_id'] == number)['include'] = False
            with self.assertRaises(reviewer.ReviewError):
                reviewer.validate_review(value, self.manifest, self.entries)

    def test_renderer_is_file_only_and_never_forwards_pg_environment(self):
        with patch.dict(reviewer.os.environ, {'PGPASSWORD': 'synthetic_never_forwarded'}):
            output, proof = self.render()
        args, options = self.calls[0]
        self.assertTrue(any(arg.startswith('--use-list=') for arg in args))
        self.assertFalse(any(arg.startswith(('--dbname', '--clean', '--create', '--no-acl')) for arg in args))
        self.assertFalse(any(key.upper().startswith('PG') for key in options['env']))
        self.assertFalse(proof['remote_connection'])
        self.assertFalse(proof['local_restore_verified'])
        self.assertTrue(output.is_dir())

    def test_derivative_keeps_exact_rows_and_original_pending_proof_immutable(self):
        source_before = {name: (self.capture / name).read_bytes() for name in reviewer.CAPTURE_FILES}
        output, _ = self.render()
        self.assertEqual((output / 'derived-recovery/catering-orders.json').read_bytes(), self.order_bytes)
        derived = json.loads((output / 'derived-recovery/recovery-source-proof.json').read_text(encoding='utf8'))
        self.assertTrue(derived['allRowsReviewedSynthetic'])
        self.assertFalse(derived['freeFormReviewPending'])
        self.assertFalse(derived['localRestoreProof'])
        for name, original in source_before.items():
            self.assertEqual((self.capture / name).read_bytes(), original)
        self.assertFalse(json.loads((self.capture / 'recovery-source-proof.json').read_text())['allRowsReviewedSynthetic'])

    def test_validating_derivative_detects_row_or_review_or_baseline_change(self):
        output, _ = self.render()
        result = reviewer.validate_rendered(output, self.ref, self.root)
        self.assertEqual(result['status'], 'SANDBOX_LOCAL_INPUT_VALIDATED_NOT_RESTORED')
        for path in (output / 'derived-recovery/catering-orders.json', output / 'reviewed-baseline.sql', self.capture / 'completed-review.json'):
            original = path.read_bytes()
            path.write_bytes(original + b' ')
            with self.assertRaises(reviewer.ReviewError):
                reviewer.validate_rendered(output, self.ref, self.root)
            path.write_bytes(original)

    def test_output_cannot_escape_private_root(self):
        with self.assertRaises(reviewer.ReviewError):
            reviewer.schema_review.private_directory(self.root, self.root)
        (self.root / '.git').mkdir()
        with self.assertRaises(reviewer.ReviewError):
            reviewer.load_capture(self.capture, self.ref, self.root)


if __name__ == '__main__':
    unittest.main()
