"""Run: python3 -m unittest scripts/test_brand_gate_report.py

The "Report" step of the brand-gate workflow, run as a shell script against
fixture scanner output. Every path, term and line here is fictional.
"""
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_commit_guardian as gate  # noqa: E402

WORKFLOW = Path(__file__).resolve().parent.parent / '.github' / 'workflows' / 'brand-gate.yml'

LEAK_BODY = 'const secretValue = "zz-fixture-line-text";'
LEAK_TERM = 'zz-fixture-term'
TERM_FINDING = (f'  system/example/foo.ts: {LEAK_BODY}\n'
                f'      \u21b3 term "{LEAK_TERM}" \u2014 from the fixture list\n')


def market_finding(index, kind):
    return f'  system/example/m{index}.ts:{index}: {kind}\n'


COORD_FINDING = market_finding(1, gate.COORDINATES_KIND)
LOCALE_FINDING = market_finding(2, gate.LOCALE_KIND)


def report_script() -> str:
    """The `run: |` body of the Report step only, dedented."""
    lines = WORKFLOW.read_text(encoding='utf-8').splitlines()
    start = next((i for i, line in enumerate(lines)
                  if re.match(r'\s*- name: Report\s*$', line)), None)
    if start is None:
        raise AssertionError('no step named Report in the workflow')
    end = next((i for i in range(start + 1, len(lines))
                if re.match(r'\s*- name:', lines[i])), len(lines))
    run = next((i for i in range(start, end) if re.match(r'\s*run: \|\s*$', lines[i])), None)
    if run is None:
        raise AssertionError('the Report step has no `run: |` block')
    indent = len(lines[run]) - len(lines[run].lstrip())
    body = []
    for line in lines[run + 1:end]:
        if line.strip() and not line.startswith(' ' * (indent + 1)):
            break
        body.append(line)
    return textwrap.dedent('\n'.join(body))


def run_report(status, out='', err=''):
    with tempfile.TemporaryDirectory() as tmp:
        Path(tmp, 'audit.out').write_text(out, encoding='utf-8')
        Path(tmp, 'audit.err').write_text(err, encoding='utf-8')
        env = {'PATH': '/usr/bin:/bin', 'AUDIT_STATUS': status, 'PUSH_SHA': 'abc123'}
        return subprocess.run(['bash', '-c', report_script()], cwd=tmp, env=env,
                              capture_output=True, text=True)


class ReportStepTest(unittest.TestCase):
    def test_clean_status_exits_zero(self):
        result = run_report('0')
        self.assertEqual(result.returncode, 0)
        self.assertIn('clean', result.stdout)

    def test_empty_status_means_the_audit_did_not_run(self):
        result = run_report('')
        self.assertEqual(result.returncode, 1)
        self.assertIn('did not run', result.stdout)

    def test_term_only_counts_one(self):
        result = run_report('1', out=TERM_FINDING)
        self.assertEqual(result.returncode, 1)
        self.assertIn('1 brand literal(s) or market signal(s)', result.stdout)
        self.assertIn('system/example/foo.ts', result.stdout)
        self.assertNotIn(LEAK_BODY, result.stdout)
        self.assertNotIn(LEAK_TERM, result.stdout)

    def test_market_signals_only_are_counted_not_misreported(self):
        result = run_report('1', out=COORD_FINDING + LOCALE_FINDING)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('did not complete', result.stdout)
        self.assertIn('2 brand literal(s) or market signal(s)', result.stdout)
        self.assertIn('system/example/m1.ts', result.stdout)
        self.assertIn('system/example/m2.ts', result.stdout)
        self.assertNotIn(gate.COORDINATES_KIND, result.stdout)
        self.assertNotIn(gate.LOCALE_KIND, result.stdout)

    def test_all_four_market_kinds_are_counted(self):
        out = ''.join(market_finding(i, k) for i, k in enumerate(gate.MARKET_KINDS, 1))
        self.assertIn(f'{len(gate.MARKET_KINDS)} brand literal(s) or market signal(s)',
                      run_report('1', err=out).stdout)

    def test_mixed_findings_total(self):
        result = run_report('1', out=TERM_FINDING + COORD_FINDING, err=LOCALE_FINDING)
        self.assertIn('3 brand literal(s) or market signal(s)', result.stdout)
        self.assertNotIn(LEAK_BODY, result.stdout)
        self.assertNotIn(LEAK_TERM, result.stdout)

    def test_failure_without_findings_is_a_scanner_failure(self):
        result = run_report('1', out='some unrelated crash text\n')
        self.assertEqual(result.returncode, 1)
        self.assertIn('did not complete', result.stdout)

    def test_prose_mentioning_a_kind_is_not_a_finding(self):
        result = run_report('1', err='note: a locale tag of a real brand was seen somewhere\n')
        self.assertIn('did not complete', result.stdout)


class KindDriftTest(unittest.TestCase):
    def test_workflow_lists_the_guardians_kinds(self):
        step = report_script()
        for kind in gate.MARKET_KINDS:
            self.assertIn(kind, step)


if __name__ == '__main__':
    unittest.main()
