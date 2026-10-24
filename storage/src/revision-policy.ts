import { RuleParamsError, validateRule, validateRuleParams, type Rule } from "@personal-brand/core/checks";

import { InvalidInputError } from "./contracts/errors.ts";
import type { BrandRule, RuleInput, Versioned, WriteMeta } from "./contracts/repositories.ts";

/** An autosave within this window by the same author folds into the previous revision. */
export const AUTOSAVE_WINDOW_MS = 10 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID.test(value);

/** Revisions are a sparse history: only autosaves by the same author inside the window are skipped. */
export function shouldAppendRevision(last: { author: string; createdAt: string } | undefined, meta: WriteMeta, now: Date): boolean {
  if (meta.reason !== "autosave" || !last) return true;
  return last.author !== meta.author || now.getTime() - Date.parse(last.createdAt) > AUTOSAVE_WINDOW_MS;
}

/** Same rule as the `brands.slug` CHECK constraint, so both implementations reject identically. */
export function assertSlug(slug: string, what = "slug"): void {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new InvalidInputError(`invalid ${what} "${slug}"`);
}

export type DocumentBody = { json: unknown; schemaVersion: number } | { text: string; schemaVersion: number };

/** Envelope check only: a positive schema version plus a JSON object or a text. Domain schemas stay with callers. */
export function assertEnvelope(body: DocumentBody): void {
  if (!Number.isInteger(body.schemaVersion) || body.schemaVersion < 1) throw new InvalidInputError("schemaVersion must be a positive integer");
  if ("text" in body) {
    if (typeof body.text !== "string") throw new InvalidInputError("text body must be a string");
  } else if (typeof body.json !== "object" || body.json === null || Array.isArray(body.json)) {
    throw new InvalidInputError("json body must be an object");
  }
}

/** Validates a rule with the engine's own validators; returns it with param defaults applied. */
export function normalizeRule(input: RuleInput): RuleInput {
  try {
    validateRule({ kind: input.kind, severity: input.severity, applies_to: input.appliesTo, message: input.message });
    return { ...input, params: validateRuleParams(input.kind, input.params) as Record<string, unknown> };
  } catch (error) {
    throw error instanceof RuleParamsError ? new InvalidInputError(error.message) : error;
  }
}

/** Params of a recipe or rule are stored as a JSON object. */
export function assertParams(params: unknown, schemaVersion: number): void {
  assertEnvelope({ json: params, schemaVersion });
}

/** Stored rules in the shape `runChecks` takes; `ruleId` on a finding is the row id. */
export function toCheckRules(rows: Array<Versioned<BrandRule>>): Rule[] {
  return rows.map((r) => ({ id: r.id, kind: r.value.kind, params: r.value.params, severity: r.value.severity, applies_to: r.value.appliesTo, message: r.value.message, enabled: r.value.enabled }));
}

export const MAX_GUIDANCE_BYTES = 32 * 1024;

export function assertGuidance(input: { description: string; body: string }): void {
  if (typeof input.description !== "string" || typeof input.body !== "string") throw new InvalidInputError("description and body must be strings");
  if (Buffer.byteLength(input.body) > MAX_GUIDANCE_BYTES) throw new InvalidInputError(`guidance body exceeds ${MAX_GUIDANCE_BYTES} bytes`);
}
