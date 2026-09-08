"""Offline counterexamples; fixture outcomes never claim canary qualification."""
import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('driver', HERE / 'scoped-driver.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class DriverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.r = driver.Runner(self.base / 'out', self.base, self.base)

    def command(self, name, code, **kwargs):
        return self.r.run(name, [sys.executable, '-c', code], **kwargs)

    def test_nonzero_retains_both_streams_and_diagnostics(self):
        row = self.command('failure', 'import sys;print("raw-out");print("raw-err",file=sys.stderr);sys.exit(7)')
        self.assertEqual(row['exitCode'], 7)
        self.assertEqual((self.r.out / row['stdout']).read_bytes(), b'raw-out\n')
        self.assertEqual((self.r.out / row['stderr']).read_bytes(), b'raw-err\n')
        self.assertTrue(row['started_at_utc'] <= row['ended_at_utc'])
        skipped = self.command('dependent', 'raise AssertionError()', deps=('failure',))
        self.assertEqual(skipped['status'], 'NOT_RUN')
        self.assertIsNone(skipped['exitCode'])
        self.assertEqual(self.command('diagnostic', 'print("collected")')['status'], 'SUCCESS')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.r.finish(), 1)
        self.assertEqual(json.loads((self.r.out / 'summary.json').read_text())['status'], 'FAILED')

    def test_missing_executable_is_not_success(self):
        row = self.r.run('missing', ['/nonexistent/canary-command'])
        self.assertEqual((row['status'], row['exitCode']), ('FAILED', 127))
        self.assertEqual(self.command('later', 'print(1)')['status'], 'SUCCESS')

    def test_old_output_is_untouched(self):
        stale = self.r.out / 'summary.json'
        stale.write_bytes(b'old success must remain unchanged')
        with self.assertRaises(FileExistsError):
            driver.Runner(self.r.out, self.base, self.base)
        self.assertEqual(stale.read_bytes(), b'old success must remain unchanged')
        result = subprocess.run([sys.executable, str(HERE / 'scoped-driver.py'),
            '--target-root', str(self.base), '--out', str(self.r.out),
            '--tool-head', 'a'*40, '--tool-tree', 'b'*40, '--publication-ref', 'fixture'], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout)['execution'], 'NOT_RUN')
        self.assertEqual(stale.read_bytes(), b'old success must remain unchanged')

    def test_target_sha_mismatch(self):
        values = iter(['b'*40, 'c'*40, '', driver.REPO])
        with patch.object(driver, 'git', side_effect=lambda *args: next(values)):
            with self.assertRaisesRegex(ValueError, 'CHECKOUT_IDENTITY_MISMATCH'):
                driver.identity(self.base, 'a'*40, 'c'*40)

    def test_dirty_target_is_rejected(self):
        values = iter(['a'*40, 'c'*40, ' M src/config.ts', driver.REPO])
        with patch.object(driver, 'git', side_effect=lambda *args: next(values)):
            with self.assertRaisesRegex(ValueError, 'CHECKOUT_DIRTY'):
                driver.identity(self.base, 'a'*40, 'c'*40)

    def test_pin_comparison_is_actual(self):
        bindir = self.base / 'bin'; bindir.mkdir()
        for node, npm, match in [('v22.23.2', '10.9.8', True), ('v26.5.0', '10.9.8', False), ('v22.23.2', '11.0.0', False)]:
            for name, version in [('node', node), ('npm', npm)]:
                file = bindir / name; file.write_text('#!/bin/sh\necho '+version+'\n'); file.chmod(0o755)
            self.r.env['PATH'] = str(bindir)
            if match:
                self.assertTrue(all(v['matches'] for v in driver.pins(self.r).values()))
            else:
                with self.assertRaisesRegex(ValueError, 'TOOLCHAIN_PIN_MISMATCH'):
                    driver.pins(self.r)

    def test_isolation_unavailable_blocks_execution(self):
        marker = self.base / 'executed'
        row = self.r.run('isolation', [sys.executable, str(HERE / 'check-isolation.py'),
            '--target-root', str(self.base / 'missing-target'), '--report', str(self.base / 'isolation.json'),
            '--', sys.executable, '-c', f'open({str(marker)!r},"w").write("bad")'], blocked=True)
        self.assertEqual((row['status'], row['exitCode']), ('BLOCKED', 78))
        self.assertFalse(marker.exists())
        self.assertEqual(json.loads((self.base / 'isolation.json').read_text())['kernel_isolation'], 'BLOCKED')

    def test_registry_missing_input_fails_even_if_helper_exit_zero(self):
        with self.assertRaises(FileNotFoundError):
            driver.registry_inputs(self.r)

    def test_registry_rejects_external_stale_install(self):
        directory = self.r.out / 'registry'
        (directory / 'install-dirs.json').write_text(json.dumps({'tarballInstallDir':str(self.base)}))
        with self.assertRaisesRegex(ValueError, 'FRESH_INSTALL_REQUIRED'):
            driver.registry_inputs(self.r)

    def test_failed_registry_never_uses_partial_inputs_but_tests_continue(self):
        # Exercise real orchestration/dependency settlement with subprocess effects stubbed.
        original = self.r.run
        def fake(name, command, **kw):
            if name in ('registry', 'isolation'):
                return original(name, [sys.executable, '-c', 'raise SystemExit('+('9' if name == 'registry' else '78')+')'],
                                deps=kw.get('deps', ()), blocked=kw.get('blocked', False))
            if name in ('identity', 'identity-after', 'pins', 'publication', 'tool-resolution'):
                kw['action'] = lambda: {'fixture': True}
            if name == 'registry-inputs':
                kw['action'] = lambda: (_ for _ in ()).throw(AssertionError('must not read partial input'))
            return original(name, [sys.executable, '-c', 'print("fixture command")'], **kw)
        with patch.object(self.r, 'run', side_effect=fake):
            driver.orchestrate(self.r, argparse.Namespace())
        for name in ('registry-inputs', 'scan-pre', 'probe', 'scan-post', 'security-tests'):
            self.assertEqual(self.r.results[name]['status'], 'NOT_RUN')
        self.assertEqual(self.r.results['identity-after']['status'], 'SUCCESS')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.r.finish(), 1)

    def test_scan_failure_blocks_probe_but_not_independent_tests(self):
        original = self.r.run
        def fake(name, command, **kw):
            if 'action' in kw:
                kw['action'] = lambda: {'fixture': True}
            code = 6 if name == 'scan-pre' else 0
            return original(name, [sys.executable, '-c', f'raise SystemExit({code})'], **kw)
        with patch.object(self.r, 'run', side_effect=fake):
            driver.orchestrate(self.r, argparse.Namespace())
        self.assertEqual(self.r.results['scan-pre']['status'], 'FAILED')
        self.assertEqual(self.r.results['probe']['status'], 'NOT_RUN')
        self.assertEqual(self.r.results['security-tests']['status'], 'SUCCESS')
        self.assertEqual(self.r.results['identity-after']['status'], 'SUCCESS')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.r.finish(), 1)

    def test_publication_mismatch_is_rejected(self):
        args = argparse.Namespace(publication_ref='fixture-branch', tool_head='a'*40, tool_tree='c'*40)
        raw = self.r.out / 'logs/remote-fixture.stdout'
        raw.write_text('b'*40+'\trefs/heads/fixture-branch\n')
        with patch.object(self.r, 'run', return_value={'exitCode': 0, 'stdout':'logs/remote-fixture.stdout'}):
            with self.assertRaisesRegex(ValueError, 'REMOTE_REF_MISMATCH'):
                driver.publication(self.r, args)

    def test_publication_network_blocker_is_preserved(self):
        args = argparse.Namespace(publication_ref='fixture-branch', tool_head='a'*40, tool_tree='c'*40)
        original = self.r.run
        with patch.object(self.r, 'run', return_value={'exitCode': 128}):
            row = original('publication', ['internal:publication'], action=lambda: driver.publication(self.r, args))
        self.assertEqual(row['status'], 'BLOCKED')

    def test_all_success_required_for_zero_exit(self):
        for name in driver.STEPS:
            self.command(name, 'print("fixture only")')
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(self.r.finish(), 0)
        summary = json.loads((self.r.out / 'summary.json').read_text())
        self.assertEqual(summary['status'], 'COMPLETED')
        self.assertFalse(summary['authorizationGranted'])

    def test_npm_configs_are_distinct_and_loadable(self):
        self.assertNotEqual(self.r.env['npm_config_userconfig'], self.r.env['npm_config_globalconfig'])
        row = self.r.run('npm-config', ['npm', 'config', 'get', 'registry'])
        self.assertEqual(row['exitCode'], 0, (self.r.out / row['stderr']).read_text())
        self.assertEqual((self.r.out / row['stdout']).read_text().strip(), 'https://registry.npmjs.org/')

    def test_credentials_not_inherited(self):
        with patch.dict(os.environ, {'EXTENDED_API_KEY': 'fixture-only', 'NODE_OPTIONS':'fixture-only', 'NPM_TOKEN':'fixture-only'}):
            r = driver.Runner(self.base / 'other', self.base, self.base)
        self.assertFalse({'EXTENDED_API_KEY', 'NODE_OPTIONS', 'NPM_TOKEN'} & r.env.keys())


class ScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.lock = self.base / 'lock.json'; self.lock.write_text('{"packages":{"":{"name":"canary"}}}')
        self.tar = self.base / 'tar.txt'; self.tar.write_text('package/src/config.ts\n')
        self.install = self.base / 'install'
        self.pkg = self.install / 'node_modules/ws'; self.pkg.mkdir(parents=True)
        (self.pkg / 'package.json').write_text('{"name":"ws"}')
        self.env = dict(os.environ, CANARY_LOCKFILE=str(self.lock), CANARY_TAR_LIST=str(self.tar), CANARY_INSTALL_DIR=str(self.install))
        self.env.pop('CANARY_LOAD_LOG', None)

    def scan(self):
        return subprocess.run([sys.executable, str(HERE / 'scan-extra-boundaries.py'), str(self.base)], env=self.env, capture_output=True)

    def test_clean_graph(self):
        self.assertEqual(self.scan().returncode, 0)

    def test_forbidden_hit_is_nonzero(self):
        (self.pkg / 'package.json').write_text('{"name":"toml"}')
        self.assertEqual(self.scan().returncode, 1)
        self.assertIn('toml', json.loads((self.base / 'extra-boundary-scan.json').read_text())['hits']['installed_names'])

    def test_missing_install(self):
        self.env['CANARY_INSTALL_DIR'] = str(self.base / 'absent')
        self.assertNotEqual(self.scan().returncode, 0)

    def test_malformed_package(self):
        (self.pkg / 'package.json').write_text('{broken')
        self.assertNotEqual(self.scan().returncode, 0)

    def test_missing_requested_load_log(self):
        self.env['CANARY_LOAD_LOG'] = str(self.base / 'absent')
        self.assertNotEqual(self.scan().returncode, 0)

    def test_empty_load_graph(self):
        file = self.base / 'graph.json'; file.write_text('[]')
        self.env['CANARY_LOAD_LOG'] = str(file)
        self.assertNotEqual(self.scan().returncode, 0)

    def test_missing_package_metadata(self):
        (self.pkg / 'package.json').unlink()
        self.assertNotEqual(self.scan().returncode, 0)

    def test_scoped_symlink_rejected(self):
        external = self.base / 'external'; external.mkdir()
        (self.install / 'node_modules/@scope').symlink_to(external, target_is_directory=True)
        self.assertNotEqual(self.scan().returncode, 0)

    def test_malformed_load_graph(self):
        file = self.base / 'graph.json'; file.write_text('not a graph')
        self.env['CANARY_LOAD_LOG'] = str(file)
        self.assertNotEqual(self.scan().returncode, 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
