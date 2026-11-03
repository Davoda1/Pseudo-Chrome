#!/usr/bin/env python3
"""Fetch/build the pinned PHP-CGI runtimes used by Pseudo-Chrome.

Windows: official PHP NTS ZIP and Microsoft app-local runtime DLLs.
Linux: PHP-CGI with common extensions, its shared-library closure, and a small
static musl bootstrap invoking the bundled loader. No shell launcher is shipped.

Linux build prerequisites (Ubuntu 24.04): gcc g++ make pkg-config musl-tools
libxml2-dev libsqlite3-dev libssl-dev libcurl4-openssl-dev libonig-dev libzip-dev
zlib1g-dev libpng-dev libjpeg-dev libwebp-dev libfreetype-dev libicu-dev
libsodium-dev libxslt1-dev libbz2-dev libgmp-dev libpq-dev bison re2c.
Windows extraction additionally requires cabextract on the Linux build host.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tarfile
import urllib.request
import zipfile

PHP_VERSION = '8.5.12'
PHP_WINDOWS_VERSION = '8.5.12-1'
SOURCE_URL = 'https://www.php.net/distributions/php-8.5.12.tar.xz'
SOURCE_SHA = '08bc2eba2a588654ade1357174aa646b761556c862dda0678345ee29ed481209'
WINDOWS_URL = 'https://windows.php.net/downloads/releases/php-8.5.12-1-nts-Win32-vs17-x64.zip'
WINDOWS_SHA = '2a36a2edcb7a5b9252f638fd5e4cf84d7f6e066092654220dc0b63e5cf4e9723'
CRT_URL = 'https://download.visualstudio.microsoft.com/download/pr/ebdab8e5-1d7b-4d9f-a11b-cbb1720c3b12/843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C/VC_redist.x64.exe'
CRT_SHA = '843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c'
CA_URL = 'https://curl.se/ca/cacert-2026-10-20.pem'
CA_SHA = '796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe'
CONFIGURE = [
    './configure', '--prefix=/opt/pseudo-chrome-php',
    '--with-config-file-path=/nonexistent', '--with-config-file-scan-dir=/nonexistent',
    '--disable-cli', '--disable-phpdbg', '--enable-cgi', '--disable-opcache',
    '--with-openssl', '--with-zlib', '--with-bz2', '--with-curl', '--with-gmp',
    '--with-sodium', '--with-zip', '--with-xsl', '--enable-bcmath',
    '--enable-calendar', '--enable-exif', '--enable-ftp', '--enable-intl',
    '--enable-mbstring', '--enable-soap', '--enable-sockets', '--enable-pcntl',
    '--with-mysqli=mysqlnd', '--with-pdo-mysql=mysqlnd', '--with-pgsql',
    '--with-pdo-pgsql', '--with-pdo-sqlite', '--with-sqlite3', '--enable-gd',
    '--with-jpeg', '--with-webp', '--with-freetype',
]
INI = '''; Pseudo-Chrome local demonstration PHP runtime
; The application passes absolute CA, extension and temporary-directory paths.
[PHP]
engine = On
short_open_tag = Off
precision = 14
output_buffering = 4096
expose_php = Off
max_execution_time = 120
max_input_time = 120
memory_limit = 256M
error_reporting = E_ALL
display_errors = On
display_startup_errors = On
log_errors = On
html_errors = On
variables_order = "GPCS"
request_order = "GP"
post_max_size = 64M
upload_max_filesize = 64M
max_file_uploads = 20
allow_url_fopen = On
allow_url_include = Off
default_charset = "UTF-8"
cgi.fix_pathinfo = 0
cgi.force_redirect = 0
date.timezone = UTC
session.use_strict_mode = 1
session.use_only_cookies = 1
session.cookie_httponly = 1
session.cookie_samesite = Lax
curl.cainfo = "${PSEUDO_PHP_CA}"
openssl.cafile = "${PSEUDO_PHP_CA}"
'''
WINDOWS_EXTENSIONS = ['bz2', 'curl', 'exif', 'fileinfo', 'gd', 'gmp', 'intl', 'mbstring',
                      'mysqli', 'openssl', 'pdo_mysql', 'pdo_pgsql', 'pdo_sqlite',
                      'pgsql', 'soap', 'sockets', 'sodium', 'sqlite3', 'xsl', 'zip']
CRT_NAMES = {'vcruntime140.dll', 'vcruntime140_1.dll', 'vcruntime140_threads.dll',
             'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll',
             'msvcp140_atomic_wait.dll', 'msvcp140_codecvt_ids.dll', 'concrt140.dll'}

def download(url: str, sha: str, cache: Path, name: str | None = None) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / (name or url.rsplit('/', 1)[1])
    if not destination.exists():
        urllib.request.urlretrieve(url, destination)
    actual = hashlib.sha256(destination.read_bytes()).hexdigest()
    if actual != sha:
        raise RuntimeError(f'SHA256 mismatch: {destination.name}: {actual}')
    return destination

def run(args: list[str], **kwargs):
    subprocess.run(args, check=True, **kwargs)

def finish(out: Path, cache: Path, windows: bool):
    shutil.copy2(download(CA_URL, CA_SHA, cache), out / 'cacert.pem')
    text = INI
    if windows:
        text += '\n; extension_dir is supplied by Pseudo-Chrome.\n'
        for name in WINDOWS_EXTENSIONS:
            if not (out / 'ext' / f'php_{name}.dll').is_file():
                raise RuntimeError(f'Missing PHP extension: {name}')
            text += f'extension={name}\n'
    (out / 'php.ini').write_text(text)

def windows_runtime(out: Path, cache: Path):
    out.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(download(WINDOWS_URL, WINDOWS_SHA, cache)) as archive:
        archive.extractall(out)
    data = download(CRT_URL, CRT_SHA, cache, 'vc_redist.x64.exe').read_bytes()
    extract = cache / 'vc-redist-extracted'
    extract.mkdir(exist_ok=True)
    offset = 0
    containers = []
    while True:
        offset = data.find(b'MSCF', offset)
        if offset < 0:
            break
        length = struct.unpack_from('<I', data, offset + 8)[0]
        if 36 < length <= len(data) - offset:
            cab = extract / f'container-{offset}.cab'
            cab.write_bytes(data[offset:offset + length])
            folder = extract / cab.stem
            folder.mkdir(exist_ok=True)
            run(['cabextract', '-q', '-d', str(folder), str(cab)])
            containers.append(folder)
        offset += 4
    for folder in containers:
        for candidate in list(folder.iterdir()):
            if candidate.is_file() and candidate.read_bytes()[:4] == b'MSCF':
                payload = extract / ('payload-' + folder.name + '-' + candidate.name)
                payload.mkdir(exist_ok=True)
                run(['cabextract', '-q', '-d', str(payload), str(candidate)])
                for dll in payload.glob('*.dll_amd64'):
                    name = dll.name.removesuffix('_amd64')
                    if name.lower() in CRT_NAMES:
                        shutil.copy2(dll, out / name)
    for required in ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']:
        if not (out / required).is_file():
            raise RuntimeError(f'Missing Microsoft runtime: {required}')
    # These developer/CLI utilities are unnecessary for FastCGI hosting.
    for name in ['phpdbg.exe', 'php8phpdbg.dll', 'php8embed.lib', 'deplister.exe',
                 'phar.phar.bat', 'pharcommand.phar']:
        (out / name).unlink(missing_ok=True)
    for candidate in out.glob('*.dll'):
        lower = candidate.name.lower()
        if lower.startswith(('mfc140', 'mfcm140', 'vcamp140', 'vccorlib140', 'vcomp140')):
            candidate.unlink()
    for candidate in (out / 'ext').glob('php_*.dll'):
        if candidate.stem.removeprefix('php_') not in WINDOWS_EXTENSIONS:
            candidate.unlink()
    finish(out, cache, True)
    manifest = {'name': 'PHP', 'version': PHP_WINDOWS_VERSION, 'platform': 'win32-x64',
                'url': WINDOWS_URL, 'sha256': WINDOWS_SHA,
                'verified_against': 'https://windows.php.net/downloads/releases/releases.json',
                'microsoft_runtime': {'version': '14.51.36247', 'url': CRT_URL, 'sha256': CRT_SHA},
                'ca_bundle': {'url': CA_URL, 'sha256': CA_SHA}}
    (out / 'runtime-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (out / 'MICROSOFT-RUNTIME-NOTICE.txt').write_text(
        'Microsoft Visual C++ Redistributable app-local x64 runtime components\n'
        'Copyright Microsoft Corporation. All rights reserved.\n'
        'Source: ' + CRT_URL + '\nSHA256: ' + CRT_SHA + '\n'
        'License terms: https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/\n')

def linux_runtime(out: Path, cache: Path, work: Path, jobs: int):
    out.mkdir(parents=True, exist_ok=True)
    source = download(SOURCE_URL, SOURCE_SHA, cache)
    work.mkdir(parents=True, exist_ok=True)
    tree = work / f'php-{PHP_VERSION}'
    if not tree.is_dir():
        with tarfile.open(source) as archive:
            archive.extractall(work, filter='data')
    env = os.environ.copy()
    env.update(CFLAGS='-O2 -g0', CXXFLAGS='-O2 -g0')
    if not (tree / 'Makefile').is_file():
        run(CONFIGURE, cwd=tree, env=env)
    run(['make', f'-j{max(1, min(jobs, 4))}'], cwd=tree, env=env)
    shutil.copy2(tree / 'sapi/cgi/php-cgi', out / 'php-cgi.real')
    run(['strip', str(out / 'php-cgi.real')])
    libs = out / 'lib'
    libs.mkdir(exist_ok=True)
    dependency_text = subprocess.check_output(['ldd', str(out / 'php-cgi.real')], text=True)
    paths = set(re.findall(r'=>\s+(/\S+)', dependency_text))
    paths.update(re.findall(r'^\s*(/\S+)', dependency_text, flags=re.MULTILINE))
    if 'not found' in dependency_text:
        raise RuntimeError(dependency_text)
    notices = out / 'licenses'
    notices.mkdir(exist_ok=True)
    dependency_manifest = []
    packages = set()
    for value in sorted(paths):
        path = Path(value)
        target = libs / path.name
        shutil.copy2(path.resolve(), target)
        dependency_manifest.append({'file': target.name,
                                    'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
        lookup = subprocess.run(['dpkg-query', '-S', str(path.resolve())], capture_output=True, text=True)
        if lookup.returncode:
            lookup = subprocess.run(['dpkg-query', '-S', str(path)], capture_output=True, text=True)
        if lookup.returncode == 0:
            package = lookup.stdout.split(': /', 1)[0]
            packages.add(package)
    for package in sorted(packages):
        name = package.split(':', 1)[0]
        copyright_file = Path('/usr/share/doc') / name / 'copyright'
        if copyright_file.exists():
            shutil.copy2(copyright_file, notices / (name + '-copyright.txt'))
    musl_copyright = Path('/usr/share/doc/musl/copyright')
    if musl_copyright.exists():
        shutil.copy2(musl_copyright, notices / 'musl-copyright.txt')
    common = notices / 'common'
    common.mkdir(exist_ok=True)
    for name in ['GPL-2', 'GPL-3', 'LGPL-2', 'LGPL-2.1', 'LGPL-3', 'Apache-2.0', 'BSD', 'Artistic']:
        license_file = Path('/usr/share/common-licenses') / name
        if license_file.exists():
            shutil.copy2(license_file, common / name)
    source_packages = []
    for package in sorted(packages):
        info = subprocess.check_output(
            ['dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n', package], text=True).strip().split('\t')
        source_packages.append({'binary_package': info[0], 'binary_version': info[1],
                                'source_package': info[2], 'source_version': info[3],
                                'source_archive': 'https://launchpad.net/ubuntu/+source/' + info[2] + '/' + info[3]})
    run(['musl-gcc', '-Os', '-static', '-s', str(Path(__file__).with_name('php-runtime-bootstrap.c')),
         '-o', str(out / 'php-cgi')])
    shutil.copy2(tree / 'LICENSE', out / 'LICENSE')
    finish(out, cache, False)
    manifest = {'name': 'PHP', 'version': PHP_VERSION, 'platform': 'linux-x64',
                'url': SOURCE_URL, 'sha256': SOURCE_SHA,
                'verified_against': 'https://www.php.net/releases/index.php?json',
                'bootstrap': 'Static musl ELF; bundled glibc loader and dependency closure',
                'configuration': CONFIGURE, 'libraries': dependency_manifest,
                'source_packages': source_packages, 'ca_bundle': {'url': CA_URL, 'sha256': CA_SHA}}
    (out / 'runtime-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=['win', 'linux', 'all'], default='all')
    parser.add_argument('--output', type=Path, required=True, help='Runtime platform root: contains win/php and linux/php')
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--work', type=Path, required=True)
    parser.add_argument('--jobs', type=int, default=4)
    options = parser.parse_args()
    if options.platform in ['win', 'all']:
        windows_runtime(options.output / 'win/php', options.cache)
    if options.platform in ['linux', 'all']:
        linux_runtime(options.output / 'linux/php', options.cache, options.work, options.jobs)

if __name__ == '__main__':
    main()
