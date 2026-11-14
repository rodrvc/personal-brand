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
        gate._storage_answer = gate._UNASKED  # the per-process query memo starts empty in every test


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
    def __init__(self, stdout='', returncode=0, hang=False, stuck=False):
        self.stdout, self.returncode, self.hang, self.stuck, self.pid, self.calls = stdout, returncode, hang, stuck, 4242, 0
        self.killed = 0

    def communicate(self, timeout=None):
        self.calls += 1
        if (self.hang and self.calls == 1) or self.stuck:  # `stuck`: a descendant outside the group still holds the pipe
            raise subprocess.TimeoutExpired('pnpm', timeout)
        return self.stdout, None

    def kill(self):
        self.killed += 1


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

    def test_undecodable_output_never_raises(self):
        terms, _ = self.fetch(FakeProc(b'{"terms": ["caf\xc3\xa9-co", "bad\xff"]}'))
        self.assertEqual(terms, ['café-co', 'bad\ufffd'])

    def test_fast_failure_says_so_once_on_stderr(self):
        terms, err = self.fetch(FakeProc('', returncode=1))
        self.assertIsNone(terms)
        self.assertEqual(len(err.strip().splitlines()), 1)
        self.assertIn('exit 1', err)

    def test_reap_after_the_kill_is_bounded(self):
        proc = FakeProc(stuck=True)
        terms, err = self.fetch(proc)  # the second communicate() times out too: still returns
        self.assertIsNone(terms)
        self.assertEqual(self.killed, [4242])
        self.assertIn('did not answer', err)

    def test_group_kill_failure_falls_back_to_the_parent_and_stays_bounded(self):
        def refuse(pid, sig):
            raise ProcessLookupError()
        gate.os.killpg = refuse
        proc = FakeProc(hang=True, stuck=True)
        self.assertIsNone(self.fetch(proc)[0])
        self.assertEqual(proc.killed, 1)

    def test_launch_failure_is_unknown_and_says_so(self):
        def boom(*a, **k):
            raise OSError('no pnpm')
        gate.subprocess.Popen = boom
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertIsNone(gate.fetch_storage_terms())
        self.assertEqual(len(err.getvalue().strip().splitlines()), 1)

    def test_every_degraded_answer_says_so_once(self):
        for stdout in ('no json here', '{"terms": "nope"}', '{"terms": '):
            terms, err = self.fetch(FakeProc(stdout))
            self.assertIsNone(terms, stdout)
            self.assertEqual(len(err.strip().splitlines()), 1, stdout)

    def test_the_note_never_raises_and_names_the_live_terms(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            gate._note('x')
        self.assertIn('live storage terms were not checked', err.getvalue())
        closed = io.StringIO()
        closed.close()
        with contextlib.redirect_stderr(closed):
            gate._note('x')  # a closed stderr must not turn a diagnostic into a crash

    def test_an_unexpected_error_never_escapes(self):
        class Broken(FakeProc):
            def communicate(self, timeout=None):
                raise RuntimeError('boom')
        terms, err = self.fetch(Broken())
        self.assertIsNone(terms)
        self.assertEqual(len(err.strip().splitlines()), 1)


class LiveTermsTest(GateCase):
    """S6: the live terms of storage join the leak check, so a stale generated file cannot hide a term."""

    def setUp(self):
        super().setUp()
        for owner, name in ((gate, 'fetch_storage_terms'), (gate, 'staged_blob'), (gate, 'git'), (gate, '_storage_answer'), (sys, 'argv')):
            self.addCleanup(setattr, owner, name, getattr(owner, name))
        self.asked = 0
        # Deterministic by default: unit tests never spawn pnpm/node; a test that needs terms calls storage_has().
        gate.fetch_storage_terms = lambda: None
        gate.staged_blob = lambda path: 'const name = "Newer Mark";\n'

    def storage_has(self, terms):
        def fetch():
            self.asked += 1
            return terms
        gate.fetch_storage_terms = fetch

    def test_stale_file_cannot_hide_a_term(self):
        gate.BRAND_DENYLIST_GENERATED.write_text('fictionalco\n', encoding='utf-8')  # lacks "Newer Mark"
        self.storage_has(['fictionalco', 'Newer Mark'])
        leaks = gate.check_brand_leaks(['system/x.ts'])
        self.assertEqual(len(leaks), 1)
        self.assertIn('storage (live)', leaks[0])

    def test_unknown_storage_adds_nothing(self):
        self.storage_has(None)
        self.assertEqual(gate.check_brand_leaks(['system/x.ts']), [])

    def test_live_terms_pass_the_same_filters(self):
        self.storage_has(['abc', 'norte'])
        self.assertEqual(gate.denylist_with_origins(live=True), {})

    def test_warning_and_leak_check_share_one_query(self):
        self.storage_has(['Newer Mark'])
        gate.storage_denylist_warnings()
        gate.check_brand_leaks(['system/x.ts'])
        self.assertEqual(self.asked, 1)

    def scan(self):
        gate.git = lambda *a: ''  # empty tree, empty history
        sys.argv = ['validate_commit_guardian.py', '--scan']
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = gate.main()
        return code, out.getvalue()

    def test_scan_wiring_prints_one_absent_warning_and_still_audits(self):
        self.storage_has(['Newer Mark'])
        code, out = self.scan()
        self.assertEqual(code, 0)
        self.assertEqual(out.count('is absent'), 1, 'the storage warning only; the legacy fallback stays quiet')
        self.assertIn('CURRENT TREE', out)
        self.assertIn('storage (live)', out)

    def test_check_push_sees_live_terms_missing_from_the_generated_file(self):
        gate.BRAND_DENYLIST_GENERATED.write_text('fictionalco\n', encoding='utf-8')  # stale: lacks "Newer Mark"
        self.storage_has(['fictionalco', 'Newer Mark'])
        gate.git = lambda *a: '+++ b/system/x.ts\n+const name = "Newer Mark";\n'
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(gate.check_push(['abc..def']), 1)
        self.assertIn('Newer Mark', err.getvalue())
        self.assertIn('storage (live)', err.getvalue())

    def test_check_push_with_no_terms_at_all_passes_and_says_nothing(self):
        self.storage_has(None)  # storage unknown, no generated file: nothing to search for
        gate.git = lambda *a: '+++ b/system/x.ts\n+const name = "Newer Mark";\n'
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(gate.check_push(['abc..def']), 0)
        self.assertEqual((out.getvalue(), err.getvalue()), ('', ''))

    def test_scan_wiring_unknown_storage_prints_the_fallback_once(self):
        gate.BRAND_DENYLIST.write_text('fictionalco\n', encoding='utf-8')  # something to search for
        self.storage_has(None)
        code, out = self.scan()
        self.assertEqual(out.count('is absent'), 1)
        self.assertNotIn('while storage has real brands', out)


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

    def test_a_dot_before_the_at_sign_does_not_glue_it(self):
        profile = gate.ROOT / 'profiles' / 'fictional-co'
        profile.mkdir(parents=True)
        (profile / 'notes.md').write_text('and so on.@after_dot', encoding='utf-8')
        gate.real_profile_dirs = lambda: [profile]
        self.assertIn('after_dot', gate.derive_terms())


if __name__ == '__main__':
    unittest.main()
