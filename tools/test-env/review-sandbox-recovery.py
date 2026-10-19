"""Offline, archive-bound sandbox review for a new local recovery database.

Original captures remain immutable. Only explicitly reviewed application DDL is
rendered, with a derived recovery package whose later attestations are separately
bound to the original capture and review. No database connection is possible here.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess


SPEC = importlib.util.spec_from_file_location('k3_offline_schema_review', Path(__file__).with_name('review-schema.py'))
schema_review = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(schema_review)
ReviewError = schema_review.ReviewError
digest = schema_review.digest
PRIVATE_ROOT = Path(__file__).resolve().parents[4] / '20_Yonetim/Teslim_Raporlari/K3_kanit/sandbox-recovery'
CAPTURE_FILES = (*schema_review.CAPTURE_FILES, 'catering-orders.json', 'staff-anonymous.json', 'recovery-source-proof.json')
RECOVERY_CHECKS = ('all_complete_order_values_reviewed_synthetic', 'anonymous_staff_metadata_reviewed',
                   'local_execution_no_external_io_reviewed')


def load_capture(directory: Path, expected_ref: str, expected_root: Path = PRIVATE_ROOT):
    directory = schema_review.private_directory(directory, expected_root)
    if not re.fullmatch('[a-z]{20}', expected_ref):
        raise ReviewError('EXPLICIT_EXPECTED_SANDBOX_REF_REQUIRED')
    for name in ('capture-manifest.json', 'source-proof.json'):
        path = directory / name
        if not path.is_file() or path.is_symlink() or path.stat().st_size > 128 * 1024:
            raise ReviewError('CAPTURE_MANIFEST_MISSING_OR_UNSAFE')
    manifest = json.loads((directory / 'capture-manifest.json').read_text(encoding='utf8'))
    if manifest.get('mode') != 'SANDBOX' or manifest.get('source_project_ref') != expected_ref \
            or manifest.get('schemas') != ['core', 'public'] or manifest.get('read_only') is not True \
            or manifest.get('schema_data_exported') is not False or manifest.get('data_exported') is not True \
            or manifest.get('syntheticRowsExported') != 4 or manifest.get('anonymousStaffRowsExported') != 1 \
            or manifest.get('tls') != 'verify-full' or manifest.get('replay_ready') is not False:
        raise ReviewError('ACTUAL_READ_ONLY_SANDBOX_CAPTURE_REQUIRED')
    if (directory / 'source-proof.json').read_bytes() != (directory / 'capture-manifest.json').read_bytes():
        raise ReviewError('SOURCE_MANIFEST_RECEIPT_MISMATCH')
    for name in CAPTURE_FILES:
        path = directory / name
        if not path.is_file() or path.is_symlink() or path.stat().st_size > 64 * 1024 * 1024:
            raise ReviewError('CAPTURE_FILE_MISSING_OR_UNSAFE')
        if manifest.get('files', {}).get(name) != digest(path):
            raise ReviewError('CAPTURE_HASH_MISMATCH')
    orders = json.loads((directory / 'catering-orders.json').read_text(encoding='utf8'), parse_float=Decimal)
    staff = json.loads((directory / 'staff-anonymous.json').read_text(encoding='utf8'))
    if not isinstance(orders, list) or len(orders) != 4 or not all(isinstance(row, dict) for row in orders) \
            or not isinstance(staff, list) or len(staff) != 1 or not isinstance(staff[0], dict):
        raise ReviewError('EXACT_RECOVERY_ROW_COUNTS_REQUIRED')
    catalog = json.loads((directory / 'catalog.json').read_text(encoding='utf8'))
    if catalog.get('read_only') != 'on' or not isinstance(catalog.get('objects'), list):
        raise ReviewError('CATALOG_PROVENANCE_INVALID')
    if schema_review.SECRET.search((directory / 'schema.sql').read_text(encoding='utf8')):
        raise ReviewError('EMBEDDED_CREDENTIAL_REQUIRES_PRIVATE_REVIEW')
    source = json.loads((directory / 'recovery-source-proof.json').read_text(encoding='utf8'))
    if source.get('expectedCateringRows') != 4 or source.get('expectedStaffRows') != 1 \
            or source.get('cateringRowsSha256') != digest(directory / 'catering-orders.json') \
            or source.get('staffAnonymousSha256') != digest(directory / 'staff-anonymous.json') \
            or source.get('schemaDumpSucceeded') is not True or source.get('authPlatformPreserved') is not True \
            or source.get('markerClassificationPassed') is not True \
            or source.get('scope') != 'read_only_source_capture_not_reset_or_restore':
        raise ReviewError('CAPTURE_RECOVERY_PROVENANCE_INVALID')
    entries = schema_review.parse_toc((directory / 'raw-toc.list').read_text(encoding='utf8'), catalog['objects'])
    return directory, manifest, entries, source


def template(manifest: dict, entries: list[dict]):
    value = schema_review.template(manifest, entries)
    value['recovery_review'] = {key: False for key in RECOVERY_CHECKS}
    return value


def validate_review(value: dict, manifest: dict, entries: list[dict]):
    selected = schema_review.validate_review(value, manifest, entries)
    if not all(value.get('recovery_review', {}).get(key) is True for key in RECOVERY_CHECKS):
        raise ReviewError('COMPLETE_SYNTHETIC_AND_LOCAL_EXECUTION_REVIEW_REQUIRED')
    # Anonymous staff cannot reconstruct the real Auth principal. The schema is
    # restored without inserting any staff or Auth identity.
    for identity in ('TABLE public catering_orders ', 'TABLE core crm_staff '):
        if not any(item['description'].startswith(identity) for item in selected):
            raise ReviewError('REQUIRED_RECOVERY_TABLE_NOT_REVIEWED')
    return selected


def load_review(directory: Path, name: str):
    if not isinstance(name, str) or Path(name).name != name or name in CAPTURE_FILES or not name.endswith('.json'):
        raise ReviewError('SEPARATE_PRIVATE_REVIEW_FILENAME_REQUIRED')
    path = directory / name
    if not path.is_file() or path.is_symlink():
        raise ReviewError('REVIEW_MISSING_OR_LINKED')
    return path, json.loads(path.read_text(encoding='utf8'))


def render_reviewed(directory: Path, expected_ref: str, review_name: str, pg_bin: Path, expected_root: Path = PRIVATE_ROOT):
    directory, manifest, entries, source = load_capture(directory, expected_ref, expected_root)
    review_path, review = load_review(directory, review_name)
    selected = validate_review(review, manifest, entries)
    executable = pg_bin / 'pg_restore.exe'
    if not pg_bin.is_absolute() or not executable.is_file():
        raise ReviewError('EXPLICIT_PG_RESTORE_BINARY_REQUIRED')
    manifest_hash, review_hash = digest(directory / 'capture-manifest.json'), digest(review_path)
    output = directory / ('recovery_reviewed_' + datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S_%f'))
    output.mkdir(exist_ok=False)
    toc, baseline = output / 'reviewed-toc.list', output / 'reviewed-baseline.sql'
    toc.write_text('\n'.join(item['toc_line'] for item in selected) + '\n', encoding='utf8')
    args = [str(executable), '--schema-only', '--no-owner', '--use-list=' + str(toc),
            '--file=' + str(baseline), str(directory / 'raw-schema.dump')]
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith('PG')}
    try:
        result = subprocess.run(args, env=env, capture_output=True, timeout=120, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ReviewError('OFFLINE_RENDER_FAILED') from None
    if result.returncode:
        raise ReviewError('OFFLINE_RENDER_FAILED')
    load_capture(directory, expected_ref, expected_root)
    if digest(directory / 'capture-manifest.json') != manifest_hash or digest(review_path) != review_hash:
        raise ReviewError('SOURCE_OR_REVIEW_CHANGED_DURING_RENDER')
    package = output / 'derived-recovery'
    package.mkdir(exist_ok=False)
    for name in ('catering-orders.json', 'staff-anonymous.json'):
        shutil.copyfile(directory / name, package / name)
    shutil.copyfile(baseline, package / 'schema.sql')
    # This is a separately attested derivative. Never edit the source proof,
    # source manifest or exact order/staff bytes inside the original capture.
    derived = dict(source, allRowsReviewedSynthetic=True, freeFormReviewPending=False, localRestoreProof=False)
    schema_review.exclusive_json(package / 'recovery-source-proof.json', derived)
    proof = {'version': 1, 'source': 'actual_sandbox_read_only_capture',
             'status': 'REVIEWED_SANDBOX_RECOVERY_NOT_RESTORED',
             'capture_manifest_sha256': manifest_hash, 'review_filename': review_name,
             'review_sha256': review_hash, 'reviewed_toc_sha256': digest(toc),
             'baseline_sha256': digest(baseline),
             'derived_files': {name: digest(package / name) for name in
                               ('schema.sql', 'catering-orders.json', 'staff-anonymous.json', 'recovery-source-proof.json')},
             'selected_entries': len(selected), 'remote_connection': False,
             'local_restore_verified': False, 'staff_identity_restored': False}
    schema_review.exclusive_json(output / 'sandbox-recovery-proof.json', proof)
    return output, proof


def validate_rendered(output: Path, expected_ref: str, expected_root: Path = PRIVATE_ROOT):
    output = schema_review.private_directory(output, expected_root)
    capture, manifest, entries, source = load_capture(output.parent, expected_ref, expected_root)
    for name in ('sandbox-recovery-proof.json', 'reviewed-toc.list', 'reviewed-baseline.sql'):
        path = output / name
        if not path.is_file() or path.is_symlink() or path.stat().st_size > 64 * 1024 * 1024:
            raise ReviewError('REVIEWED_OUTPUT_MISSING_OR_UNSAFE')
    proof = json.loads((output / 'sandbox-recovery-proof.json').read_text(encoding='utf8'))
    if proof.get('version') != 1 or proof.get('source') != 'actual_sandbox_read_only_capture' \
            or proof.get('status') != 'REVIEWED_SANDBOX_RECOVERY_NOT_RESTORED':
        raise ReviewError('REVIEWED_SANDBOX_PROVENANCE_REQUIRED')
    review_path, review = load_review(capture, proof.get('review_filename'))
    selected = validate_review(review, manifest, entries)
    if proof.get('capture_manifest_sha256') != digest(capture / 'capture-manifest.json') \
            or proof.get('review_sha256') != digest(review_path) \
            or proof.get('reviewed_toc_sha256') != digest(output / 'reviewed-toc.list') \
            or proof.get('baseline_sha256') != digest(output / 'reviewed-baseline.sql'):
        raise ReviewError('REVIEWED_SANDBOX_HASH_CHAIN_MISMATCH')
    expected_toc = '\n'.join(item['toc_line'] for item in selected) + '\n'
    if (output / 'reviewed-toc.list').read_text(encoding='utf8') != expected_toc:
        raise ReviewError('REVIEWED_SELECTION_MISMATCH')
    package = output / 'derived-recovery'
    schema_review.private_directory(package, expected_root)
    for name in ('schema.sql', 'catering-orders.json', 'staff-anonymous.json', 'recovery-source-proof.json'):
        path = package / name
        if not path.is_file() or path.is_symlink() or proof.get('derived_files', {}).get(name) != digest(path):
            raise ReviewError('DERIVED_RECOVERY_HASH_MISMATCH')
    if digest(package / 'schema.sql') != proof['baseline_sha256'] \
            or digest(package / 'catering-orders.json') != manifest['files']['catering-orders.json'] \
            or digest(package / 'staff-anonymous.json') != manifest['files']['staff-anonymous.json']:
        raise ReviewError('DERIVED_BYTES_DIFFER_FROM_REVIEWED_SOURCE')
    derived = json.loads((package / 'recovery-source-proof.json').read_text(encoding='utf8'))
    if derived != dict(source, allRowsReviewedSynthetic=True, freeFormReviewPending=False, localRestoreProof=False):
        raise ReviewError('DERIVED_ATTESTATION_DIFFERENT_FROM_REVIEW')
    return {'status': 'SANDBOX_LOCAL_INPUT_VALIDATED_NOT_RESTORED',
            'baseline_sha256': proof['baseline_sha256'],
            'orders_sha256': manifest['files']['catering-orders.json'],
            'package_directory': str(package), 'remote_connection': False,
            'staff_identity_restored': False, 'real_jwt_validation': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture-dir', type=Path)
    parser.add_argument('--expected-project-ref', required=True)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--create-template', action='store_true')
    action.add_argument('--render-review')
    action.add_argument('--validate-rendered', type=Path)
    parser.add_argument('--pg-bin', type=Path)
    args = parser.parse_args()
    if args.validate_rendered:
        print(json.dumps(validate_rendered(args.validate_rendered, args.expected_project_ref)))
        return
    if args.capture_dir is None:
        raise ReviewError('ACTUAL_PRIVATE_CAPTURE_REQUIRED')
    directory, manifest, entries, _ = load_capture(args.capture_dir, args.expected_project_ref)
    if args.create_template:
        schema_review.exclusive_json(directory / 'sandbox-review-template.json', template(manifest, entries))
        print('SANDBOX_PRIVATE_REVIEW_TEMPLATE_CREATED_NOT_APPROVED')
    elif args.pg_bin is None:
        raise ReviewError('EXPLICIT_PG_RESTORE_BINARY_REQUIRED')
    else:
        output, proof = render_reviewed(directory, args.expected_project_ref, args.render_review, args.pg_bin)
        print(json.dumps({'status': proof['status'], 'selected_entries': proof['selected_entries'],
                          'private_reviewed_directory': str(output), 'remote_connection': False}))


if __name__ == '__main__':
    try:
        main()
    except ReviewError as error:
        print(str(error))
        raise SystemExit(2)
    except Exception:
        print('SANDBOX_PRIVATE_REVIEW_FAILED_NO_CONTENT_PRINTED')
        raise SystemExit(2)
