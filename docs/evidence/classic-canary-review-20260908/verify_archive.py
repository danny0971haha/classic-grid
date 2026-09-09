#!/usr/bin/env python3
"""Verify or restore this historical packet without rewriting its evidence."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile

PREFIX = 'docs/evidence/classic-canary-review-20260908/'
SOURCE_COMMIT = '40223bb5e106668e2d5a2c8971579b41e7a9dbfa'
PACKAGE_FILES = {'original-evidence.tar.gz', 'archive-manifest.json', 'README.md', 'verify_archive.py'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def safe_path(name):
    path = PurePosixPath(name)
    require(isinstance(name, str) and name.startswith(PREFIX)
            and not path.is_absolute() and '..' not in path.parts
            and '\\' not in name and str(path) == name
            and name != PREFIX.rstrip('/'), 'UNSAFE_ARCHIVE_PATH')
    return path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify_package(directory):
    listed = set()
    for line in (directory / 'SHA256SUMS').read_text().splitlines():
        expected, name = line.split('  ', 1)
        require(name in PACKAGE_FILES and name not in listed, 'INVALID_PACKAGE_CHECKSUM_INVENTORY')
        listed.add(name)
        file = directory / name
        require(file.is_file() and not file.is_symlink(), 'INVALID_PACKAGE_FILE')
        require(digest(file.read_bytes()) == expected, 'PACKAGE_CHECKSUM_MISMATCH:' + name)
    require(listed == PACKAGE_FILES, 'INCOMPLETE_PACKAGE_CHECKSUM_INVENTORY')


def verify_archive(archive, manifest, git_source=None):
    require(manifest['schemaVersion'] == 1 and manifest['sourceCommit'] == SOURCE_COMMIT
            and manifest['pathPrefix'] == PREFIX and manifest['archive'] == 'original-evidence.tar.gz',
            'MANIFEST_IDENTITY_MISMATCH')
    expected = {}
    for item in manifest['files']:
        name = item['path']
        safe_path(name)
        require(name not in expected, 'DUPLICATE_MANIFEST_PATH')
        require(item['mode'] == '100644', 'INVALID_MANIFEST_MODE')
        expected[name] = item
    require(len(expected) == 47, 'ORIGINAL_INVENTORY_COUNT_MISMATCH')
    restored = {}
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar.getmembers():
            name = member.name
            safe_path(name)
            require(name not in restored, 'DUPLICATE_ARCHIVE_PATH')
            require(member.isfile() and not member.linkname, 'UNSAFE_ARCHIVE_MEMBER_TYPE')
            require(name in expected, 'UNEXPECTED_ARCHIVE_PATH')
            item = expected[name]
            require(member.mode == 0o644 and member.size == item['size'], 'ARCHIVE_MODE_OR_SIZE_MISMATCH')
            data = tar.extractfile(member).read()
            require(len(data) == item['size'] and digest(data) == item['sha256'], 'ARCHIVE_CONTENT_MISMATCH')
            blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            require(blob == item['gitBlob'], 'GIT_BLOB_MISMATCH')
            restored[name] = data
    require(set(restored) == set(expected), 'ARCHIVE_MEMBERSHIP_MISMATCH')
    old_manifest = restored[PREFIX + 'SHA256SUMS'].decode().splitlines()
    old_names = set()
    for line in old_manifest:
        sha, relative = line.split('  ', 1)
        name = PREFIX + relative
        safe_path(name)
        require(name in restored and name not in old_names, 'INVALID_ORIGINAL_MANIFEST')
        require(digest(restored[name]) == sha, 'ORIGINAL_MANIFEST_HASH_MISMATCH')
        old_names.add(name)
    require(len(old_names) == 45, 'ORIGINAL_MANIFEST_COUNT_MISMATCH')
    require(set(restored) - old_names == {PREFIX + 'SHA256SUMS', PREFIX + 'identity-after-packet.txt'},
            'ORIGINAL_MANIFEST_COVERAGE_MISMATCH')
    if git_source is not None:
        command = ['git', '-C', str(git_source)]
        tree = subprocess.check_output(command + ['rev-parse', SOURCE_COMMIT + '^{tree}'], text=True).strip()
        require(tree == manifest['sourceTree'], 'SOURCE_TREE_MISMATCH')
        rows = subprocess.check_output(command + ['ls-tree', '-rz', SOURCE_COMMIT, '--', PREFIX]).split(b'\0')
        source_names = set()
        for row in filter(None, rows):
            identity, name = row.decode().split('\t')
            mode, kind, blob = identity.split()
            source_names.add(name)
            require(name in expected and mode == expected[name]['mode'] and kind == 'blob'
                    and blob == expected[name]['gitBlob'], 'SOURCE_GIT_INVENTORY_MISMATCH')
            data = subprocess.check_output(command + ['cat-file', 'blob', blob])
            require(data == restored[name], 'SOURCE_BYTES_MISMATCH')
        require(source_names == set(restored), 'SOURCE_GIT_MEMBERSHIP_MISMATCH')
    return restored


def restore_files(files, destination):
    # A fresh destination prevents overwriting any existing evidence or traversing
    # user-controlled symlinks inside an existing restore tree.
    require(not destination.exists() and not destination.is_symlink(), 'RESTORE_DESTINATION_MUST_NOT_EXIST')
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination = destination.parent.resolve() / destination.name
    destination.mkdir(mode=0o755)
    for name, data in files.items():
        target = destination.joinpath(*safe_path(name).parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as stream:
            stream.write(data)
        target.chmod(0o644)
        require(target.read_bytes() == data and target.stat().st_mode & 0o777 == 0o644,
                'RESTORE_VERIFICATION_FAILED')
    actual = {p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file()}
    require(actual == set(files), 'RESTORE_MEMBERSHIP_MISMATCH')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['verify', 'restore'])
    parser.add_argument('--git-source', type=Path, help='Optional repository containing the original fixed commit')
    parser.add_argument('--destination', type=Path, help='Fresh output root; required for restore')
    args = parser.parse_args()
    require((args.operation == 'restore') == (args.destination is not None), 'RESTORE_DESTINATION_ARGUMENT_REQUIRED')
    directory = Path(__file__).resolve().parent
    verify_package(directory)
    manifest = json.loads((directory / 'archive-manifest.json').read_text())
    files = verify_archive(directory / manifest['archive'], manifest, args.git_source)
    if args.operation == 'restore':
        restore_files(files, args.destination)
    print(json.dumps({'operation': args.operation, 'sourceCommit': SOURCE_COMMIT,
                      'filesVerified': len(files), 'originalManifestEntriesVerified': 45,
                      'bytesVerified': sum(map(len, files.values())),
                      'gitSourceCompared': args.git_source is not None,
                      'destination': str(args.destination) if args.destination else None}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, tarfile.TarError, subprocess.CalledProcessError) as error:
        print('EVIDENCE_PACKAGE_REJECTED: ' + str(error), file=sys.stderr)
        sys.exit(1)
