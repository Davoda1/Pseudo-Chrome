"""Regression checks for release integrity and extraction boundaries; no network."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('release_validation', Path(__file__).with_name('verify-release.py'))
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)


class ReleaseValidationTests(unittest.TestCase):
    def fixture(self, root):
        names = validation.release_names('1.0.0')
        lines = []
        for name in names[:-1]:
            data = name.encode()
            (root / name).write_bytes(data)
            lines.append(f'{hashlib.sha256(data).hexdigest()}  {name}')
        (root / names[-1]).write_text('\n'.join(lines) + '\n')
        return names

    def test_manifest_detects_tampered_and_extra_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            names = self.fixture(root)
            self.assertEqual(validation.verify_manifest(root, '1.0.0'), names)
            (root / names[0]).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
                validation.verify_manifest(root, '1.0.0')
            self.fixture(root)
            (root / 'unexpected.txt').write_text('not a release asset')
            with self.assertRaisesRegex(ValueError, 'exactly the eight'):
                validation.verify_manifest(root, '1.0.0')

    def test_manifest_rejects_duplicate_and_missing_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            manifest = root / 'SHA256SUM.txt'
            lines = manifest.read_text().splitlines()
            manifest.write_text('\n'.join(lines + [lines[0]]))
            with self.assertRaisesRegex(ValueError, 'Duplicate checksum'):
                validation.verify_manifest(root, '1.0.0')
            manifest.write_text('\n'.join(lines[:-1]))
            with self.assertRaisesRegex(ValueError, 'exactly the other seven'):
                validation.verify_manifest(root, '1.0.0')

    def test_zip_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bad.zip'
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('../outside', 'no')
            with self.assertRaisesRegex(ValueError, 'Unsafe archive member'):
                validation.zip_files(path)

    def test_tar_allows_internal_node_links_but_rejects_escape(self):
        def archive_bytes(target):
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w') as archive:
                item = tarfile.TarInfo('node/bin/npm')
                item.type = tarfile.SYMTYPE
                item.linkname = target
                archive.addfile(item)
            stream.seek(0)
            return stream
        validation.tar_files(stream=archive_bytes('../lib/node_modules/npm/bin/npm-cli.js'))
        with self.assertRaisesRegex(ValueError, 'Link escapes archive'):
            validation.tar_files(stream=archive_bytes('../../../outside'))
        with self.assertRaisesRegex(ValueError, 'Unsafe link'):
            validation.tar_files(stream=archive_bytes('/outside'))

    def test_unsafe_names_are_rejected(self):
        for name in ['/absolute', 'C:/absolute', r'..\outside', 'a/../../outside', '.git/config', 'cache/__pycache__/x.pyc']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                validation.safe_name(name)


if __name__ == '__main__':
    unittest.main()
