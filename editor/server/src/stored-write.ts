import { BrandArchivedError, InvalidInputError, VersionConflictError, type RevisionReason } from "@personal-brand/storage/contracts";

import { assertValidCarouselId, isStructuralChange } from "./document-store.js";
import { messages } from "./messages.js";
import { editorStatus, etagOf, storedCarouselRaw, validateStored, type StoredBrand } from "./stored-read.js";

/** What a save answers: an HTTP status, a body, and the `ETag` to send (the version the answer describes). */
export interface SaveOutcome {
  status: number;
  body: unknown;
  etag?: string;
}

/** `If-Match: "<version>"` (a weak prefix is tolerated). `*` and anything else is malformed: a save names the exact version it edited. */
export function parseIfMatch(header: string | undefined): number | "missing" | "malformed" {
  if (header === undefined || header.trim() === "") return "missing";
  const match = /^(?:W\/)?"(\d{1,9})"$/.exec(header.trim());
  return match ? Number(match[1]) : "malformed";
}

/** The current copy, as the 409 hands it to the client: the document, the version it is at and the tag to re-open it with. */
async function conflict(s: StoredBrand, id: string): Promise<SaveOutcome> {
  const current = await storedCarouselRaw(s, id);
  return { status: 409, etag: etagOf(current.version), body: { error: messages.saveConflict, currentVersion: current.version, document: current.document } };
}

/**
 * `PUT /carousels/:id` for a stored brand, conditional on `If-Match` (enforced atomically by the repository's
 * `expectedVersion`): of two saves naming the same version one wins, the other gets a 409 with the winner's copy. A save
 * never writes `status` (the column owns it), so a `scheduled` carousel stays `scheduled`. The folder's `base` check
 * does not apply: the version is the stale-copy check.
 */
export async function saveStoredCarousel(s: StoredBrand, id: string, body: unknown, ifMatch: string | undefined, snapshot: boolean): Promise<SaveOutcome> {
  assertValidCarouselId(id);
  const expected = parseIfMatch(ifMatch);
  if (expected === "missing") return { status: 428, body: { error: messages.ifMatchRequired } };
  if (expected === "malformed") return { status: 400, body: { error: messages.ifMatchMalformed } };
  if ((body as { id?: string } | null)?.id !== id) return { status: 400, body: { error: `Body "id" must match the URL's carousel id "${id}"` } };

  // Archived wins over everything else: a stale copy of an archived brand is 403, not a 409 the user could never resolve.
  if ((await s.storage.brands.getBySlug(s.slug)).value.status === "archived") return { status: 403, body: { error: messages.storedArchived(s.slug) } };
  const current = await storedCarouselRaw(s, id);
  // Cheap early refusal; the repository re-checks atomically below.
  if (current.version !== expected) return conflict(s, id);

  // The client's `status` is ignored: validate with the row's.
  const result = await validateStored(s, { ...(body as object), status: current.document.status });
  if (!result.valid) return { status: 400, body: { error: "Invalid document", details: result.errors } };

  const reason: RevisionReason = snapshot ? "snapshot" : isStructuralChange(current.document as { slides?: Array<{ kind?: string }> }, result.document) ? "structural" : "save";
  try {
    const { status: _clientStatus, ...document } = result.document;
    const saved = await s.storage.carousels.save(
      current.rowId,
      { title: result.document.title, document: { json: document, schemaVersion: 1 } },
      { expectedVersion: expected, author: "editor", source: "editor", reason },
    );
    return { status: 200, etag: etagOf(saved.version), body: { ...result.document, status: editorStatus(saved.value.status) } };
  } catch (error) {
    // The row exists (just read), so `currentVersion` is never null here: a lost race, answered with the winner's copy.
    if (error instanceof VersionConflictError) return conflict(s, id);
    if (error instanceof BrandArchivedError) return { status: 403, body: { error: messages.storedArchived(s.slug) } };
    if (error instanceof InvalidInputError) return { status: 400, body: { error: error.message } };
    throw error;
  }
}
