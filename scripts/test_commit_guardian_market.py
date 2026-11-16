"""Run: python3 -m unittest scripts/test_commit_guardian_market.py

Market-neutral term filters, and the coordinate / locale / currency / timezone checks.
Every brand, place and number here is fictional.
"""
import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_commit_guardian as gate  # noqa: E402

PATCHED = ('ROOT', 'PROFILES_DIR', 'BRAND_DENYLIST_GENERATED', 'BRAND_DENYLIST', 'BRAND_DENYLIST_LOCAL',
           'staged_blob', 'git', '_storage_answer')

# A fictional brand far from (0, 0): box in (lng, lat, lng, lat) order, one venue, one locale.
FAKE_BBOX = '[10.00, 50.00, 10.50, 50.40]'
FAKE_VENUE = (30.123, 60.456)


class MarketCase(unittest.TestCase):
    def setUp(self):
        saved = {name: getattr(gate, name) for name in PATCHED}
        self.addCleanup(lambda: [setattr(gate, k, v) for k, v in saved.items()])
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / 'scripts').mkdir()
        gate.ROOT = root
        gate.PROFILES_DIR = root / 'profiles'
        gate.BRAND_DENYLIST_GENERATED = root / 'scripts' / 'generated.txt'
        gate.BRAND_DENYLIST = root / 'scripts' / 'denylist.txt'
        gate.BRAND_DENYLIST_LOCAL = root / 'scripts' / 'denylist.local.txt'
        gate._storage_answer = None  # storage is unknown: only the profiles on disk speak
        self.root = root

    def add_profile(self, slug='zorbaflux', brand=None, config='', recipe=None):
        folder = self.root / 'profiles' / slug
        (folder / 'recipes').mkdir(parents=True)
        (folder / 'brand.json').write_text(json.dumps(brand or {}), encoding='utf-8')
        (folder / 'config.yaml').write_text(config, encoding='utf-8')
        if recipe:
            (folder / 'recipes' / 'weekly.yaml').write_text(recipe, encoding='utf-8')
        return folder

    def add_fictional_brand(self):
        return self.add_profile(
            brand={'locale': 'qq-ZZ', 'copy': {'wordmark': 'Zorbaflux', 'site': 'zorba.co.xx'}},
            config='currency: ZZQ\ntimezone: Fictia/Capital\n',
            recipe=f'map:\n  bbox: {FAKE_BBOX}\n  venue: {{lat: {FAKE_VENUE[1]}, lng: {FAKE_VENUE[0]}}}\n',
        )

    def hits(self, text):
        return gate.MarketSignals().scan(list(enumerate(text.splitlines(), 1)))


class NeutralTermsTest(MarketCase):
    def test_fictional_brand_terms_are_still_caught(self):
        self.add_profile(brand={'copy': {'wordmark': 'Zorbaflux', 'site': 'zorba.co.xx'}},
                         config='default_hashtags:\n  - ZorbaWeekend\n  - events\n')
        terms = {t.lower() for t in gate.denylist_with_origins()}
        self.assertTrue({'zorbaflux', 'zorba.co.xx', 'zorba', 'zorbaweekend'} <= terms)

    def test_generic_words_are_ignored(self):
        for word in ('norte', 'north', 'events', 'weekend', 'studio', 'city', 'plaza'):
            self.assertFalse(gate._watchable(word), word)

    def test_place_names_are_not_excluded(self):
        # The list must not name any market; a place a brand uses is exactly what is watched.
        self.assertTrue(gate._watchable('Fictiaville'))
        self.assertFalse({w for w in gate.GENERIC_WORDS if ' ' in w or len(w) > 12})
        self.assertNotIn('panoramas', gate.GENERIC_WORDS)

    def test_public_suffix_is_derived_without_a_listed_country(self):
        for domain, base in (('zorba.com', 'zorba'), ('www.zorba.co.xx', 'zorba'), ('api.zorba.qq', 'zorba'),
                             ('zorba.io', 'zorba'), ('zorba.org.xx', 'zorba')):
            self.assertIn(base, gate._domain_terms(domain), domain)

    def test_example_hashtag_is_identifying(self):
        self.assertTrue(gate._identifying_hashtag('#ExampleWeekend'))
        self.assertFalse(gate._identifying_hashtag('#events'))


