"""Inert files and mocked subprocess; never DB, provider, Auth or real credentials."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

CHECKOUT = Path(__file__).resolve().parents[1]
SOURCE = CHECKOUT / 'tools/test-env/k6-migrate.py'
SPEC = importlib.util.spec_from_file_location('k6_operator', SOURCE)
operator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(operator)
DUMMY = "SYNTHETIC &% 'quote' $value ü"


def preflight(target='test'):
    return {'scope': 'K6_READ_ONLY_PREFLIGHT', 'read_only': True, 'read_committed': True, 'database': 'postgres',
        'business_count': 1, 'business_marked_test': target == 'test', 'all_businesses_test': target == 'test',
        'core_closed': True, 'k4_guard': True, 'k5_guard': True, 'customers_rls': True,
        'replication_origin': True, 'dependency_tables': True, 'dependency_functions': True, 'k6_absent': True}


def acceptance():
    return {'scope': operator.ACCEPTANCE_SCOPE, 'checks': [{'name': 'synthetic_one', 'passed': True},
        {'name': 'synthetic_two', 'passed': True}], 'passed': 2, 'failed': 0, 'missing': [],
        'provider_calls': 0, 'real_sends': 0, 'account_operations': 0,
        'auth_http_claimed': False, 'fixtures_rolled_back': True}


class K6OperatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='k6-inert-unit-', dir=CHECKOUT)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.sql = self.root / operator.MIGRATION_NAME; self.sql.write_bytes(b'BEGIN;\nSELECT 6;\nCOMMIT;\n')
        self.accept = self.root / 'acceptance.sql'; self.accept.write_bytes(b'BEGIN;\nSELECT 2;\nROLLBACK;\n')
        self.psql = self.root / 'psql.exe'; self.psql.write_bytes(b'INERT_PSQL_NOT_EXECUTABLE')
        self.ca = self.root / 'ca.crt'; self.ca.write_bytes(b'INERT_CA')
        self.receipts = self.root / 'test-receipts'; self.receipts.mkdir()
        self.dependencies = {}
        entries = []
        for order in (3, 4):
            file = self.root / ('dependency-' + str(order) + '.sql')
            file.write_bytes(('BEGIN;\nSELECT ' + str(order) + ';\nCOMMIT;\n').encode())
            self.dependencies[order] = operator.sha(file)
            entries.append({'order': order, 'path': str(file), 'sha256': operator.sha(file)})
        self.config = {'migration': str(self.sql), 'migration_sha256': operator.sha(self.sql),
            'acceptance': str(self.accept), 'acceptance_sha256': operator.sha(self.accept), 'acceptance_minimum_checks': 2,
            'psql_path': str(self.psql), 'psql_binary_sha256': operator.sha(self.psql), 'psql_version': operator.PSQL_VERSION,
            'ca_path': str(self.ca), 'ca_sha256': operator.sha(self.ca), 'receipt_directory': str(self.receipts),
            'python_path': sys.executable, 'python_sha256': operator.sha(sys.executable), 'dependency_sources': entries,
            'targets': {target: {'name': 'Synthetic ' + target, 'ref': ref * 20, 'host': 'db.' + ref * 20 + '.supabase.co',
                'port': 5432, 'business_id': '11111111-2222-4333-8444-555555555555'} for target, ref in [('test','a'),('production','b')]}}
        self.path = self.root / 'config.json'; self.write_config()
        self.pin = patch.object(operator, 'APPROVED_MIGRATION_SHA256', self.config['migration_sha256']); self.pin.start(); self.addCleanup(self.pin.stop)
        self.deps = patch.object(operator, 'DEPENDENCIES', self.dependencies); self.deps.start(); self.addCleanup(self.deps.stop)
        self.runner = patch.object(operator.subprocess, 'run', side_effect=self.version); self.mock = self.runner.start(); self.addCleanup(self.runner.stop)
        self.calls = []

    def write_config(self):
        self.path.write_text(json.dumps(self.config), encoding='utf8')

    def version(self, args, **kwargs):
        self.assertEqual(args, [str(self.psql), '--version'])
        self.assertFalse(any(k.upper().startswith('PG') for k in kwargs['env']))
        return subprocess.CompletedProcess(args, 0, (operator.PSQL_VERSION + '\n').encode(), b'')

    def valid(self, target='test', allow=False):
        return operator.validate(self.path, target, allow)

    def fake(self, target='test', observation=None, result=None, mutate=None):
        def run(args, **kwargs):
            self.calls.append((list(args), {**kwargs, 'env': dict(kwargs['env'])}))
            self.assertTrue((Path(self.config['receipt_directory']) / (target + '-attempt.json')).exists())
            self.assertIn('-X', args); self.assertIn('--no-password', args); self.assertIn('--set=ON_ERROR_STOP=1', args)
            self.assertEqual(kwargs['env']['PGHOST'], self.config['targets'][target]['host'])
            self.assertEqual(kwargs['env']['PGUSER'], 'postgres'); self.assertEqual(kwargs['env']['PGPORT'], '5432')
            self.assertEqual(kwargs['env']['PGDATABASE'], 'postgres'); self.assertEqual(kwargs['env']['PGSSLMODE'], 'verify-full')
            self.assertEqual(kwargs['env']['PGSSLROOTCERT'], str(self.ca)); self.assertEqual(kwargs['env']['PGPASSWORD'], DUMMY)
            self.assertNotIn(DUMMY, repr(args)); self.assertLessEqual(kwargs['timeout'], 120)
            if '--file' not in args:
                self.assertIn(b'BEGIN READ ONLY;', kwargs['input']); self.assertIn(b'ROLLBACK;', kwargs['input'])
                value = preflight(target) if observation is None else observation
                if mutate: mutate()
            elif Path(args[-1]).name == 'acceptance.sql':
                self.assertIn('k6.test_business_id=', kwargs['env']['PGOPTIONS'])
                value = acceptance() if result is None else result
            else:
                self.assertEqual(Path(args[-1]).read_bytes(), self.sql.read_bytes()); value = ''
            return subprocess.CompletedProcess(args, 0, (value if isinstance(value, str) else json.dumps(value)).encode(), b'')
        return run

    def test_validation_and_plan_make_no_connection_or_credential_prompt(self):
        cfg = self.valid(); value = operator.plan(cfg, 'test')
        self.assertFalse(value['connection_started']); self.assertFalse(value['password_recorded'])
        self.assertEqual(self.mock.call_count, 1); self.assertRegex(value['plan_sha256'], r'^[a-f0-9]{64}$')
        self.assertEqual(list(self.receipts.iterdir()), [])

    def test_final_hash_missing_stops_before_any_process(self):
        with patch.object(operator, 'APPROVED_MIGRATION_SHA256', None):
            with self.assertRaisesRegex(ValueError, '^K6_FINAL_REVIEW_HASH_REQUIRED$'): self.valid()
        self.mock.assert_not_called()

    def test_direct_ref_port_and_secret_config_fields_fail_closed(self):
        for key, value in [('host','db.' + 'b'*20 + '.supabase.co'), ('host','db.'+'a'*20+'.supabase.co.evil.invalid'), ('port',6543), ('ref','b'*20)]:
            original = self.config['targets']['test'][key]; self.config['targets']['test'][key] = value; self.write_config()
            with self.assertRaisesRegex(ValueError, 'K6_DIRECT_TARGET_REQUIRED'): self.valid()
            self.config['targets']['test'][key] = original
        self.config['password'] = 'NOT_A_REAL_PASSWORD'; self.write_config()
        with self.assertRaisesRegex(ValueError, 'K6_CONFIG_INVALID'): self.valid()
        self.mock.assert_not_called()

    def test_exact_lf_sql_and_dependency_source_hashes_are_required(self):
        for file in (self.sql, self.accept, Path(self.config['dependency_sources'][1]['path'])):
            original = file.read_bytes(); file.write_bytes(original.replace(b'\n',b'\r\n'))
            with self.assertRaisesRegex(ValueError, 'LF_SOURCE_HASH_MISMATCH'): self.valid()
            file.write_bytes(original)
        self.config['dependency_sources'].reverse(); self.write_config()
        with self.assertRaisesRegex(ValueError, 'K6_DEPENDENCY_RECEIPTS_REQUIRED'): self.valid()

    def test_dependency_evidence_retains_real_format_without_invented_schema(self):
        file = self.root / 'actual-readback.txt'; file.write_text('Actual separately reviewed format', encoding='utf8')
        self.config['dependency_evidence'] = {'test':[{'path':str(file),'sha256':operator.sha(file)}], 'production':[]}; self.write_config()
        cfg = self.valid(); self.assertEqual(cfg['_evidence'], [operator.sha(file)])
        file.write_text('Changed', encoding='utf8')
        with self.assertRaisesRegex(ValueError, 'K6_DEPENDENCY_RECEIPTS_REQUIRED'): self.valid()

    def test_tool_ca_python_and_version_pins_are_checked_before_prompt(self):
        for file in (self.psql, self.ca):
            original = file.read_bytes(); file.write_bytes(original+b'changed')
            with self.assertRaisesRegex(ValueError, 'K6_PSQL_AND_CA_PINS_REQUIRED'): self.valid()
            file.write_bytes(original)
        self.mock.return_value = subprocess.CompletedProcess([],0,b'psql 99',b''); self.mock.side_effect=None
        with self.assertRaisesRegex(ValueError, 'K6_TOOL_VERSION_REQUIRED'): self.valid()

    def test_exclusive_attempt_frozen_bytes_masked_secret_handoff_and_rollback_acceptance(self):
        cfg = self.valid(); self.mock.side_effect = self.fake()
        with patch.dict(os.environ, {'PGHOST':'evil.invalid','PGSERVICEFILE':'unsafe','PGSSLMODE':'disable'}):
            result = operator.execute(cfg, 'test', DUMMY)
        self.assertEqual(len(self.calls),3); self.assertEqual(result['acceptance']['passed'],2)
        for args, kwargs in self.calls:
            self.assertNotIn('PGSERVICEFILE', kwargs['env'])
        for file in self.receipts.rglob('*'):
            if file.is_file(): self.assertNotIn(DUMMY.encode(), file.read_bytes())
        with self.assertRaises(FileExistsError): operator.execute(cfg,'test',DUMMY)
        self.assertEqual(len(self.calls),3)

    def test_dependency_or_target_catalogue_failure_stops_before_ddl(self):
        for key in ('dependency_tables','dependency_functions','k4_guard','k5_guard','core_closed','customers_rls','replication_origin','k6_absent','business_marked_test','all_businesses_test','read_committed'):
            cfg = self.valid(); self.mock.side_effect = self.fake(observation={**preflight(),key:False})
            with self.assertRaisesRegex(ValueError,'K6_PREFLIGHT_FAILED'): operator.execute(cfg,'test',DUMMY)
            self.assertEqual(len(self.calls),1); self.assertNotIn('--file',self.calls[0][0]); self.calls.clear()
            for child in self.receipts.iterdir():
                if child.is_file(): child.unlink()
                else:
                    for leaf in child.iterdir(): leaf.unlink()
                    child.rmdir()
            self.mock.side_effect=self.version

    def test_source_change_after_read_only_preflight_blocks_migration(self):
        cfg=self.valid(); self.mock.side_effect=self.fake(mutate=lambda:self.sql.write_bytes(self.sql.read_bytes()+b'--changed'))
        with self.assertRaisesRegex(ValueError,'K6_SOURCE_CHANGED'): operator.execute(cfg,'test',DUMMY)
        self.assertEqual(len(self.calls),1)

    def test_total_deadline_and_changed_launcher_stop_before_a_connection(self):
        cfg=self.valid(); self.mock.reset_mock()
        with patch.object(operator.time,'monotonic',side_effect=[0,301]):
            with self.assertRaisesRegex(ValueError,'K6_DEADLINE_EXCEEDED'): operator.execute(cfg,'test',DUMMY)
        self.mock.assert_not_called()
        other=self.root/'launcher-changed'; other.mkdir(); self.config['receipt_directory']=str(other); self.write_config(); cfg=self.valid()
        original=operator.sha
        with patch.object(operator,'sha',side_effect=lambda path:'f'*64 if Path(path)==operator.LAUNCHER else original(path)):
            self.mock.reset_mock()
            with self.assertRaisesRegex(ValueError,'K6_DISPLAYED_PLAN_CHANGED'): operator.execute(cfg,'test',DUMMY)
            self.mock.assert_not_called()

    def test_nonempty_receipt_dir_blocks_any_new_validation(self):
        (self.receipts/'old-attempt.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'K6_FRESH_RECEIPTS_REQUIRED'): self.valid()
        self.mock.assert_not_called()

    def test_ambiguous_timeout_and_auth_rejection_do_not_retry_or_echo_raw_error(self):
        for effect, expected in [(subprocess.TimeoutExpired('inert',1),'K6_TIMEOUT_OUTCOME_REVIEW_REQUIRED'),
            (subprocess.CompletedProcess([],1,b'',b'password authentication failed RAW '+DUMMY.encode()),'AUTH_REJECTED')]:
            cfg=self.valid(); self.mock.side_effect=effect if isinstance(effect,Exception) else lambda *a,**k:effect
            with self.assertRaisesRegex(ValueError,expected): operator.execute(cfg,'test',DUMMY)
            self.assertFalse((self.receipts/'test-success.json').exists())
            for child in self.receipts.iterdir():
                if child.is_file(): child.unlink()
                else:
                    for leaf in child.iterdir(): leaf.unlink()
                    child.rmdir()
            self.mock.side_effect=self.version

    def test_failed_acceptance_after_commit_is_not_success(self):
        cfg=self.valid(); self.mock.side_effect=self.fake(result={**acceptance(),'real_sends':1})
        with self.assertRaisesRegex(ValueError,'K6_ACCEPTANCE_FAILED'): operator.execute(cfg,'test',DUMMY)
        self.assertFalse((self.receipts/'test-success.json').exists())
        self.assertEqual(json.loads((self.receipts/'test-attempt.json').read_text())['phase'],'rollback_acceptance')

    def test_production_requires_explicit_flag_and_same_successful_test_bytes_and_tools(self):
        with self.assertRaisesRegex(ValueError,'K6_HUMAN_PRODUCTION_FLAG_REQUIRED'): self.valid('production')
        cfg=self.valid(); self.mock.side_effect=self.fake(); operator.execute(cfg,'test',DUMMY)
        proof=self.receipts/'test-success.json'; prod=self.root/'production-receipts'; prod.mkdir()
        self.config.update(receipt_directory=str(prod),test_success_path=str(proof),test_success_sha256=operator.sha(proof)); self.write_config()
        self.mock.side_effect=self.version; cfg=self.valid('production',True)
        self.calls.clear(); self.mock.side_effect=self.fake('production'); result=operator.execute(cfg,'production',DUMMY)
        self.assertEqual(len(self.calls),2); self.assertEqual(result['test_success_sha256'],operator.sha(proof))
        altered=json.loads(proof.read_text()); altered['operator_sha256']='f'*64; proof.write_text(json.dumps(altered)); self.config['test_success_sha256']=operator.sha(proof)
        other=self.root/'other-production'; other.mkdir(); self.config['receipt_directory']=str(other); self.write_config(); self.mock.side_effect=self.version
        with self.assertRaisesRegex(ValueError,'K6_TEST_SUCCESS_REQUIRED'): self.valid('production',True)

    def test_cli_requires_displayed_plan_and_human_confirmed_private_stdin(self):
        cfg=self.valid(); value=operator.plan(cfg,'test'); self.mock.side_effect=self.version
        output=io.StringIO()
        handoff={'password':DUMMY,'human_confirmed':False,'target_ref':'a'*20,'plan_sha256':value['plan_sha256']}
        with contextlib.redirect_stdout(output):
            code=operator.main(['--config',str(self.path),'--target','test','--execute','--plan-sha256',value['plan_sha256']],io.StringIO(json.dumps(handoff)))
        self.assertEqual(code,1); self.assertNotIn(DUMMY,output.getvalue()); self.assertFalse((self.receipts/'test-attempt.json').exists())

    def test_production_proof_binds_test_business_and_revalidates_read_only_preflight(self):
        cfg=self.valid(); self.mock.side_effect=self.fake(); operator.execute(cfg,'test',DUMMY)
        proof=self.receipts/'test-success.json'; original=json.loads(proof.read_text())
        for index,patch_value in enumerate([{'business_id':'99999999-9999-4999-8999-999999999999'},
            {'preflight':{**preflight(),'read_only':False}}, {'preflight':{**preflight(),'business_marked_test':False}}]):
            proof.write_text(json.dumps({**original,**patch_value}),encoding='utf8')
            fresh=self.root/('production-proof-'+str(index)); fresh.mkdir()
            self.config.update(receipt_directory=str(fresh),test_success_path=str(proof),test_success_sha256=operator.sha(proof)); self.write_config()
            self.mock.side_effect=self.version
            with self.assertRaisesRegex(ValueError,'K6_TEST_SUCCESS_REQUIRED|K6_PREFLIGHT_FAILED'): self.valid('production',True)

    def test_cli_revalidates_displayed_plan_before_reading_any_secret(self):
        cfg=self.valid(); displayed=operator.plan(cfg,'test')
        self.config['targets']['test']['name']='Changed displayed name'; self.write_config()
        stream=io.BytesIO(json.dumps({'password':DUMMY}).encode('utf8')); output=io.StringIO()
        with contextlib.redirect_stdout(output):
            code=operator.main(['--config',str(self.path),'--target','test','--execute','--plan-sha256',displayed['plan_sha256']],stream)
        self.assertEqual(code,1); self.assertEqual(stream.tell(),0); self.assertNotIn(DUMMY,output.getvalue())

    def test_cli_utf8_pipe_handoff_reaches_only_ephemeral_psql_env(self):
        cfg=self.valid(); displayed=operator.plan(cfg,'test'); fake=self.fake()
        self.mock.side_effect=lambda args,**kwargs:self.version(args,**kwargs) if args[-1]=='--version' else fake(args,**kwargs)
        stream=io.BytesIO(json.dumps({'password':DUMMY,'human_confirmed':True,'target_ref':'a'*20,
            'plan_sha256':displayed['plan_sha256']},ensure_ascii=False).encode('utf8'))
        output=io.StringIO()
        with contextlib.redirect_stdout(output):
            code=operator.main(['--config',str(self.path),'--target','test','--execute','--plan-sha256',displayed['plan_sha256']],stream)
        self.assertEqual(code,0); self.assertEqual(len(self.calls),3); self.assertNotIn(DUMMY,output.getvalue())

    def test_preflight_sql_is_read_only_and_checks_real_ops_k7_objects_without_auth_rows(self):
        sql=operator.preflight_sql(self.config['targets']['test']).decode()
        self.assertTrue(sql.startswith('BEGIN READ ONLY;')); self.assertTrue(sql.rstrip().endswith('ROLLBACK;'))
        self.assertNotIn('auth.users',sql)
        for expected in ('core.ops_metrics','core.orders','core.order_match_review','public.clover_order_ingest_v1','core.message_send_settings'):
            self.assertIn(expected,sql)

    def test_acceptance_requires_all_checks_zero_real_sends_and_rollback(self):
        for change in ({'fixtures_rolled_back':False},{'provider_calls':1},{'account_operations':1},
            {'auth_http_claimed':True},{'missing':['case']},{'failed':1},{'passed':1}):
            with self.assertRaisesRegex(ValueError,'K6_ACCEPTANCE_FAILED'): operator.acceptance({**acceptance(),**change},2)
        self.assertEqual(operator.safe_code(Exception('RAW '+DUMMY)),'K6_STOP_RESULT_REVIEW_REQUIRED')


    def transition_fixture(self):
        cfg = self.valid(); self.mock.side_effect = self.fake(); operator.execute(cfg, 'test', DUMMY)
        proof = self.receipts / 'test-success.json'
        legacy = json.loads(proof.read_text(encoding='utf8'))
        legacy.update(python_sha256=operator.TRANSITION_OLD_PYTHON_SHA256,
                      operator_sha256=operator.TRANSITION_OLD_OPERATOR_SHA256)
        proof.write_text(json.dumps(legacy), encoding='utf8')
        production = self.root / 'transition-production'; production.mkdir()
        self.config.update(receipt_directory=str(production), test_success_path=str(proof),
                           test_success_sha256=operator.sha(proof))
        # Inert fixture has its own exact anchor; real code pins the one actual
        # historical sandbox receipt and approved installed Python identity.
        for name, value in [('TRANSITION_TEST_SUCCESS_SHA256', operator.sha(proof)),
                            ('TRANSITION_NEW_PYTHON_SHA256', operator.sha(sys.executable)),
                            ('TRANSITION_NEW_PYTHON_VERSION', tuple(sys.version_info[:3]))]:
            mock = patch.object(operator, name, value); mock.start(); self.addCleanup(mock.stop)
        certificate = {
            'scope': operator.RUNTIME_TRANSITION_SCOPE, 'reviewed': True,
            'purpose': 'python_runtime_only', 'target': 'production',
            'test_ref': self.config['targets']['test']['ref'],
            'test_business_id': self.config['targets']['test']['business_id'],
            'production_ref': self.config['targets']['production']['ref'],
            'production_business_id': self.config['targets']['production']['business_id'],
            'test_success_sha256': operator.sha(proof),
            'old_python_sha256': operator.TRANSITION_OLD_PYTHON_SHA256,
            'new_python_sha256': operator.sha(sys.executable),
            'new_python_version': '.'.join(str(value) for value in sys.version_info[:3]),
            'old_operator_sha256': operator.TRANSITION_OLD_OPERATOR_SHA256,
            'new_operator_sha256': operator.sha(SOURCE),
            'migration_sha256': self.config['migration_sha256'],
            'acceptance_sha256': self.config['acceptance_sha256'],
            'psql_binary_sha256': self.config['psql_binary_sha256'], 'ca_sha256': self.config['ca_sha256'],
            'launcher_sha256': operator.sha(operator.LAUNCHER), 'support_sha256': operator.K5_SUPPORT_SHA256,
            'receipt_mutated': False, 'database_operations': 0,
        }
        file = self.root / 'reviewed-runtime-transition.json'
        file.write_text(json.dumps(certificate), encoding='utf8')
        self.config.update(runtime_transition_path=str(file), runtime_transition_sha256=operator.sha(file))
        self.write_config(); self.mock.side_effect = self.version; self.calls.clear(); self.mock.reset_mock()
        return proof, file, certificate

    def test_runtime_transition_is_explicit_and_keeps_old_receipt_bytes_unchanged(self):
        proof, file, certificate = self.transition_fixture(); before = proof.read_bytes()
        cfg = self.valid('production', True); plan = operator.plan(cfg, 'production')
        self.assertEqual(plan['runtime_transition_sha256'], operator.sha(file))
        self.assertEqual(plan['test_success_sha256'], operator.sha(proof))
        self.assertEqual(proof.read_bytes(), before); self.assertEqual(self.calls, [])
        self.assertFalse(plan['connection_started']); self.assertEqual(self.mock.call_count, 1)
        self.assertEqual(certificate['database_operations'], 0)

    def test_legacy_runtime_mismatch_without_certificate_is_still_rejected(self):
        proof, file, certificate = self.transition_fixture()
        self.config.pop('runtime_transition_path'); self.config.pop('runtime_transition_sha256'); self.write_config()
        with self.assertRaisesRegex(ValueError, 'K6_TEST_SUCCESS_REQUIRED'): self.valid('production', True)
        self.mock.assert_not_called()

    def test_runtime_certificate_rejects_tampering_missing_extra_and_false_attestation(self):
        proof, file, certificate = self.transition_fixture()
        patches = [{'scope': 'OTHER'}, {'reviewed': False}, {'reviewed': 1},
            {'target': 'test'}, {'purpose': 'ignore_all_pins'}, {'receipt_mutated': True},
            {'test_ref': 'c'*20}, {'test_business_id': '99999999-9999-4999-8999-999999999999'},
            {'production_ref': 'c'*20}, {'production_business_id': '99999999-9999-4999-8999-999999999999'},
            {'database_operations': 1}, {'database_operations': False}, {'extra_bypass': True},
            {'test_success_sha256': 'f'*64}, {'old_python_sha256': 'f'*64},
            {'new_python_sha256': 'f'*64}, {'new_python_version': '99.0.0'},
            {'old_operator_sha256': 'f'*64}, {'new_operator_sha256': 'f'*64},
            {'migration_sha256': 'f'*64}, {'acceptance_sha256': 'f'*64},
            {'psql_binary_sha256': 'f'*64}, {'ca_sha256': 'f'*64},
            {'launcher_sha256': 'f'*64}, {'support_sha256': 'f'*64}]
        for change in patches:
            file.write_text(json.dumps({**certificate, **change}), encoding='utf8')
            self.config['runtime_transition_sha256'] = operator.sha(file); self.write_config()
            with self.subTest(change=change):
                with self.assertRaisesRegex(ValueError, 'K6_RUNTIME_TRANSITION_INVALID'): self.valid('production', True)
        missing = dict(certificate); missing.pop('old_python_sha256')
        file.write_text(json.dumps(missing), encoding='utf8')
        self.config['runtime_transition_sha256'] = operator.sha(file); self.write_config()
        with self.assertRaisesRegex(ValueError, 'K6_RUNTIME_TRANSITION_INVALID'): self.valid('production', True)
        self.mock.assert_not_called()

    def test_runtime_certificate_digest_exact_receipt_and_executing_python_are_bound(self):
        proof, file, certificate = self.transition_fixture()
        before = file.read_bytes(); file.write_bytes(before + b' ')
        with self.assertRaisesRegex(ValueError, 'K6_RUNTIME_TRANSITION_INVALID'): self.valid('production', True)
        file.write_bytes(before)
        original = proof.read_bytes(); proof.write_bytes(original + b' ')
        self.config['test_success_sha256'] = operator.sha(proof); self.write_config()
        with self.assertRaisesRegex(ValueError, 'K6_RUNTIME_TRANSITION_INVALID'): self.valid('production', True)
        proof.write_bytes(original); self.config['test_success_sha256'] = operator.sha(proof); self.write_config()
        wrong = self.root / 'different-python.exe'; wrong.write_bytes(b'INERT_DIFFERENT_RUNTIME')
        with patch.object(operator.sys, 'executable', str(wrong)):
            with self.assertRaisesRegex(ValueError, 'K6_RUNTIME_TRANSITION_INVALID'): self.valid('production', True)
        self.mock.assert_not_called()

    def test_runtime_transition_pair_is_production_only_and_never_partial(self):
        proof, file, certificate = self.transition_fixture()
        for key in ('runtime_transition_path', 'runtime_transition_sha256'):
            value = self.config.pop(key); self.write_config()
            with self.assertRaisesRegex(ValueError, 'K6_RUNTIME_TRANSITION_INVALID'): self.valid('production', True)
            self.config[key] = value
        self.config['receipt_directory'] = str(self.receipts)
        # Test-target rejection happens before receipt freshness or any process.
        self.write_config()
        with self.assertRaisesRegex(ValueError, 'K6_RUNTIME_TRANSITION_INVALID'): self.valid('test')
        self.mock.assert_not_called()

    def test_runtime_certificate_does_not_bypass_changed_sql_psql_or_ca(self):
        proof, file, certificate = self.transition_fixture()
        for selected, code in [(self.sql, 'LF_SOURCE_HASH_MISMATCH'),
                               (self.psql, 'K6_PSQL_AND_CA_PINS_REQUIRED'),
                               (self.ca, 'K6_PSQL_AND_CA_PINS_REQUIRED')]:
            original = selected.read_bytes(); selected.write_bytes(original + b'CHANGED')
            with self.subTest(file=selected.name):
                with self.assertRaisesRegex(ValueError, code): self.valid('production', True)
            selected.write_bytes(original)
        self.mock.assert_not_called()

    def test_runtime_certificate_does_not_bypass_false_preflight_acceptance_or_target(self):
        proof, file, certificate = self.transition_fixture(); legacy = json.loads(proof.read_text())
        changes = [({'preflight': {**preflight(), 'read_only': False}}, 'K6_PREFLIGHT_FAILED'),
            ({'acceptance': {**acceptance(), 'real_sends': 1}}, 'K6_ACCEPTANCE_FAILED'),
            ({'business_id': '99999999-9999-4999-8999-999999999999'}, 'K6_TEST_SUCCESS_REQUIRED'),
            ({'dependency_source_sha256': ['f'*64, 'e'*64]}, 'K6_TEST_SUCCESS_REQUIRED')]
        for change, code in changes:
            proof.write_text(json.dumps({**legacy, **change}), encoding='utf8')
            digest = operator.sha(proof); self.config['test_success_sha256'] = digest
            file.write_text(json.dumps({**certificate, 'test_success_sha256': digest}), encoding='utf8')
            self.config['runtime_transition_sha256'] = operator.sha(file); self.write_config()
            with patch.object(operator, 'TRANSITION_TEST_SUCCESS_SHA256', digest):
                with self.subTest(change=change):
                    with self.assertRaisesRegex(ValueError, code): self.valid('production', True)
        self.mock.assert_not_called()

    def test_runtime_certificate_cannot_replay_for_different_configured_targets(self):
        proof, file, certificate = self.transition_fixture()
        for target, field, changed in [('production', 'ref', 'c'*20),
                                      ('production', 'business_id', '99999999-9999-4999-8999-999999999999'),
                                      ('test', 'ref', 'c'*20),
                                      ('test', 'business_id', '99999999-9999-4999-8999-999999999999')]:
            original = dict(self.config['targets'][target])
            self.config['targets'][target][field] = changed
            if field == 'ref': self.config['targets'][target]['host'] = 'db.' + changed + '.supabase.co'
            self.write_config()
            with self.subTest(target=target, field=field):
                with self.assertRaisesRegex(ValueError, 'K6_RUNTIME_TRANSITION_INVALID'): self.valid('production', True)
            self.config['targets'][target] = original
        self.mock.assert_not_called()

    def test_runtime_certificate_is_rechecked_after_preflight_before_any_migration(self):
        proof, file, certificate = self.transition_fixture(); before = proof.read_bytes()
        cfg = self.valid('production', True)
        self.mock.side_effect = self.fake('production', mutate=lambda: file.write_bytes(file.read_bytes()+b' '))
        with self.assertRaisesRegex(ValueError, 'K6_RUNTIME_TRANSITION_INVALID'): operator.execute(cfg, 'production', DUMMY)
        self.assertEqual(len(self.calls), 1); self.assertNotIn('--file', self.calls[0][0])
        self.assertEqual(proof.read_bytes(), before)


class K6PowerShellHandoffTests(unittest.TestCase):
    def setUp(self):
        candidates = [Path(sys.executable).parent.parent / 'native/powershell/pwsh.exe']
        installed = shutil.which('pwsh')
        if installed: candidates.append(Path(installed))
        self.pwsh = next((candidate for candidate in candidates if candidate.is_file()), None)
        if self.pwsh is None: self.skipTest('Installed PowerShell7 unavailable; no dependency is downloaded.')
        self.temp = tempfile.TemporaryDirectory(prefix='k6-wrapper-inert-', dir=CHECKOUT); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.wrapper = self.root/'k6-run.ps1'; self.wrapper.write_bytes(operator.LAUNCHER.read_bytes())
        self.config = self.root/'config.json'; self.config.write_text(json.dumps({'python_path':sys.executable,
            'python_sha256':operator.sha(sys.executable)}),encoding='utf8')
        fake = """import json,os,sys
