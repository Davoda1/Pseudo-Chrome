"""Source releases must not include local websites, credentials or test output."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('package_source_test', Path(__file__).parents[1] / 'package.py')
packaging = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packaging)


class SourceExportTests(unittest.TestCase):
    def test_local_private_files_are_excluded_and_examples_are_retained(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            source = base / 'project'
            source.mkdir()
            allowed = ['README.md', 'LICENSE', 'app/main.cjs', 'app/default-www/index.html',
                       'examples/site.json', '.env.example', 'examples/.env.example']
            private = ['.env', '.env.local', '.env.production', 'examples/.env',
                       'www/customer.html', 'site.json', 'settings.json', 'permissions.json',
                       'test-results/private.png', 'playwright-report/index.html',
                       'pseudo-build/profile/settings.json', '.git/config', 'node_modules/package/index.js']
            for name in allowed + private:
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture:' + name)
            previous = packaging.ROOT
            packaging.ROOT = source
            try:
                exported = packaging.source_copy(base / 'stage')
            finally:
                packaging.ROOT = previous
            self.assertEqual(sorted(str(p.relative_to(exported)) for p in exported.rglob('*') if p.is_file()), sorted(allowed))


if __name__ == '__main__':
    unittest.main()
