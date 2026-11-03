#!/usr/bin/env python3
"""Validate the eight distributables, their manifests, licenses and native entries."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tarfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def release_names(version):
    require(bool(re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', version)), 'Invalid package version')
    prefix = f'Pseudo-Chrome-{version}'
    return [f'{prefix}-Windows-x64-portable.zip', f'{prefix}-Linux-x64.tar.gz',
            f'pseudo-chrome_{version}_amd64.deb', f'{prefix}-Source.zip',
            f'{prefix}-Source.tar.gz', f'{prefix}-Preview.html', f'{prefix}-README.txt', 'SHA256SUM.txt']


def verify_manifest(directory, version):
    names = release_names(version)
    require(set(p.name for p in directory.iterdir()) == set(names), 'Release directory must contain exactly the eight deliverables')
    entries = {}
    for line in (directory / 'SHA256SUM.txt').read_text(encoding='utf-8').splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  (.+)', line)
        require(match is not None, 'Malformed checksum manifest')
        checksum, name = match.groups()
        require(name not in entries, 'Duplicate checksum filename')
        entries[name] = checksum
    require(set(entries) == set(names[:-1]), 'Checksum manifest must name exactly the other seven deliverables')
    for name, checksum in entries.items():
        require((directory / name).is_file() and not (directory / name).is_symlink(), f'Not a regular release file: {name}')
        require(digest(directory / name) == checksum, f'Checksum mismatch: {name}')
    return names


def safe_name(name):
    normalized = name.removeprefix('./').rstrip('/')
    parts = PurePosixPath(normalized).parts
    require(normalized and not normalized.startswith('/') and '\\' not in name and ':' not in name and '..' not in parts, f'Unsafe archive member: {name}')
    require('.git' not in parts and '__pycache__' not in parts and not normalized.endswith(('.pyc', '.part')), f'Unexpected temporary/private archive member: {name}')
    return normalized


def zip_files(path):
    result = {}
    with zipfile.ZipFile(path) as archive:
        require(archive.testzip() is None, f'ZIP CRC failure: {path.name}')
        for item in archive.infolist():
            name = safe_name(item.filename)
            require(not stat.S_ISLNK(item.external_attr >> 16), f'Unexpected ZIP symlink: {name}')
            if not item.is_dir():
                require(name not in result, f'Duplicate archive member: {name}')
                result[name] = archive.read(item)
    return result


def tar_files(path=None, stream=None):
    result, modes = {}, {}
    with tarfile.open(path, mode='r:*', fileobj=stream) as archive:
        for item in archive:
            # Debian's root entry is harmless and has no payload.
            if item.name in ('.', './') and item.isdir():
                continue
            name = safe_name(item.name)
            if item.issym() or item.islnk():
                require(not PurePosixPath(item.linkname).is_absolute() and '\\' not in item.linkname and ':' not in item.linkname, f'Unsafe link: {name}')
                target = list(PurePosixPath(name).parent.parts) if item.issym() else []
                for part in PurePosixPath(item.linkname).parts:
                    if part == '..':
                        require(bool(target), f'Link escapes archive: {name}')
                        target.pop()
                    elif part != '.':
                        target.append(part)
            require(item.isfile() or item.isdir() or item.issym() or item.islnk(), f'Unsupported archive member: {name}')
            if item.isfile():
                require(name not in result, f'Duplicate archive member: {name}')
                result[name] = archive.extractfile(item).read()
                modes[name] = item.mode
    return result, modes


def verify_app(files, version, executable, magic):
    require(files.get(executable, b'').startswith(magic), f'{executable} must be a real native executable')
    package = json.loads(files['resources/app/package.json'])
    require(package['version'] == version and package.get('license') == 'AGPL-3.0-only', 'Packaged version/license mismatch')
    for name in ['LICENSE-PSEUDO-CHROME', 'resources/app/LICENSE', 'THIRD-PARTY-NOTICES.md', 'LICENSE', 'LICENSES.chromium.html']:
        require(bool(files.get(name)), f'Missing license notice: {name}')
    require(b'GNU AFFERO GENERAL PUBLIC LICENSE' in files['resources/app/LICENSE'], 'Missing AGPL application license')
    mapping = json.loads(files['resources/runtimes/paths.json'])
    require(set(mapping) >= {'node', 'npmCli', 'nginx', 'php'}, 'Missing runtime mapping')
    for key, relative in mapping.items():
        name = 'resources/runtimes/' + safe_name(relative)
        require(bool(files.get(name)), f'Missing bundled {key}')
    require(bool(json.loads(files['resources/runtimes/runtime-manifest.json'])), 'Missing runtime provenance')
    for component in ('nginx', 'php'):
        require(any(name.startswith(f'resources/runtimes/{component}/') and ('license' in name.lower() or 'notice' in name.lower()) for name in files), f'Missing {component} notices')
    return files['resources/app/LICENSE']


def verify_release(directory, version, skip_deb=False):
    names = verify_manifest(directory, version)
    windows = zip_files(directory / names[0])
    app_license = verify_app(windows, version, 'Pseudo-Chrome.exe', b'MZ')
    require(windows.get('resources/runtimes/process-runner.exe', b'').startswith(b'MZ'), 'Missing Windows process supervisor')
    linux, modes = tar_files(directory / names[1])
    require(verify_app(linux, version, 'pseudo-chrome', b'\x7fELF') == app_license, 'Application licenses differ')
    require(modes['pseudo-chrome'] & 0o111, 'Linux entry is not executable')
    source_zip = zip_files(directory / names[3])
    source_tar, _ = tar_files(directory / names[4])
    require(source_zip == source_tar, 'Source ZIP and TAR contents differ')
    prefix = f'Pseudo-Chrome-{version}/'
    require(all(name.startswith(prefix) for name in source_zip), 'Source archive prefix mismatch')
    for name in ['LICENSE', 'README.md', 'RELEASE_NOTES.md', 'SECURITY.md', 'package.json', 'package-lock.json', '.github/workflows/validate.yml', 'scripts/ci/run-tests.cjs']:
        require(bool(source_zip.get(prefix + name)), f'Missing source file: {name}')
    require(source_zip[prefix + 'LICENSE'] == app_license, 'Source and application licenses differ')
    for name, content in source_zip.items():
        relative = name.removeprefix(prefix)
        require('node_modules' not in PurePosixPath(relative).parts, 'Source archive contains dependencies')
        if relative.startswith('app/'):
            require(linux.get('resources/app/' + relative) == content, f'Linux source mismatch: {relative}')
            require(windows.get('resources/app/' + relative) == content, f'Windows source mismatch: {relative}')
    if not skip_deb:
        result = subprocess.run(['dpkg-deb', '--fsys-tarfile', str(directory / names[2])], check=True, stdout=subprocess.PIPE)
        deb, deb_modes = tar_files(stream=io.BytesIO(result.stdout))
        require(deb.get('usr/bin/pseudo-chrome', b'').startswith(b'\x7fELF'), 'Debian entry must be an actual ELF, not a symlink or script')
        require(deb_modes['usr/bin/pseudo-chrome'] & 0o111, 'Debian entry is not executable')
        require(deb.get('usr/lib/pseudo-chrome/pseudo-chrome-runtime', b'').startswith(b'\x7fELF'), 'Missing Debian Electron engine')
        require(b'GNU AFFERO GENERAL PUBLIC LICENSE' in deb.get('usr/share/doc/pseudo-chrome/copyright', b''), 'Missing Debian application license')
        deb_version = subprocess.check_output(['dpkg-deb', '-f', str(directory / names[2]), 'Version'], text=True).strip()
        require(deb_version == version, 'Debian version mismatch')
    require(b'<html' in (directory / names[5]).read_bytes().lower(), 'Missing standalone HTML preview')
    require((directory / names[6]).stat().st_size > 100, 'Missing release README')
    return names


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--version', default=json.loads((ROOT / 'package.json').read_text())['version'])
    parser.add_argument('--skip-deb', action='store_true', help='Windows verifies the DEB checksum; Linux additionally inspects its contents')
    parser.add_argument('--manifest-only', action='store_true')
    parser.add_argument('--extract', choices=['linux', 'windows'])
    parser.add_argument('--destination', type=Path)
    args = parser.parse_args()
    names = verify_manifest(args.directory, args.version) if args.manifest_only else verify_release(args.directory, args.version, args.skip_deb)
    if args.extract:
        require(not args.manifest_only, 'Extraction requires full archive validation')
        require(args.destination is not None and not args.destination.exists(), 'Extraction destination must not exist')
        args.destination.mkdir(parents=True)
        if args.extract == 'linux':
            with tarfile.open(args.directory / names[1]) as archive:
                archive.extractall(args.destination, filter='data')
        else:
            with zipfile.ZipFile(args.directory / names[0]) as archive:
                archive.extractall(args.destination)
    print(f'Validated {len(names)} release files for {args.version}.')


if __name__ == '__main__':
    main()
