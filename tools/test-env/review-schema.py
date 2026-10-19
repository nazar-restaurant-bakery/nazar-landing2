"""Offline review/render of an actual private production schema capture.

No database connection, restore, reset or historical SQL patch is performed.
Every archive entry requires an explicit review decision before SQL is rendered.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


PRIVATE_ROOT = Path(__file__).resolve().parents[4] / '20_Yonetim/Teslim_Raporlari/K3_kanit/production-schema-private'
CAPTURE_FILES = ('catalog.json', 'raw-schema.dump', 'raw-toc.list', 'allowlist-review.json', 'schema.sql')
SECURITY_CHECKS = ('private_core_verified', 'function_acl_verified', 'policy_set_verified', 'definer_search_path_verified')
DATA_ENTRY = re.compile(r'^(?:TABLE DATA|MATERIALIZED VIEW DATA|SEQUENCE SET|BLOBS|BLOB DATA|LARGE OBJECT)\b')
SECRET = re.compile(r'\bsb_secret_[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}')


class ReviewError(Exception):
    """Only a fixed error code may be printed."""


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def private_directory(directory: Path, expected_root: Path = PRIVATE_ROOT) -> Path:
    if not directory.is_absolute():
        raise ReviewError('ABSOLUTE_PRIVATE_PATH_REQUIRED')
    root, target = expected_root.resolve(), directory.resolve()
    if target == root or root not in target.parents or not target.is_dir():
        raise ReviewError('CAPTURE_OUTSIDE_PRIVATE_ROOT')
    for ancestor in (directory, *directory.parents):
        if ancestor.is_symlink() or bool(getattr(ancestor.stat(), 'st_file_attributes', 0) & 0x400) or (ancestor / '.git').exists():
            raise ReviewError('PRIVATE_PATH_LINK_OR_GIT_REFUSED')
    return target


def load_capture(directory: Path, expected_root: Path = PRIVATE_ROOT) -> tuple[dict, dict, list[dict]]:
    directory = private_directory(directory, expected_root)
    manifest = json.loads((directory / 'capture-manifest.json').read_text(encoding='utf-8'))
    if manifest.get('mode') != 'PRODUCTION' or manifest.get('schemas') != ['core', 'public'] \
            or manifest.get('read_only') is not True or manifest.get('data_exported') is not False \
            or manifest.get('tls') != 'verify-full' or manifest.get('replay_ready') is not False:
        raise ReviewError('ACTUAL_READ_ONLY_PRODUCTION_CAPTURE_REQUIRED')
    if not re.fullmatch(r'[a-z]{20}', manifest.get('source_project_ref', '')):
        raise ReviewError('SOURCE_REF_MISSING')
    for name in CAPTURE_FILES:
        path = directory / name
        if not path.is_file() or path.is_symlink() or path.stat().st_size > 64 * 1024 * 1024:
            raise ReviewError('CAPTURE_FILE_MISSING_OR_UNSAFE')
        if manifest.get('files', {}).get(name) != digest(path):
            raise ReviewError('CAPTURE_HASH_MISMATCH')
    # Schema-only functions can still embed credentials. Do not print a match.
    if SECRET.search((directory / 'schema.sql').read_text(encoding='utf-8')):
        raise ReviewError('EMBEDDED_CREDENTIAL_REQUIRES_PRIVATE_REVIEW')
    catalog = json.loads((directory / 'catalog.json').read_text(encoding='utf-8'))
    if catalog.get('read_only') != 'on' or not isinstance(catalog.get('objects'), list):
        raise ReviewError('CATALOG_PROVENANCE_INVALID')
    entries = parse_toc((directory / 'raw-toc.list').read_text(encoding='utf-8'), catalog['objects'])
    return manifest, catalog, entries


def parse_toc(text: str, objects: list[dict]) -> list[dict]:
    by_oid = {(int(item['class_id']), int(item['object_id'])): item for item in objects}
    entries, seen = [], set()
    for line in text.splitlines():
        if not line or line.startswith(';'):
            continue
        match = re.fullmatch(r'(\d+); (\d+) (\d+) (.+)', line)
        if not match:
            raise ReviewError('TOC_FORMAT_UNSUPPORTED')
        number, class_id, object_id, description = match.groups()
        number, class_id, object_id = int(number), int(class_id), int(object_id)
        if number in seen:
            raise ReviewError('TOC_ID_DUPLICATED')
        seen.add(number)
        obj = by_oid.get((class_id, object_id), {})
        schema = obj.get('schema_name')
        # Some archive versions use synthetic catalog IDs for ACLs. A core
        # DEFAULT ACL is not a platform default merely because its IDs are 0.
        default_acl = re.match(r'^DEFAULT ACL (core|public) ', description)
        if default_acl and not schema:
            schema = default_acl.group(1)
        reason = None
        if DATA_ENTRY.match(description):
            reason = 'data_not_schema'
        elif re.search(r'\brls_auto_enable\b', description):
            reason = 'managed_public_rls_auto_enable'
        elif re.search(r'(?:^| )(?:EXTENSION|EVENT TRIGGER) ', description) or description.startswith(('DATABASE ', 'DATABASE PROPERTIES ', 'FOREIGN SERVER ', 'USER MAPPING ')):
            reason = 'platform_extension_or_event_trigger'
        elif description.startswith('SCHEMA ') and schema == 'public':
            reason = 'managed_public_schema_already_exists'
        elif description.startswith('DEFAULT ACL ') and (schema != 'core' or re.search(r'\bsupabase_[a-z_]+\s*$', description)):
            reason = 'platform_or_public_default_acl'
        elif class_id != 0 and (not obj or schema not in ('core', 'public')):
            reason = 'not_catalogued_application_object'
        entries.append({'dump_id': number, 'toc_line': line, 'description': description,
                        'schema': schema, 'kind': obj.get('kind'), 'identity': obj.get('identity'),
                        'forced_exclusion': reason})
    if not entries:
        raise ReviewError('EMPTY_ARCHIVE')
    return entries


def template(manifest: dict, entries: list[dict]) -> dict:
    return {'version': 1, 'capture_archive_sha256': manifest['files']['raw-schema.dump'],
            'review_complete': False, 'reviewer': '',
            'security_review': {key: False for key in SECURITY_CHECKS},
            'entries': [{'dump_id': item['dump_id'], 'include': False, 'application_object': False,
                         'description': item['description'], 'forced_exclusion': item['forced_exclusion'],
                         'reason': item['forced_exclusion'] or ''} for item in entries]}


def validate_review(review: dict, manifest: dict, entries: list[dict]) -> list[dict]:
    if review.get('version') != 1 or review.get('review_complete') is not True \
            or not isinstance(review.get('reviewer'), str) or not review['reviewer'].strip() \
            or review.get('capture_archive_sha256') != manifest['files']['raw-schema.dump']:
        raise ReviewError('EXPLICIT_ARCHIVE_BOUND_REVIEW_REQUIRED')
    if not all(review.get('security_review', {}).get(key) is True for key in SECURITY_CHECKS):
        raise ReviewError('PRIVATE_CORE_ACL_POLICY_DEFINER_REVIEW_REQUIRED')
    decisions = review.get('entries')
    if not isinstance(decisions, list) or len(decisions) != len(entries):
        raise ReviewError('EVERY_TOC_ENTRY_REQUIRES_DECISION')
    by_id = {}
    for item in decisions:
        if not isinstance(item, dict) or type(item.get('dump_id')) is not int or item['dump_id'] in by_id:
            raise ReviewError('REVIEW_ID_INVALID_OR_DUPLICATED')
        by_id[item['dump_id']] = item
    if set(by_id) != {item['dump_id'] for item in entries}:
        raise ReviewError('REVIEW_IDS_DO_NOT_MATCH_ARCHIVE')
    selected = []
    for item in entries:
        decision = by_id[item['dump_id']]
        if type(decision.get('include')) is not bool or not isinstance(decision.get('reason'), str) or not decision['reason'].strip():
            raise ReviewError('INCLUDE_AND_REASON_REQUIRED')
        if decision['include']:
            if item['forced_exclusion']:
                raise ReviewError('MANAGED_PLATFORM_OR_DATA_ENTRY_REFUSED')
            if decision.get('application_object') is not True:
                raise ReviewError('APPLICATION_OBJECT_REVIEW_REQUIRED')
            selected.append(item)
    if not selected or not any(item['schema'] == 'core' for item in selected):
        raise ReviewError('REVIEWED_CORE_BASELINE_REQUIRED')
    # Core default ACLs are part of the application's security contract; never
    # silently drop them through --no-acl or an automatic blanket exclusion.
    for item in entries:
        if item['schema'] == 'core' and item['description'].startswith('DEFAULT ACL ') \
                and not item['forced_exclusion'] \
                and not by_id[item['dump_id']]['include']:
            raise ReviewError('CORE_DEFAULT_ACL_MUST_BE_PRESERVED')
    return selected


def exclusive_json(path: Path, value: dict):
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)


def render_reviewed(directory: Path, review_name: str, pg_bin: Path, expected_root: Path = PRIVATE_ROOT) -> dict:
    manifest, _, entries = load_capture(directory, expected_root)
    if Path(review_name).name != review_name or review_name in CAPTURE_FILES or not review_name.endswith('.json'):
        raise ReviewError('REVIEW_MUST_BE_SEPARATE_PRIVATE_JSON')
    review_path = directory / review_name
    if review_path.is_symlink():
        raise ReviewError('REVIEW_LINK_REFUSED')
    review = json.loads(review_path.read_text(encoding='utf-8'))
    selected = validate_review(review, manifest, entries)
    capture_digest = digest(directory / 'capture-manifest.json')
    review_digest = digest(review_path)
    executable = pg_bin / 'pg_restore.exe'
    if not pg_bin.is_absolute() or not executable.is_file():
        raise ReviewError('EXPLICIT_PG_RESTORE_BINARY_REQUIRED')
    # A new subdirectory preserves both raw capture and all previous reviews.
    output = directory / ('reviewed_' + datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S_%f'))
    output.mkdir(exist_ok=False)
    toc_path, sql_path = output / 'reviewed-toc.list', output / 'reviewed-baseline.sql'
    toc_path.write_text('\n'.join(item['toc_line'] for item in selected) + '\n', encoding='utf-8')
    args = [str(executable), '--schema-only', '--no-owner', '--use-list=' + str(toc_path),
            '--file=' + str(sql_path), str(directory / 'raw-schema.dump')]
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith('PG')}
    try:
        result = subprocess.run(args, env=env, capture_output=True, timeout=120, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise ReviewError('OFFLINE_RENDER_FAILED') from None
    if result.returncode:
        raise ReviewError('OFFLINE_RENDER_FAILED')
    load_capture(directory, expected_root)
    if digest(directory / 'capture-manifest.json') != capture_digest or digest(review_path) != review_digest:
        raise ReviewError('SOURCE_OR_REVIEW_CHANGED_DURING_RENDER')
    proof = {'version': 1, 'status': 'REVIEWED_SQL_RENDERED_NOT_RESTORED', 'source': 'actual_production_schema_archive',
             'archive_sha256': manifest['files']['raw-schema.dump'], 'capture_manifest_sha256': capture_digest,
             'review_filename': review_name, 'review_sha256': review_digest, 'reviewed_toc_sha256': digest(toc_path), 'baseline_sha256': digest(sql_path),
             'selected_entries': len(selected), 'excluded_entries': len(entries) - len(selected),
             'data_copied': False, 'source_modified': False, 'remote_connection': False,
             'local_restore_verified': False, 'hosted_supabase_auth_verified': False,
             'security_review': review['security_review'], 'security_runtime_comparison_pending': True}
    exclusive_json(output / 'baseline-proof.json', proof)
    return proof


def validate_rendered(output: Path, expected_root: Path = PRIVATE_ROOT) -> dict:
    output = private_directory(output, expected_root)
    capture = output.parent
    manifest, _, entries = load_capture(capture, expected_root)
    proof = json.loads((output / 'baseline-proof.json').read_text(encoding='utf-8'))
    name = proof.get('review_filename', '')
    if not isinstance(name, str) or Path(name).name != name or name in CAPTURE_FILES or not name.endswith('.json'):
        raise ReviewError('REVIEW_FILENAME_INVALID')
    review_path = capture / name
    if review_path.is_symlink():
        raise ReviewError('REVIEW_LINK_REFUSED')
    review = json.loads(review_path.read_text(encoding='utf-8'))
    selected = validate_review(review, manifest, entries)
    if proof.get('source') != 'actual_production_schema_archive' or proof.get('archive_sha256') != manifest['files']['raw-schema.dump'] \
            or proof.get('capture_manifest_sha256') != digest(capture / 'capture-manifest.json') \
            or proof.get('review_sha256') != digest(review_path) \
            or proof.get('reviewed_toc_sha256') != digest(output / 'reviewed-toc.list') \
            or proof.get('baseline_sha256') != digest(output / 'reviewed-baseline.sql'):
        raise ReviewError('RENDERED_BASELINE_PROVENANCE_MISMATCH')
    expected_toc = '\n'.join(item['toc_line'] for item in selected) + '\n'
    if (output / 'reviewed-toc.list').read_text(encoding='utf-8') != expected_toc:
        raise ReviewError('RENDERED_TOC_NOT_REVIEWED_SELECTION')
    return {'status': 'REVIEWED_LOCAL_INPUT_VALIDATED_NOT_RESTORED', 'baseline_sha256': proof['baseline_sha256'],
            'selected_entries': len(selected), 'data_copied': False, 'remote_connection': False,
            'source_modified': False, 'security_runtime_comparison_pending': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture-dir', type=Path)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--create-template', action='store_true')
    action.add_argument('--render-review', metavar='REVIEW_JSON_FILENAME')
    action.add_argument('--validate-rendered', type=Path, metavar='REVIEWED_PRIVATE_DIRECTORY')
    parser.add_argument('--pg-bin', type=Path)
    args = parser.parse_args()
    if args.validate_rendered:
        print(json.dumps(validate_rendered(args.validate_rendered)))
        return
    if args.capture_dir is None:
        raise ReviewError('ACTUAL_PRIVATE_CAPTURE_REQUIRED')
    directory = private_directory(args.capture_dir)
    if args.create_template:
        manifest, _, entries = load_capture(directory)
        exclusive_json(directory / 'baseline-review-template.json', template(manifest, entries))
        print('PRIVATE_REVIEW_TEMPLATE_CREATED_NOT_APPROVED')
    elif not args.pg_bin:
        raise ReviewError('EXPLICIT_PG_RESTORE_BINARY_REQUIRED')
    else:
        proof = render_reviewed(directory, args.render_review, args.pg_bin)
        print(json.dumps({key: proof[key] for key in ('status', 'selected_entries', 'excluded_entries', 'remote_connection', 'local_restore_verified')}))


if __name__ == '__main__':
    try:
        main()
    except ReviewError as error:
        print(str(error))
        raise SystemExit(2)
    except Exception:
        print('PRIVATE_REVIEW_FAILED_NO_CONTENT_PRINTED')
        raise SystemExit(2)