class DerivationTest(MarketCase):
    def test_nothing_derived_without_real_profiles(self):
        signals = gate.MarketSignals()
        self.assertTrue(signals.empty())
        self.assertEqual(signals.scan([(1, '50.2, 10.2 qq-ZZ ZZQ')]), [])

    def test_example_profiles_contribute_nothing(self):
        self.add_profile(slug='example-brand', brand={'locale': 'qq-ZZ'})
        self.assertTrue(gate.MarketSignals().empty())

    def test_boxes_tokens_come_from_profile_data(self):
        self.add_fictional_brand()
        self.assertTrue(gate.derive_geo_boxes())
        tokens = gate.derive_market_tokens()
        self.assertEqual(tokens['locale'], {'qq-zz'})
        self.assertEqual(tokens['currency'], {'ZZQ'})
        self.assertEqual(tokens['timezone'], {'Fictia/Capital'})


class ScrapedDataLocaleTest(MarketCase):
    def test_bare_tag_in_scraped_data_is_not_watched_but_settings_are(self):
        folder = self.add_profile(brand={'locale': 'qq-ZZ'})
        (folder / 'reels').mkdir()
        (folder / 'reels' / 'events.json').write_text('{"url": "https://x.test/?hl=en-US", "lang": "ww-YY", "note": "ee-AA"}')
        locales = gate.derive_market_tokens()['locale']
        self.assertIn('qq-zz', locales)
        self.assertIn('ww-yy', locales)       # keyed value: allowed from any file
        self.assertNotIn('en-us', locales)    # bare tag in scraped data
        self.assertNotIn('ee-aa', locales)

    def test_bare_tag_in_brand_settings_is_watched(self):
        self.add_profile(config='# market: qq-ZZ\n')
        self.assertIn('qq-zz', gate.derive_market_tokens()['locale'])


class CoordinatesTest(MarketCase):
    def setUp(self):
        super().setUp()
        self.add_fictional_brand()

    def kinds(self, text):
        return [(n, k) for n, k in self.hits(text) if k == gate.COORDINATES_KIND]

    def test_pair_inside_the_box_is_flagged_in_either_order(self):
        self.assertEqual([n for n, _ in self.kinds('x\nvenue 50.200, 10.200\n')], [2])
        self.assertEqual([n for n, _ in self.kinds('venue 10.200, 50.200')], [1])

    def test_margin_around_a_point_and_a_box(self):
        self.assertTrue(self.kinds('60.600, 30.300'))   # within the point margin
        self.assertTrue(self.kinds('50.450, 10.250'))     # within the box margin
        self.assertFalse(self.kinds('51.500, 10.250'))  # clearly outside

    def test_keyed_pairs_even_across_lines(self):
        self.assertEqual(self.kinds('{\n "lat": 50.2,\n "lng": 10.2\n}')[0][0], 2)
        self.assertTrue(self.kinds('{"longitude": 10.2, "latitude": 50.2}'))

    def test_far_or_coarse_numbers_are_not_flagged(self):
        self.assertFalse(self.kinds('0.000, 0.000'))
        self.assertFalse(self.kinds('50.2, 10.2'))  # bare pairs need three decimals
        self.assertFalse(self.kinds('ratio 1.618, 2.718'))

    def test_report_never_carries_the_numbers(self):
        for _, kind in self.hits('50.200, 10.200'):
            self.assertNotIn('50.2', kind)

    def test_unrelated_added_lines_never_pair_up(self):
        signals = gate.MarketSignals()
        self.assertEqual(signals.scan([(3, '50.200,'), (9, '10.200')]), [])


