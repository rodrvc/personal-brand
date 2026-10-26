"""Run: python3 -m unittest scripts/test_commit_guardian_generated.py

The gate must know a brand from storage alone: no folder under profiles/.
"""
import contextlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_commit_guardian as gate  # noqa: E402

PATCHED = ('ROOT', 'BRAND_DENYLIST_GENERATED', 'BRAND_DENYLIST', 'BRAND_DENYLIST_LOCAL', 'real_profile_dirs')


class GateCase(unittest.TestCase):
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


class GeneratedTermsTest(GateCase):

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


class StorageWarningsTest(GateCase):
    """The commit path warns when the generated file lags behind storage."""

    def setUp(self):
        super().setUp()
        saved = gate.fetch_storage_terms
        self.addCleanup(lambda: setattr(gate, 'fetch_storage_terms', saved))

    def storage_has(self, terms):
        gate.fetch_storage_terms = lambda: terms

    def test_absent_file_with_real_brands_warns(self):
        self.storage_has(['fictionalco'])
        warnings = gate.storage_denylist_warnings()
        self.assertEqual(len(warnings), 1)
        self.assertIn('absent', warnings[0])

    def test_stale_file_warns(self):
        gate.BRAND_DENYLIST_GENERATED.write_text('fictionalco\n', encoding='utf-8')
        self.storage_has(['fictionalco', 'Newer Mark'])
        self.assertIn('stale', gate.storage_denylist_warnings()[0])

    def test_current_file_is_quiet(self):
        gate.BRAND_DENYLIST_GENERATED.write_text('# h\nfictionalco\n', encoding='utf-8')
        self.storage_has(['fictionalco'])
        self.assertEqual(gate.storage_denylist_warnings(), [])

    def test_no_real_brands_in_storage_is_quiet(self):
        self.storage_has([])  # only example brands: nothing to watch, so nothing to warn about
        self.assertEqual(gate.storage_denylist_warnings(), [])

    def test_unreachable_storage_never_warns_or_blocks(self):
        self.storage_has(None)
        self.assertEqual(gate.storage_denylist_warnings(), [])

    def test_without_database_url_storage_is_not_asked(self):
        saved = dict(os.environ)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(saved)))
        os.environ.pop('DATABASE_URL', None)
        self.assertIsNone(gate.fetch_storage_terms())


class FakeProc:
    def __init__(self, stdout='', returncode=0, hang=False):
        self.stdout, self.returncode, self.hang, self.pid, self.calls = stdout, returncode, hang, 4242, 0

    def communicate(self, timeout=None):
        self.calls += 1
        if self.hang and self.calls == 1:
            raise subprocess.TimeoutExpired('pnpm', timeout)
        return self.stdout, None

    def kill(self):
        pass


class FetchStorageTermsTest(GateCase):
    """fetch_storage_terms degrades to None (unknown) on every failure and never raises."""

    def setUp(self):
        super().setUp()
        saved = (gate.subprocess.Popen, gate.os.killpg, dict(os.environ))
        self.addCleanup(lambda: (setattr(gate.subprocess, 'Popen', saved[0]), setattr(gate.os, 'killpg', saved[1]), os.environ.clear(), os.environ.update(saved[2])))
        os.environ['DATABASE_URL'] = 'postgres://fictional.test/db'
        self.killed = []
        gate.os.killpg = lambda pid, sig: self.killed.append(pid)

    def fetch(self, proc):
        gate.subprocess.Popen = lambda *a, **k: proc
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            return gate.fetch_storage_terms(), err.getvalue()

    def test_terms_after_junk_before_json(self):
        terms, _ = self.fetch(FakeProc('> noise line\n{"trust": "brand-data", "terms": ["a-term", 3]}'))
        self.assertEqual(terms, ['a-term'])

    def test_non_zero_exit_is_unknown(self):
        self.assertIsNone(self.fetch(FakeProc('{"terms": ["x"]}', returncode=1))[0])

    def test_non_list_terms_is_unknown(self):
        self.assertIsNone(self.fetch(FakeProc('{"terms": "nope"}'))[0])

    def test_junk_without_json_is_unknown(self):
        self.assertIsNone(self.fetch(FakeProc('no json here'))[0])

    def test_timeout_kills_the_process_group_and_says_so(self):
        terms, err = self.fetch(FakeProc(hang=True))
        self.assertIsNone(terms)
        self.assertEqual(self.killed, [4242])
        self.assertIn('did not answer', err)

    def test_launch_failure_is_unknown(self):
        def boom(*a, **k):
            raise OSError('no pnpm')
        gate.subprocess.Popen = boom
        self.assertIsNone(gate.fetch_storage_terms())


class HandleLookbehindTest(GateCase):
    def test_glued_at_sign_is_not_a_handle(self):
        profile = gate.ROOT / 'profiles' / 'fictional-co'
        profile.mkdir(parents=True)
        (profile / 'notes.md').write_text('install pkg@zzversion or mail person@hostzz.test; follow @real_handle', encoding='utf-8')
        gate.real_profile_dirs = lambda: [profile]
        terms = gate.derive_terms()
        self.assertIn('real_handle', terms)
        self.assertNotIn('zzversion', terms)
        self.assertNotIn('hostzz', terms)


if __name__ == '__main__':
    unittest.main()
