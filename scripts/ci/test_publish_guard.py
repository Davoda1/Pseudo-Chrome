"""Exercise tag integrity checks without contacting GitHub or publishing files."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publish-release.py'))
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class TagGuardTests(unittest.TestCase):
    def test_lightweight_tag_matches_tested_commit(self):
        with patch.object(publisher, 'gh_api', return_value={'object': {'type': 'commit', 'sha': 'a' * 40}}):
            publisher.verify_remote_tag('owner/project', 'v1.0.0', 'a' * 40)

    def test_annotated_tag_is_resolved(self):
        answers = [{'object': {'type': 'tag', 'sha': 'b' * 40}}, {'object': {'type': 'commit', 'sha': 'a' * 40}}]
        with patch.object(publisher, 'gh_api', side_effect=answers) as api:
            publisher.verify_remote_tag('owner/project', 'v1.0.0', 'a' * 40)
            self.assertEqual(api.call_count, 2)

    def test_reassigned_tag_is_rejected(self):
        with patch.object(publisher, 'gh_api', return_value={'object': {'type': 'commit', 'sha': 'b' * 40}}):
            with self.assertRaisesRegex(ValueError, 'no longer points to the tested commit'):
                publisher.verify_remote_tag('owner/project', 'v1.0.0', 'a' * 40)


if __name__ == '__main__':
    unittest.main()
