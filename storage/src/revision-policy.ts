import { InvalidInputError } from "./contracts/errors.ts";
import type { WriteMeta } from "./contracts/repositories.ts";

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
export function assertSlug(slug: string): void {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new InvalidInputError(`invalid slug "${slug}"`);
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
