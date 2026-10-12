/** Tests for the rule/check runner (fictional brand only). Run: node core/test/checks.test.mjs */
import assert from 'node:assert/strict'

import { RuleParamsError, runChecks, validateRule, validateRuleParams } from '../src/checks.js'

const cases = {
  'max_length: cover title over the limit is an error'() {
    const rule = { kind: 'max_length', severity: 'error', applies_to: ['carousel'], params: { field: 'title', max: 32, slides: 'cover' }, message: 'Cover titles stay short.' }
    const long = { kind: 'carousel', slides: [{ title: 'Acme Coffee roasts a new single origin every week' }, { title: 'x'.repeat(80) }] }
    assert.deepEqual(runChecks(long, [rule]), [
      { ruleIndex: 0, kind: 'max_length', severity: 'error', message: 'Cover titles stay short.', slide: 0, field: 'title', detail: '49 characters, limit 32' },
    ])
    assert.deepEqual(runChecks({ kind: 'carousel', slides: [{ title: 'Fresh beans' }] }, [rule]), [])
    assert.deepEqual(runChecks({ kind: 'caption', text: 'x'.repeat(99) }, [rule]), [], 'applies_to excludes captions')
  },

  'forbidden_terms: word vs substring, case, slides, caption'() {
    const base = { kind: 'forbidden_terms', severity: 'warning', applies_to: ['carousel', 'caption'], message: 'No unverifiable claims.' }
    const rule = { ...base, params: { terms: ['guaranteed', 'best ever'], match: 'word', case_sensitive: false, fields: ['title', 'subtitle', 'body'], slides: 'all' } }
    const doc = { kind: 'carousel', slides: [{ title: 'Our Best Ever roast', subtitle: 'unguaranteed bliss' }, { body: 'Guaranteed fresh.' }] }
    assert.deepEqual(runChecks(doc, [rule]).map((f) => [f.slide, f.field, f.detail, f.severity]), [
      [0, 'title', 'contains "Best Ever"', 'warning'],
      [1, 'body', 'contains "Guaranteed"', 'warning'],
    ])
    const substring = { ...base, params: { terms: ['guaranteed'], match: 'substring', fields: ['subtitle'] } }
    assert.equal(runChecks(doc, [substring]).length, 1, 'substring also hits inside "unguaranteed"')
    const sensitive = { ...base, params: { terms: ['guaranteed'], case_sensitive: true, fields: ['body'], slides: 'last' } }
    assert.deepEqual(runChecks(doc, [sensitive]), [], 'case-sensitive ignores "Guaranteed"')
    assert.equal(runChecks({ kind: 'caption', text: 'Guaranteed!' }, [rule]).length, 1, 'caption text is checked as body')
    assert.equal(runChecks(doc, [{ ...rule, params: { ...rule.params, terms: ['a.c'], fields: ['title'] } }]).length, 0, 'terms are literals, not regex')
  },

  'slide_count, image_hosts and date_window'() {
    const rule = (kind, params) => ({ kind, params, severity: 'error', applies_to: ['carousel'], message: kind })
    const doc = {
      kind: 'carousel',
      period: { start: '2026-03-02', end: '2026-03-08' },
      slides: [{ image: 'https://cdn.example.test/a.jpg', date: '2026-03-03' }, { image: 'https://evil.test/b.jpg', date: '2026-03-20' }, { image: 'nope', date: '2026-02-31' }],
    }
    assert.deepEqual(runChecks(doc, [rule('slide_count', { min: 5 })]).map((f) => f.detail), ['3 slides, expected 5..any'])
    assert.deepEqual(runChecks(doc, [rule('image_hosts', { hosts: ['cdn.example.test'] })]).map((f) => [f.slide, f.detail]), [
      [1, 'host "evil.test" is not one of cdn.example.test'],
      [2, 'not a valid URL: nope'],
    ])
    assert.deepEqual(runChecks(doc, [rule('date_window', {})]).map((f) => [f.slide, f.detail]), [
      [1, '2026-03-20 is outside 2026-03-02..2026-03-08'],
      [2, '"2026-02-31" is not a valid YYYY-MM-DD date'],
    ])
    const undated = { kind: 'carousel', period: doc.period, slides: [{ title: 'a' }] }
    assert.equal(runChecks(undated, [rule('date_window', {})]).length, 1, 'a period nothing was compared against is reported')
    assert.equal(runChecks(undated, [rule('date_window', { require_dates: false })]).length, 0)
    assert.equal(runChecks({ kind: 'carousel', slides: [{ date: 'x' }] }, [rule('date_window', {})]).length, 0, 'no period, no check')
  },

  'disabled rules are skipped; broken rules throw'() {
    const rule = { kind: 'slide_count', params: { max: 1 }, severity: 'error', applies_to: ['carousel'], message: 'm', enabled: false }
    const doc = { kind: 'carousel', slides: [{}, {}] }
    assert.deepEqual(runChecks(doc, [rule]), [])
    const broken = [{ ...rule, id: 'r1', kind: 'regex' }, { ...rule, params: { max: -1 } }, { ...rule, severity: 'fatal' }, { ...rule, applies_to: [] }]
    const found = runChecks(doc, broken)
    assert.equal(found.length, 4, 'a broken rule is reported, not thrown')
    assert.deepEqual(found[0], { ruleIndex: 0, ruleId: 'r1', kind: 'regex', severity: 'error', message: 'Rule cannot be evaluated by this engine', detail: 'unknown rule kind "regex"' })
    assert.throws(() => validateRuleParams('regex', {}), RuleParamsError)
    assert.throws(() => validateRule({ ...rule, message: 5 }), RuleParamsError)
  },

  'forbidden_terms: NFD input, hyphens, every distinct term, ruleId'() {
    const rule = { id: 'claims', kind: 'forbidden_terms', severity: 'warning', applies_to: ['carousel'], message: 'm', params: { terms: ['caf\u00e9', 'best'], fields: ['title'] } }
    const doc = (title) => ({ kind: 'carousel', slides: [{ title }] })
    assert.equal(runChecks(doc('Visit our cafe\u0301 today'), [rule]).length, 1, 'NFD text matches an NFC term')
    assert.equal(runChecks(doc('cafeteria'), [rule]).length, 0)
    assert.equal(runChecks(doc('The best-ever roast'), [rule]).length, 1, 'a hyphen is a word boundary')
    const all = runChecks(doc('BEST caf\u00e9, best caf\u00e9'), [rule])
    assert.deepEqual(all.map((f) => [f.ruleId, f.detail]), [['claims', 'contains "BEST"'], ['claims', 'contains "caf\u00e9"']], 'one finding per distinct term')
  },

  'edge cases: graphemes, null dates, empty carousel'() {
    const rule = (kind, params) => ({ kind, params, severity: 'error', applies_to: ['carousel'], message: kind })
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
    assert.equal(runChecks({ kind: 'carousel', slides: [{ title: family.repeat(3) }] }, [rule('max_length', { field: 'title', max: 3 })]).length, 0, 'emoji sequences count once')
    const period = { start: '2026-03-02', end: '2026-03-08' }
    assert.equal(runChecks({ kind: 'carousel', period, slides: [] }, [rule('date_window', {})]).length, 0)
    assert.equal(runChecks({ kind: 'carousel', period, slides: [{ date: null }] }, [rule('date_window', {})]).length, 1, 'null date counts as missing')
  },

  'validateRuleParams: defaults and rejections'() {
    assert.deepEqual(validateRuleParams('forbidden_terms', { terms: ['a'], fields: ['title'] }), { terms: ['a'], match: 'word', case_sensitive: false, fields: ['title'], slides: 'all' })
    assert.deepEqual(validateRuleParams('date_window', {}), { require_dates: true })
    const bad = [
      ['regex', { pattern: '.*' }],
      ['max_length', { field: 'title', max: 0 }],
      ['max_length', { field: 'title', max: 5, extra: 1 }],
      ['forbidden_terms', { terms: [], fields: ['title'] }],
      ['forbidden_terms', { terms: ['a'], fields: ['title'], slides: [-1] }],
      ['slide_count', {}],
      ['slide_count', { min: 4, max: 2 }],
      ['image_hosts', { hosts: 'cdn.example.test' }],
      ['date_window', null],
    ];
    for (const [kind, params] of bad) assert.throws(() => validateRuleParams(kind, params), RuleParamsError, `${kind} ${JSON.stringify(params)}`)
  },
}

for (const [name, fn] of Object.entries(cases)) {
  fn()
  console.log(`  ok - ${name}`)
}
