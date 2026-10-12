export type RuleKind = 'forbidden_terms' | 'max_length' | 'slide_count' | 'image_hosts' | 'date_window'
export type RuleSeverity = 'error' | 'warning'
export type RuleTarget = 'carousel' | 'caption'

export const RULE_KINDS: readonly RuleKind[]
export const RULE_SEVERITIES: readonly RuleSeverity[]
export const RULE_TARGETS: readonly RuleTarget[]

export class RuleParamsError extends Error {}

export interface Rule {
  /** Passed through to findings as `ruleId`. */
  id?: string
  kind: RuleKind
  params: unknown
  severity: RuleSeverity
  applies_to: RuleTarget[]
  message: string
  /** Defaults to true. */
  enabled?: boolean
}

export type CheckDocument =
  | { kind: 'carousel'; slides: Array<Record<string, unknown>>; period?: { start: string; end: string } }
  | { kind: 'caption'; text: string }

export interface Finding {
  ruleIndex: number
  ruleId?: string
  kind: RuleKind
  severity: RuleSeverity
  message: string
  slide?: number
  field?: string
  detail: string
}

/** Returns the params with defaults applied; throws RuleParamsError. */
export function validateRuleParams(kind: string, params: unknown): Record<string, unknown>
/** Checks severity, applies_to and message; throws RuleParamsError. */
export function validateRule(rule: unknown): void
export function runChecks(document: CheckDocument, rules: readonly Rule[]): Finding[]
