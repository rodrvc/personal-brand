/**
 * Generic rule/check mechanism (docs/design/storage-foundation.md section 9).
 *
 * A rule is { kind, params, severity, applies_to, message }. The engine owns a
 * CLOSED set of kinds; a brand only picks kinds and params. Pure functions, no
 * I/O, no dependencies. There is deliberately no regex kind (ReDoS risk).
 * `required_terms` and `asset_policy` are future kinds, added when a brand needs them.
 *
 * Document shape accepted by `runChecks`:
 *   { kind: 'carousel', slides: [{ title, subtitle, body, image, date, ... }],
 *     period?: { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } }
 *   { kind: 'caption', text: '...' }   // checked as one slide with only `body`
 */

export const RULE_KINDS = ['forbidden_terms', 'max_length', 'slide_count', 'image_hosts', 'date_window']
export const RULE_SEVERITIES = ['error', 'warning']
export const RULE_TARGETS = ['carousel', 'caption']

export class RuleParamsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RuleParamsError'
  }
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const isCount = (v) => Number.isInteger(v) && v >= 0
const fail = (kind, why) => {
  throw new RuleParamsError(`${kind}: ${why}`)
}

function stringList(kind, name, value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((s) => typeof s !== 'string' || s.trim() === '')) {
    fail(kind, `"${name}" must be a non-empty array of non-empty strings`)
  }
  return value
}

function slideSelector(kind, value = 'all') {
  const named = value === 'cover' || value === 'all' || value === 'last'
  if (!named && !(Array.isArray(value) && value.length > 0 && value.every(isCount))) {
    fail(kind, '"slides" must be "cover", "all", "last" or a non-empty array of slide indices')
  }
  return value
}

function strictKeys(kind, params, allowed) {
  if (!isObject(params)) fail(kind, 'params must be an object')
  for (const key of Object.keys(params)) if (!allowed.includes(key)) fail(kind, `unknown param "${key}"`)
}

const VALIDATORS = {
  forbidden_terms(p) {
    strictKeys('forbidden_terms', p, ['terms', 'match', 'case_sensitive', 'fields', 'slides'])
    const { match = 'word', case_sensitive = false } = p
    if (match !== 'word' && match !== 'substring') fail('forbidden_terms', '"match" must be "word" or "substring"')
    if (typeof case_sensitive !== 'boolean') fail('forbidden_terms', '"case_sensitive" must be a boolean')
    return {
      terms: stringList('forbidden_terms', 'terms', p.terms),
      match,
      case_sensitive,
      fields: stringList('forbidden_terms', 'fields', p.fields),
      slides: slideSelector('forbidden_terms', p.slides),
    }
  },
  max_length(p) {
    strictKeys('max_length', p, ['field', 'max', 'slides'])
    if (typeof p.field !== 'string' || p.field === '') fail('max_length', '"field" must be a non-empty string')
    if (!Number.isInteger(p.max) || p.max < 1) fail('max_length', '"max" must be a positive integer')
    return { field: p.field, max: p.max, slides: slideSelector('max_length', p.slides) }
  },
  slide_count(p) {
    strictKeys('slide_count', p, ['min', 'max'])
    if (p.min === undefined && p.max === undefined) fail('slide_count', 'set "min", "max" or both')
    for (const name of ['min', 'max']) if (p[name] !== undefined && !isCount(p[name])) fail('slide_count', `"${name}" must be a non-negative integer`)
    if (p.min !== undefined && p.max !== undefined && p.min > p.max) fail('slide_count', '"min" must not exceed "max"')
    return { ...(p.min === undefined ? {} : { min: p.min }), ...(p.max === undefined ? {} : { max: p.max }) }
  },
  image_hosts(p) {
    strictKeys('image_hosts', p, ['hosts'])
    return { hosts: stringList('image_hosts', 'hosts', p.hosts) }
  },
  date_window(p) {
    strictKeys('date_window', p, ['require_dates'])
    const { require_dates = true } = p
    if (typeof require_dates !== 'boolean') fail('date_window', '"require_dates" must be a boolean')
    return { require_dates }
  },
}

/** Returns the params with defaults applied; throws RuleParamsError for an unknown kind or bad params. */
export function validateRuleParams(kind, params) {
  if (!Object.hasOwn(VALIDATORS, kind)) throw new RuleParamsError(`unknown rule kind "${kind}"`)
  return VALIDATORS[kind](params)
}

/** Checks the rule envelope (everything except kind/params). Throws RuleParamsError. */
export function validateRule(rule) {
  if (!isObject(rule)) throw new RuleParamsError('rule must be an object')
  if (!RULE_SEVERITIES.includes(rule.severity)) throw new RuleParamsError(`severity must be one of ${RULE_SEVERITIES.join(', ')}`)
  const targets = rule.applies_to
  if (!Array.isArray(targets) || targets.length === 0 || targets.some((t) => !RULE_TARGETS.includes(t))) {
    throw new RuleParamsError(`applies_to must be a non-empty subset of ${RULE_TARGETS.join(', ')}`)
  }
  if (typeof rule.message !== 'string') throw new RuleParamsError('message must be a string')
}

