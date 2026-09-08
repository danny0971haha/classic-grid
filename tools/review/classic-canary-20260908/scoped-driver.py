#!/usr/bin/env python3
"""Credential-free review orchestration. Results are evidence, never acceptance."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys

TARGET_HEAD = 'fd9c1e0bbe920bce6e06dd39d364f0e2e82456cf'
TARGET_TREE = '7f14f66eac518c4427076f18fbcfdc7d935c79d8'
ORIGINAL_TOOL = '3ca01ae046f27aa4ca74e9e8370928a48d0c7810'
ORIGINAL_TREE = 'c756dedb245d1560cafb8f3ea018cc0180da6244'
REPO = 'https://github.com/danny0971haha/classic-grid.git'
TARGET_BRANCH = 'fix/classic-audit-output-path-20260906'
TOOL_DIR = Path(__file__).resolve().parent
TOOL_ROOT = TOOL_DIR.parents[2]
STEPS = ['identity', 'pins', 'isolation', 'publication', 'dependency-preparation',
         'tool-resolution', 'registry', 'registry-inputs', 'scan-pre', 'security-tests',
         'probe', 'scan-post', 'identity-after']


class EnvironmentBlocked(RuntimeError):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def write_json(file, value):
    file.write_text(json.dumps(value, indent=2) + '\n')


class Runner:
    def __init__(self, out, target, tool):
        # mkdir is atomic; even an empty pre-existing output is rejected. No stale reads.
        out.mkdir(parents=True, exist_ok=False)
        self.out, self.target, self.tool = out, target, tool
        for directory in ('logs', 'registry', 'offline', 'home', 'tmp', 'nested'):
            (out / directory).mkdir()
        self.env = {'PATH': os.environ.get('PATH', ''), 'HOME': str(out / 'home'),
                    'TMPDIR': str(out / 'tmp'), 'LANG': 'C.UTF-8',
                    'PYTHONDONTWRITEBYTECODE': '1', 'GIT_NO_LAZY_FETCH': '1',
                    'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_NOSYSTEM': '1',
                    'GIT_CONFIG_GLOBAL': os.devnull,
                    'npm_config_userconfig': str(out / 'home/user.npmrc'),
                    'npm_config_globalconfig': str(out / 'home/global.npmrc'),
                    'npm_config_registry': 'https://registry.npmjs.org/',
                    'npm_config_update_notifier': 'false', 'npm_config_fund': 'false',
                    'npm_config_audit': 'false', 'npm_config_fetch_retries': '0',
                    'CANARY_TRACE_DIR': str(out / 'nested')}
        for name in ('user.npmrc', 'global.npmrc'):
            (out / 'home' / name).write_text('')
        self.results = {}

    def run(self, name, command, cwd=None, deps=(), env=None, blocked=False, action=None):
        row = {'name': name, 'command': command, 'cwd': str(cwd or self.target),
               'started_at_utc': now(), 'ended_at_utc': None, 'exitCode': None,
               'status': 'NOT_RUN', 'reason': None}
        failed = [dep for dep in deps if self.results.get(dep, {}).get('status') != 'SUCCESS']
        stdout, stderr = self.out / 'logs' / (name + '.stdout'), self.out / 'logs' / (name + '.stderr')
        if failed:
            row['reason'] = 'DEPENDENCY_NOT_SUCCESS:' + ','.join(failed)
            stdout.write_bytes(b''); stderr.write_bytes(b'')
        else:
            with stdout.open('wb') as out, stderr.open('wb') as err:
                try:
                    if action is not None:
                        value = action()
                        out.write((json.dumps(value, indent=2) + '\n').encode())
                        row['exitCode'] = 0
                    else:
                        with subprocess.Popen(command, cwd=cwd or self.target, env=env or self.env,
                                              stdout=out, stderr=err, start_new_session=True) as child:
                            try:
                                row['exitCode'] = child.wait(timeout=600)
                            except subprocess.TimeoutExpired:
                                os.killpg(child.pid, signal.SIGKILL)
                                child.wait()
                                row['exitCode'] = 124
                                err.write(b'COMMAND_TIMEOUT\n')
                    row['status'] = 'SUCCESS' if row['exitCode'] == 0 else (
                        'BLOCKED' if blocked or row['exitCode'] == 78 else 'FAILED')
                except Exception as error:
                    err.write((f'{type(error).__name__}:{error}\n').encode())
                    row.update(exitCode=127 if isinstance(error, OSError) else 1,
                               status='BLOCKED' if blocked or isinstance(error, EnvironmentBlocked) else 'FAILED')
        row['ended_at_utc'] = now()
        for key, file in [('stdout', stdout), ('stderr', stderr)]:
            row[key] = str(file.relative_to(self.out))
            row[key + 'Sha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
        self.results[name] = row
        write_json(self.out / 'logs' / (name + '.meta.json'), row)
        print(f'{name}: {row["status"]} exit={row["exitCode"]}', file=sys.stderr)
        return row

    def finish(self):
        for name in STEPS:
            if name not in self.results:
                self.run(name, [], deps=('aborted-before-step',))
        rows = list(self.results.values())
        status = 'FAILED' if any(r['status'] == 'FAILED' for r in rows) else (
            'BLOCKED' if any(r['status'] == 'BLOCKED' for r in rows) else (
                'INCOMPLETE' if any(r['status'] == 'NOT_RUN' for r in rows) else 'COMPLETED'))
        result = {'schema': 'classic-canary-scoped/20260909', 'status': status,
                  'exitCode': 0 if status == 'COMPLETED' else 1, 'steps': rows,
                  'targetHead': TARGET_HEAD, 'targetTree': TARGET_TREE,
                  'rootDependencyClearance': False, 'rootVerification': 'NOT_RUN_OUT_OF_SCOPE',
                  'authorizationGranted': False}
        write_json(self.out / 'summary.json', result)
        # Exclude ephemeral homes/install trees; keep published evidence portable.
        excluded = {'home', 'tmp', 'packed', 'lock-install', 'tarball-install'}
        files = [p for p in sorted(self.out.rglob('*')) if p.is_file() and
                 not excluded.intersection(p.relative_to(self.out).parts) and
                 p.name not in ('SHA256SUMS', 'artifact-manifest.json')]
        manifest = [{'path': str(p.relative_to(self.out)), 'bytes': p.stat().st_size,
                     'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]
        write_json(self.out / 'artifact-manifest.json', manifest)
        files.append(self.out / 'artifact-manifest.json')
        (self.out / 'SHA256SUMS').write_text(''.join(
            f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(self.out)}\n' for p in files))
        print(json.dumps(result))
        return result['exitCode']


def git(root, *args, recorder=None):
    if recorder is not None:
        name = 'git-' + str(sum(key.startswith('git-') for key in recorder.results) + 1).zfill(3)
        row = recorder.run(name, ['git', '-C', str(root), *args], cwd=recorder.tool)
        if row['exitCode'] != 0:
            raise ValueError('GIT_IDENTITY_COMMAND_FAILED:' + name)
        return (recorder.out / row['stdout']).read_text().strip()
    return subprocess.check_output(['git', '-C', str(root), *args], text=True,
        env={'PATH': os.environ['PATH'], 'GIT_NO_LAZY_FETCH': '1', 'GIT_CONFIG_NOSYSTEM': '1',
             'GIT_CONFIG_GLOBAL': os.devnull}).strip()


def identity(root, head, tree, reader=None):
    read = reader or git
    observed = {'root': str(root), 'head': read(root, 'rev-parse', 'HEAD'),
                'tree': read(root, 'rev-parse', 'HEAD^{tree}'),
                'status': read(root, 'status', '--porcelain', '--untracked-files=all'),
                'origin': read(root, 'remote', 'get-url', 'origin')}
    if observed['head'] != head or observed['tree'] != tree:
        raise ValueError('CHECKOUT_IDENTITY_MISMATCH:' + json.dumps(observed))
    if observed['status']:
        raise ValueError('CHECKOUT_DIRTY:' + json.dumps(observed))
    if observed['origin'] != REPO:
        raise ValueError('REPOSITORY_MISMATCH')
    if any(p.name != '.env.example' for p in root.glob('.env*')):
        raise ValueError('LOCAL_ENV_FILE_PRESENT')
    if (root / '.npmrc').exists():
        raise ValueError('LOCAL_NPMRC_PRESENT')
    return observed


def identities(runner, args, filename="identities.json"):
    read = lambda root, *args: git(root, *args, recorder=runner)
    result = {'target': identity(runner.target, TARGET_HEAD, TARGET_TREE, reader=read),
              'tool': identity(runner.tool, args.tool_head, args.tool_tree, reader=read)}
    if read(runner.tool, 'rev-parse', ORIGINAL_TOOL + '^{tree}') != ORIGINAL_TREE:
        raise ValueError('ORIGINAL_TOOL_TREE_MISMATCH')
    if read(runner.tool, 'merge-base', ORIGINAL_TOOL, args.tool_head) != ORIGINAL_TOOL:
        raise ValueError('TOOL_NOT_DESCENDANT_OF_VERIFIED_BASE')
    # Tests/helpers are explicitly imported from target, but scope drift is rejected too.
    changed = read(runner.tool, 'diff', '--name-only', TARGET_HEAD, args.tool_head).splitlines()
    allowed = ('tools/review/classic-canary-20260908/',
               'docs/evidence/classic-canary-review-20260908/',
               'docs/evidence/classic-canary-linux-20260909/')
    if any(not p.startswith(allowed) and p != '.github/workflows/classic-canary-scoped.yml' for p in changed):
        raise ValueError('OUT_OF_SCOPE_TOOL_DELTA:' + json.dumps(changed))
    result['originalTool'] = {'head': ORIGINAL_TOOL, 'tree': ORIGINAL_TREE}
    result['tool_changed_paths_from_target'] = changed
    write_json(runner.out / filename, result)
    return result


def pins(runner):
    values = {}
    for name, expected in [('node', 'v22.23.2'), ('npm', '10.9.8')]:
        row = runner.run('version-' + name, [name, '--version'], cwd=runner.tool, blocked=True)
        observed = (runner.out / row['stdout']).read_text().strip()
        values[name] = {'expected': expected, 'observed': observed, 'matches': observed == expected and row['exitCode'] == 0}
    write_json(runner.out / 'pins.json', values)
    if not all(v['matches'] for v in values.values()):
        raise ValueError('TOOLCHAIN_PIN_MISMATCH:' + json.dumps(values))
    return values


def publication(runner, args):
    if args.publication_ref in (TARGET_BRANCH, 'tooling/classic-canary-review-20260908',
            'experiment/classic-v0.2-100u-safety', 'experiment/classic-v0.2-r2-extended-sepolia'):
        raise ValueError('PUBLICATION_REF_MUST_BE_SEPARATE_CORRECTIVE_BRANCH')
    row = runner.run('remote-refs', ['git', 'ls-remote', REPO,
        'refs/heads/' + TARGET_BRANCH, 'refs/heads/' + args.publication_ref,
        'refs/heads/tooling/classic-canary-review-20260908',
        'refs/heads/experiment/classic-v0.2-100u-safety',
        'refs/heads/experiment/classic-v0.2-r2-extended-sepolia'], cwd=runner.tool, blocked=True)
    if row['exitCode'] != 0:
        raise EnvironmentBlocked('REMOTE_REFS_UNAVAILABLE')
    refs = dict(line.split()[::-1] for line in (runner.out / row['stdout']).read_text().splitlines())
    expected = {TARGET_BRANCH: TARGET_HEAD, args.publication_ref: args.tool_head,
                'tooling/classic-canary-review-20260908': ORIGINAL_TOOL,
                'experiment/classic-v0.2-100u-safety': '990a790706e17b52e04d0d1957505cdad5d45862',
                'experiment/classic-v0.2-r2-extended-sepolia': '39bf3a797b58f7fd91babf9f2d608cfd28e04487'}
    result = {'expected': expected, 'observed': refs, 'publicationTree': args.tool_tree,
              'treeVerification': 'REMOTE_COMMIT_MATCH_AND_LOCAL_GIT_OBJECT_TREE'}
    write_json(runner.out / 'publication.json', result)
    if any(refs.get('refs/heads/' + name) != sha for name, sha in expected.items()):
        raise ValueError('REMOTE_REF_MISMATCH')
    return result


def registry_inputs(runner):
    directory = runner.out / 'registry'
    data = json.loads((directory / 'install-dirs.json').read_text())
    install = Path(data['tarballInstallDir'])
    if install.resolve() != (directory / 'tarball-install').resolve() or not (install / 'node_modules').is_dir():
        raise ValueError('FRESH_INSTALL_REQUIRED')
    for name in ['content-manifest.json', 'tarball-list.txt', 'canary-audit.json',
                 'canary-package-lock.json', 'classic-grid-extended-canary-0.2.0.tgz', 'registry-phase.json']:
        if not (directory / name).is_file() or not (directory / name).stat().st_size:
            raise ValueError('REGISTRY_INPUT_REQUIRED:' + name)
    phase = json.loads((directory / 'registry-phase.json').read_text())
    audit = json.loads((directory / 'canary-audit.json').read_text())
    counts = audit['metadata']['vulnerabilities']
    if counts['high'] != 0 or counts['critical'] != 0 or phase['audit']['exitCode'] not in (0, 1):
        raise ValueError('CANARY_AUDIT_POLICY_FAILED')
    for name, key in [('classic-grid-extended-canary-0.2.0.tgz', 'artifact_sha256'),
                      ('content-manifest.json', 'content_manifest_sha256'),
                      ('canary-package-lock.json', 'packed_lockfile_sha256')]:
        if hashlib.sha256((directory / name).read_bytes()).hexdigest() != phase['identities'][key]:
            raise ValueError('REGISTRY_ARTIFACT_HASH_MISMATCH:' + name)
    return data


def orchestrate(runner, args):
    r, target, tool, out = runner, runner.target, runner.tool, runner.out
    td = tool / 'tools/review/classic-canary-20260908'
    isolate = [sys.executable, str(td / 'check-isolation.py'), '--target-root', str(target)]
    def offline(name, command):
        return isolate + ['--report', str(out / 'offline' / (name + '-isolation.json')), '--'] + command
    node = ['node', '--import', str(td / 'trace-child.mjs'), '--import',
            str(target / 'node_modules/tsx/dist/loader.mjs')]
    r.run('identity', ['internal:identities'], action=lambda: identities(r, args))
    r.run('pins', ['internal:compare-node-npm-pins'], action=lambda: pins(r), blocked=True)
    r.run('isolation', isolate + ['--report', str(out / 'offline/isolation-check.json')],
          cwd=tool, deps=('identity',), blocked=True)
    r.run('publication', ['internal:verify-remote-publication'], action=lambda: publication(r, args), deps=('identity',))
    r.run('dependency-preparation', ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
          deps=('identity', 'pins', 'publication'), blocked=True)
    def resolution():
        modules = tool / 'node_modules'
        if modules.exists() or modules.is_symlink():
            raise ValueError('STALE_TOOL_NODE_MODULES')
        loader = target / 'node_modules/tsx/dist/loader.mjs'
        if not loader.is_file():
            raise ValueError('TARGET_TSX_LOADER_REQUIRED')
        return {'loader': str(loader.resolve()), 'toolNodeModulesUsed': False}
    r.run('tool-resolution', ['internal:resolve-target-loader'], action=resolution, deps=('dependency-preparation',))
    r.run('registry', node + [str(td / 'run-registry-phase.ts'), '--target-root', str(target),
                              '--out-dir', str(out / 'registry')], deps=('tool-resolution',))
    r.run('registry-inputs', ['internal:validate-fresh-registry-inputs'],
          action=lambda: registry_inputs(r), deps=('registry',))
    scanenv = dict(r.env, CANARY_LOCKFILE=str(target / 'packages/extended-canary/package-lock.json'),
                   CANARY_TAR_LIST=str(out / 'registry/tarball-list.txt'),
                   CANARY_INSTALL_DIR=str(out / 'registry/tarball-install'))
    scan = [sys.executable, str(td / 'scan-extra-boundaries.py')]
    # Static diagnostic may run even when kernel isolation is unavailable.
    r.run('scan-pre', scan + [str(out / 'registry')], deps=('registry-inputs',), env=scanenv)
    tests = [f'test/security/{name}.test.ts' for name in [
        'extended-canary-boundary', 'source-policy', 'canary-manifest-strict', 'canary-artifact-content']]
    r.run('security-tests', offline('tests', node + ['--test'] + tests),
          deps=('tool-resolution', 'isolation'))
    r.run('probe', offline('probe', node + [str(td / 'run-userspace-probe.ts'),
          '--target-root', str(target), '--install-dir', str(out / 'registry/tarball-install'),
          '--out-dir', str(out / 'offline')]), deps=('registry-inputs', 'scan-pre', 'isolation'))
    r.run('scan-post', offline('scan-post', scan + [str(out / 'offline')]),
          deps=('probe',), env=dict(scanenv, CANARY_LOAD_LOG=str(out / 'offline/probe-module-graph.json')))
    r.run('identity-after', ['internal:identities-after'], action=lambda: identities(r, args, 'identities-after.json'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target-root', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--tool-head', required=True)
    parser.add_argument('--tool-tree', required=True)
    parser.add_argument('--publication-ref', required=True)
    args = parser.parse_args()
    out, target = args.out.absolute(), args.target_root.resolve()
    try:
        if not all(re.fullmatch('[0-9a-f]{40}', s) for s in (args.tool_head, args.tool_tree)):
            raise ValueError('FULL_TOOL_SHA_REQUIRED')
        if target == TOOL_ROOT or out.is_relative_to(target) or out.is_relative_to(TOOL_ROOT):
            raise ValueError('SEPARATE_CHECKOUTS_AND_EXTERNAL_FRESH_OUTPUT_REQUIRED')
        runner = Runner(out, target, TOOL_ROOT)
    except Exception as error:
        print(json.dumps({'status': 'FAILED', 'exitCode': 1, 'reason': str(error),
                          'execution': 'NOT_RUN', 'existingOutputUntouched': True}))
        return 1
    try:
        orchestrate(runner, args)
    except Exception as error:
        runner.run('driver-error', ['internal:exception'], action=lambda: (_ for _ in ()).throw(error))
    finally:
        code = runner.finish()
    return code


if __name__ == '__main__':
    sys.exit(main())
