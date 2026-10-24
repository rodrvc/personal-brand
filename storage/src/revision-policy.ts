import { RuleParamsError, validateRule, validateRuleParams, type Rule } from "@personal-brand/core/checks";

import { InvalidInputError } from "./contracts/errors.ts";
import type { AssetInput, CarouselStatus, BrandRule, RuleInput, Versioned, WriteMeta } from "./contracts/repositories.ts";

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

const ASSET_KINDS = ["background", "character", "photo", "logo", "decoration", "font", "unclassified"];
const ASSET_ORIGINS = ["manual", "ai", "reference"];
const ASSET_STATUSES = ["candidate", "approved", "hidden"];
const SHA256 = /^[0-9a-f]{64}$/;

/** Mirrors the `assets` CHECK constraints so both implementations reject identically. */
export function assertAsset(input: Partial<AssetInput>, complete = true): void {
  const bad = (what: string): never => {
    throw new InvalidInputError(`invalid asset ${what}`);
  };
  const oneOf = (list: string[], value: string | undefined, what: string, optional: boolean) => {
    if (!(optional && value === undefined) && !list.includes(value ?? "")) bad(what);
  };
  if (complete) {
    if (!SHA256.test(input.sha256 ?? "")) bad("sha256");
    if (!input.mime) bad("mime");
    if (!Number.isInteger(input.bytes) || input.bytes! < 0) bad("bytes");
    oneOf(ASSET_ORIGINS, input.origin, "origin", false);
  }
  oneOf(ASSET_KINDS, input.kind, "kind", !complete);
  oneOf(ASSET_STATUSES, input.status, "status", !complete);
  for (const dim of [input.width, input.height]) if (dim !== undefined && (!Number.isInteger(dim) || dim < 1)) bad("dimensions");
  if (input.tags !== undefined && !input.tags.every((t) => typeof t === "string")) bad("tags");
  if (input.generation !== undefined && (typeof input.generation !== "object" || input.generation === null || Array.isArray(input.generation))) bad("generation");
}

export const isAssetId = (value: string): boolean => /^[0-9a-f]{16}$/.test(value);

export function assertTts(narrationHash: string, entry: { sha256: string; seconds: number; voice: unknown }): void {
  if (!narrationHash) throw new InvalidInputError("narration hash must not be empty");
  if (!SHA256.test(entry.sha256)) throw new InvalidInputError("invalid sha256");
  if (!Number.isFinite(entry.seconds) || entry.seconds < 0) throw new InvalidInputError("invalid seconds");
  assertParams(entry.voice, 1);
}

const CAROUSEL_STATUSES: string[] = ["draft", "exported", "scheduled", "published"];

/** Mirrors the `carousels` CHECK constraints so both implementations reject identically. */
export function assertCarousel(input: { slug?: string; title?: string; status?: CarouselStatus; document?: { json: unknown; schemaVersion: number } }, complete = false): void {
  if (input.slug !== undefined) assertSlug(input.slug);
  if ((complete || input.title !== undefined) && typeof input.title !== "string") throw new InvalidInputError("carousel title must be a string");
  if (input.status !== undefined && !CAROUSEL_STATUSES.includes(input.status)) throw new InvalidInputError(`invalid carousel status "${input.status}"`);
  if (input.document) assertEnvelope(input.document);
}

/** Status is stored once, in its column: drops any `status` key from a document before it is stored. */
export function stripStatus(document: Record<string, unknown>): Record<string, unknown> {
  const { status: _status, ...rest } = document;
  return rest;
}

export function parseInstant(value: string | null | undefined, what: string): Date | null {
  if (value === null || value === undefined) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new InvalidInputError(`invalid ${what}`);
  return at;
}

/** `afterSeq` and `limit` of a chat page must be non-negative integers. */
export function assertChatPage(opts?: { afterSeq?: number; limit?: number }): void {
  for (const n of [opts?.afterSeq, opts?.limit]) if (n !== undefined && (!Number.isInteger(n) || n < 0)) throw new InvalidInputError("afterSeq and limit must be non-negative integers");
}

export const DEFAULT_EXPORT_STALE_MS = 30 * 60 * 1000;

export function assertJsonObject(value: unknown, what: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidInputError(`${what} must be an object`);
}