class LocaleCurrencyTest(MarketCase):
    def setUp(self):
        super().setUp()
        self.add_fictional_brand()

    def test_locale_currency_and_timezone_are_flagged(self):
        text = 'a\nlocale qq-ZZ\nprice 10 ZZQ\nzone fictia/capital\nsafe en-GB, USD\n'
        self.assertEqual(self.hits(text), [
            (2, 'locale tag of a real brand'), (3, 'currency code of a real brand'),
            (4, 'timezone of a real brand')])

    def test_underscore_form_and_word_boundaries(self):
        self.assertTrue(self.hits('qq_ZZ'))
        self.assertFalse(self.hits('xqq-ZZx'))
        self.assertFalse(self.hits('zzq'))  # currency codes match as written


class WiringTest(MarketCase):
    def setUp(self):
        super().setUp()
        self.add_fictional_brand()

    def test_staged_check_honors_scanned_prefixes(self):
        gate.staged_blob = lambda path: 'zone 50.200, 10.200\n'
        out = gate.check_market_signals(['docs/a.md', 'profiles/example/x.md', 'scripts/t.py', 'app/b.ts'])
        self.assertEqual(out, [f'docs/a.md:1: {gate.COORDINATES_KIND}', f'profiles/example/x.md:1: {gate.COORDINATES_KIND}'])

    def test_push_check_reports_added_lines_by_location(self):
        diff = ('diff --git a/docs/a.md b/docs/a.md\n+++ b/docs/a.md\n@@ -1,0 +7,2 @@\n+ok line\n+currency ZZQ\n'
                '+++ b/scripts/t.py\n@@ -0,0 +1 @@\n+ZZQ\n')
        gate.git = lambda *args: diff
        import contextlib
        import io
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = gate.check_push(['abc..def'])
        self.assertEqual(code, 1)
        self.assertIn('docs/a.md:8: currency code of a real brand', err.getvalue())
        self.assertNotIn('scripts/t.py', err.getvalue())

    def test_push_check_never_joins_pairs_across_commits(self):
        diff = ('@@@COMMIT\n+++ b/docs/a.md\n@@ -0,0 +1 @@\n+lat: 50.2\n'
                '@@@COMMIT\n+++ b/docs/a.md\n@@ -1,0 +2 @@\n+lng: 10.2\n')
        gate.git = lambda *args: diff
        self.assertEqual(gate.check_push(['abc..def']), 0)

    def test_push_check_passes_when_clean(self):
        gate.git = lambda *args: '+++ b/docs/a.md\n@@ -0,0 +1 @@\n+nothing here\n'
        self.assertEqual(gate.check_push(['abc..def']), 0)


class RealGitPushTest(MarketCase):
    """The push check against a real repository: the mocked tests above cannot catch a git CLI error."""

    def commit(self, rel, text):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        run = lambda *a: subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.test', *a],
                                        cwd=self.root, check=True, capture_output=True)
        run('add', rel)
        run('commit', '-q', '-m', rel)
        return subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=self.root, text=True).strip()

    def setUp(self):
        super().setUp()
        subprocess.run(['git', 'init', '-q'], cwd=self.root, check=True)
        self.add_fictional_brand()  # untracked, like a real profile next to the engine
        self.base = self.commit('docs/start.md', 'start\n')

    def test_clean_range_passes(self):
        head = self.commit('docs/a.md', 'nothing here\n')
        self.assertEqual(gate.check_push([f'{self.base}..{head}']), 0)

    def test_pair_in_one_commit_fails_and_pairs_never_join_across_commits(self):
        self.commit('docs/a.md', f'lat: {FAKE_VENUE[1]}\n')
        head = self.commit('docs/a.md', f'lat: {FAKE_VENUE[1]}\nlng: {FAKE_VENUE[0]}\n')
        self.assertEqual(gate.check_push([f'{self.base}..{head}']), 0)
        head = self.commit('docs/b.md', f'lat: {FAKE_VENUE[1]}\nlng: {FAKE_VENUE[0]}\n')
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(gate.check_push([f'{self.base}..{head}']), 1)


if __name__ == '__main__':
    unittest.main()