from pathlib import Path
root=Path(__file__).parent
execute='--execute' in sys.argv
target=sys.argv[sys.argv.index('--target')+1]
(root/('execute-argv.json' if execute else 'validate-argv.json')).write_text(json.dumps(sys.argv[1:]))
if execute:
 data=json.loads(sys.stdin.buffer.read().decode('utf8'))
 safe={'password_match':data.get('password')==EXPECTED,'human_confirmed':data.get('human_confirmed') is True,
  'target_match':data.get('target_ref')=='a'*20,'plan_match':data.get('plan_sha256')=='c'*64,
  'inherited_pg_present':any(key.upper().startswith('PG') for key in os.environ),
  'secret_env_present':any(EXPECTED in value for value in os.environ.values())}
 (root/'handoff-check.json').write_text(json.dumps(safe))
 print(json.dumps({'scope':'K6_HUMAN_PSQL_MIGRATION','status':'completed','target':target,'password_recorded':False}))
else:
 print(json.dumps({'scope':'K6_OPERATOR_PLAN','target':target,'name':'Synthetic test','ref':'a'*20,
  'host':'db.'+'a'*20+'.supabase.co','connection_started':False,'plan_sha256':'c'*64,'migration_sha256':'d'*64}))
""".replace('import json,os,sys', 'import json,os,sys\nEXPECTED='+repr(DUMMY))
        (self.root/'k6-migrate.py').write_text(fake,encoding='utf8')

    def run_script(self, script, *arguments):
        env=dict(os.environ); env['PGPASSWORD']='STALE_SYNTHETIC_ENV_NOT_A_CREDENTIAL'
        return subprocess.run([str(self.pwsh),'-NoLogo','-NoProfile','-NonInteractive','-File',str(script),*arguments],
            capture_output=True,timeout=30,env=env)

    def test_validate_only_uses_actual_wrapper_with_no_prompt_or_execute_handoff(self):
        result=self.run_script(self.wrapper,'-Config',str(self.config),'-Target','test','-ValidateOnly')
        self.assertEqual(result.returncode,0,result.stderr.decode(errors='replace'))
        self.assertFalse((self.root/'execute-argv.json').exists()); self.assertNotIn(DUMMY.encode(),result.stdout+result.stderr)
        self.assertFalse(json.loads(result.stdout)['connection_started'])

    def test_actual_wrapper_requires_human_confirmation_and_production_flag_before_prompt(self):
        for arguments in (['-Target','test'],['-Target','production','-ConfirmTarget']):
            result=self.run_script(self.wrapper,'-Config',str(self.config),*arguments)
            self.assertNotEqual(result.returncode,0); self.assertFalse((self.root/'validate-argv.json').exists())

    def test_actual_wrapper_rejects_unc_before_get_content_or_starting_backend(self):
        result=self.run_script(self.wrapper,'-Config',r'\\synthetic.invalid\share\config.json','-Target','test','-ValidateOnly')
        self.assertNotEqual(result.returncode,0)
        self.assertIn(b'K6_LOCAL_ABSOLUTE_FILES_REQUIRED',result.stderr)
        self.assertFalse((self.root/'validate-argv.json').exists())

    def test_actual_wrapper_mocked_masked_prompt_preserves_unicode_specials_only_through_stdin(self):
        escape=lambda value:str(value).replace("'","''")
        harness=self.root/'synthetic-harness.ps1'
        harness.write_text("function global:Read-Host { param([string]$Prompt,[switch]$AsSecureString) "
            "if(-not $AsSecureString){throw 'UNMASKED_PROMPT'}; "
            "ConvertTo-SecureString '"+escape(DUMMY)+"' -AsPlainText -Force }\n& '"+escape(self.wrapper)+
            "' -Config '"+escape(self.config)+"' -Target test -ConfirmTarget\n",encoding='utf8')
        result=self.run_script(harness)
        self.assertEqual(result.returncode,0,result.stderr.decode(errors='replace'))
        self.assertNotIn(DUMMY.encode(),result.stdout+result.stderr)
        safe=json.loads((self.root/'handoff-check.json').read_text())
        self.assertEqual(safe,{'password_match':True,'human_confirmed':True,'target_match':True,'plan_match':True,
            'inherited_pg_present':False,'secret_env_present':False})
        for filename in ('validate-argv.json','execute-argv.json','handoff-check.json'):
            self.assertNotIn(DUMMY.encode(),(self.root/filename).read_bytes())


if __name__ == '__main__': unittest.main()
