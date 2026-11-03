#!/usr/bin/env python3
"""Publish a fresh, fully validated tag release only after both platform CI jobs pass.

Uses the workflow's short-lived GITHUB_TOKEN through GitHub CLI. This script never
overwrites an existing release and never stores or prints authentication data.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('release_validation', Path(__file__).with_name('verify-release.py'))
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)


def gh_api(endpoint, method='GET', data=None):
    command = ['gh', 'api', endpoint, '--method', method]
    if data is not None:
        command += ['--input', '-']
    result = subprocess.run(command, input=json.dumps(data) if data is not None else None,
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        # Endpoint and status are useful; never echo subprocess environment/input.
        raise RuntimeError(f'GitHub API operation failed ({method} {endpoint}): {result.stderr.strip()}')
    return json.loads(result.stdout) if result.stdout.strip() else None


def verify_remote_tag(repository, tag, sha):
    reference = gh_api(f'repos/{repository}/git/ref/tags/{tag}')['object']
    # Handle both lightweight and annotated tags, failing closed on tag cycles.
    for _ in range(8):
        if reference['type'] == 'commit':
            validation.require(reference['sha'] == sha, 'Remote tag no longer points to the tested commit')
            return
        validation.require(reference['type'] == 'tag', 'Remote tag does not identify a commit')
        reference = gh_api(f"repos/{repository}/git/tags/{reference['sha']}")['object']
    raise ValueError('Remote tag nesting exceeds the supported limit')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--notes', required=True, type=Path)
    args = parser.parse_args()
    version = json.loads((ROOT / 'package.json').read_text())['version']
    tag = 'v' + version
    repository = os.environ.get('GITHUB_REPOSITORY', '')
    sha = os.environ.get('GITHUB_SHA', '')
    validation.require(os.environ.get('GITHUB_ACTIONS') == 'true', 'Publishing is restricted to GitHub Actions')
    validation.require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository), 'Invalid repository')
    validation.require(re.fullmatch(r'[0-9a-f]{40}', sha), 'Invalid workflow commit')
    validation.require(os.environ.get('GITHUB_REF') == 'refs/tags/' + tag, 'Tag does not match package version')
    validation.require(bool(os.environ.get('GH_TOKEN')), 'Missing short-lived workflow token')
    notes = args.notes.read_text(encoding='utf-8').strip()
    validation.require(bool(notes), 'Release notes cannot be empty')
    subprocess.run(['git', 'merge-base', '--is-ancestor', 'HEAD', 'origin/master'], cwd=ROOT, check=True)
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    tag_commit = subprocess.check_output(['git', 'rev-list', '-n', '1', tag], cwd=ROOT, text=True).strip()
    validation.require(head == sha == tag_commit, 'Checked-out commit does not match the workflow tag')
    names = validation.verify_release(args.directory, version)
    verify_remote_tag(repository, tag, sha)
    base = f'repos/{repository}/releases'
    # Listing includes drafts. Fail closed on authorization/network errors.
    page = 1
    while True:
        existing = gh_api(f'{base}?per_page=100&page={page}')
        validation.require(not any(item['tag_name'] == tag for item in existing), 'A release for this tag already exists; refusing to overwrite it')
        if len(existing) < 100:
            break
        page += 1
    release = None
    try:
        release = gh_api(base, 'POST', {'tag_name': tag, 'target_commitish': sha,
                         'name': f'Pseudo-Chrome {version}', 'body': notes,
                         'draft': True, 'prerelease': '-' in version})
        subprocess.run(['gh', 'release', 'upload', tag, '--repo', repository,
                        *[str(args.directory / name) for name in names]], check=True)
        assets = gh_api(f"{base}/{release['id']}/assets?per_page=100")
        validation.require(len(assets) == len(names) and {item['name'] for item in assets} == set(names), 'Uploaded assets do not match the eight deliverables')
        for asset in assets:
            file = args.directory / asset['name']
            validation.require(asset['size'] == file.stat().st_size and asset['state'] == 'uploaded', f"Incomplete asset: {asset['name']}")
            validation.require(asset.get('digest') == 'sha256:' + validation.digest(file), f"Uploaded asset digest mismatch: {asset['name']}")
        verify_remote_tag(repository, tag, sha)
        gh_api(f"{base}/{release['id']}", 'PATCH', {'draft': False, 'make_latest': 'false' if '-' in version else 'true'})
        print(f'Published {tag} with all eight verified deliverables.')
    except BaseException:
        if release is not None:
            try:
                current = gh_api(f"{base}/{release['id']}")
                if current.get('draft'):
                    gh_api(f"{base}/{release['id']}", 'DELETE')
            except Exception:
                print('The draft created by this run could not be cleaned up; inspect it before retrying.', file=sys.stderr)
        raise


if __name__ == '__main__':
    main()
