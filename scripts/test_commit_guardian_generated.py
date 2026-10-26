"""Run: python3 -m unittest scripts/test_commit_guardian_generated.py

The gate must know a brand from storage alone: no folder under profiles/.
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_commit_guardian as gate  # noqa: E402

PATCHED = ('ROOT', 'BRAND_DENYLIST_GENERATED', 'BRAND_DENYLIST', 'BRAND_DENYLIST_LOCAL', 'real_profile_dirs')


class GeneratedTermsTest(unittest.TestCase):
    def setUp(self):
        saved = {name: getattr(gate, name) for name in PATCHED}
        self.addCleanup(lambda: [setattr(gate, k, v) for k, v in saved.items()])
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / 'scripts').mkdir()
        gate.ROOT = root  # the whole tree is a temp dir: nothing of the real repo is read
        gate.BRAND_DENYLIST_GENERATED = root / 'scripts' / 'brand-denylist.generated.txt'
        gate.BRAND_DENYLIST = root / 'scripts' / 'brand-denylist.txt'
        gate.BRAND_DENYLIST_LOCAL = root / 'scripts' / 'brand-denylist.local.txt'
        gate.real_profile_dirs = lambda: []  # no folders on disk

    def test_terms_come_from_the_generated_file_without_folders(self):
        gate.BRAND_DENYLIST_GENERATED.write_text('# header\nfictionalco\nFictional Mark\n\n', encoding='utf-8')
        terms = gate.denylist_with_origins()
        self.assertIn('fictionalco', terms)
        self.assertIn('Fictional Mark', terms)

    def test_same_filters_as_folder_terms(self):
        gate.BRAND_DENYLIST_GENERATED.write_text('abc\nnorte\nfictionalco\n', encoding='utf-8')
        terms = gate.denylist_with_origins()
        self.assertNotIn('abc', terms, 'shorter than the minimum length')
        self.assertNotIn('norte', terms, 'generic word')

    def test_absent_file_contributes_nothing(self):
        self.assertEqual(gate.denylist_with_origins(), {})


if __name__ == '__main__':
    unittest.main()