const nfc = (s) => s.normalize('NFC')
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function termMatcher({ terms, match, case_sensitive }) {
  const body = terms.map((t) => escapeRe(nfc(t))).join('|')
  const word = '[\\p{L}\\p{M}\\p{N}_]'
  const source = match === 'word' ? `(?<!${word})(?:${body})(?!${word})` : body
  return new RegExp(source, case_sensitive ? 'gu' : 'giu')
}

function selectSlides(slides, selector) {
  if (selector === 'all') return slides.map((slide, index) => ({ slide, index }))
  const indices = selector === 'cover' ? [0] : selector === 'last' ? [slides.length - 1] : selector
  return indices.filter((i) => i >= 0 && i < slides.length).map((i) => ({ slide: slides[i], index: i }))
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

const isoDate = (v) => {
  const m = typeof v === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return null
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCMonth() === +m[2] - 1 ? v : null
}

/**
 * Units and matching, per kind:
 * - max_length counts user-perceived characters (grapheme clusters, Intl.Segmenter), not UTF-16 units.
 * - forbidden_terms NFC-normalizes terms and text. `word` boundaries are anything but letters, marks,
 *   digits and "_", so "best" matches inside "best-ever".
 * - image_hosts compares `URL.host` exactly: it includes the port, and there is no subdomain wildcard
 *   ("www.example.test" and "example.test" are different hosts).
 */
/** Each check returns [{ slide?, field?, detail }]; runChecks attaches the rule identity. */
const CHECKS = {
  forbidden_terms(doc, p) {
    const re = termMatcher(p)
    const out = []
    for (const { slide, index } of selectSlides(doc.slides, p.slides)) {
      for (const field of p.fields) {
        if (typeof slide[field] !== 'string') continue
        // One finding per distinct term found in the field.
        const seen = new Set()
        for (const hit of nfc(slide[field]).matchAll(re)) {
          const key = p.case_sensitive ? hit[0] : hit[0].toLowerCase()
          if (!seen.has(key)) out.push({ slide: index, field, detail: `contains "${hit[0]}"` })
          seen.add(key)
        }
      }
    }
    return out
  },
  max_length(doc, p) {
    const out = []
    for (const { slide, index } of selectSlides(doc.slides, p.slides)) {
      const length = typeof slide[p.field] === 'string' ? [...GRAPHEMES.segment(slide[p.field])].length : 0
      if (length > p.max) out.push({ slide: index, field: p.field, detail: `${length} characters, limit ${p.max}` })
    }
    return out
  },
  slide_count(doc, p) {
    const n = doc.slides.length
    return (p.min !== undefined && n < p.min) || (p.max !== undefined && n > p.max)
      ? [{ detail: `${n} slides, expected ${p.min ?? 0}..${p.max ?? 'any'}` }]
      : []
  },
  image_hosts(doc, p) {
    const out = []
    doc.slides.forEach((slide, index) => {
      if (typeof slide.image !== 'string') return
      let host = null
      try {
        host = new URL(slide.image).host
      } catch {}
      if (host === null) out.push({ slide: index, field: 'image', detail: `not a valid URL: ${slide.image}` })
      else if (!p.hosts.includes(host)) out.push({ slide: index, field: 'image', detail: `host "${host}" is not one of ${p.hosts.join(', ')}` })
    })
    return out
  },
  date_window(doc, p) {
    // Without a period there is nothing to compare against, so the rule does not apply.
    const start = isoDate(doc.period?.start)
    const end = isoDate(doc.period?.end)
    if (!start || !end) return []
    const out = []
    if (p.require_dates && doc.slides.length > 0 && !doc.slides.some((s) => s.date != null)) {
      out.push({ detail: `no slide carries a "date", so ${start}..${end} was never checked` })
    }
    doc.slides.forEach((slide, index) => {
      if (slide.date == null) return
      const date = isoDate(slide.date)
      if (!date) out.push({ slide: index, field: 'date', detail: `"${slide.date}" is not a valid YYYY-MM-DD date` })
      else if (date < start || date > end) out.push({ slide: index, field: 'date', detail: `${date} is outside ${start}..${end}` })
    })
    return out
  },
}

/**
 * Runs every enabled rule that applies to the document and returns the findings in rule order.
 * A rule that is malformed or has an unknown kind is never skipped silently: it yields an `error` finding.
 */
export function runChecks(document, rules) {
  const slides = document.kind === 'caption' ? [{ body: document.text ?? '' }] : (document.slides ?? [])
  const doc = { ...document, slides }
  const findings = []
  rules.forEach((rule, ruleIndex) => {
    const id = rule?.id === undefined ? {} : { ruleId: rule.id }
    let params
    try {
      validateRule(rule)
      params = validateRuleParams(rule.kind, rule.params)
    } catch (error) {
      if (!(error instanceof RuleParamsError)) throw error
      findings.push({ ruleIndex, ...id, kind: rule?.kind, severity: 'error', message: 'Rule cannot be evaluated by this engine', detail: error.message })
      return
    }
    if (rule.enabled === false || !rule.applies_to.includes(document.kind)) return
    for (const f of CHECKS[rule.kind](doc, params)) {
      findings.push({ ruleIndex, ...id, kind: rule.kind, severity: rule.severity, message: rule.message, ...f })
    }
  })
  return findings
}
