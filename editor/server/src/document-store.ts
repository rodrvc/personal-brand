import { loadBrand } from "../../../system/ig-carousel/brand-schema.js";
import {
  validateDocument,
  type CarouselDocument,
  type ValidateDocumentResult,
} from "../../../system/ig-carousel/carousel-document.js";
import { loadIndex } from "../../../system/assets/index.js";

import { assetExistsFactory } from "./render-context.js";
import type { ProfileStore } from "./profile-store.js";

/** Slug rule shared with `carousel-document.ts`'s own `id` regex, applied to the URL param before it ever reaches disk (editor-api spec: "Any carousel-id that isn't a slug is rejected"). */
const CAROUSEL_ID = /^[a-z0-9-]+$/;

export function assertValidCarouselId(id: string): void {
  if (!CAROUSEL_ID.test(id)) {
    throw new DocumentStoreError(
      `Invalid carousel id "${id}" — must match ${CAROUSEL_ID} (lowercase letters, digits, hyphens).`,
    );
  }
}

export class DocumentStoreError extends Error {}

function docRelPath(carouselId: string): string {
  return `carousels/${carouselId}/carousel.json`;
}

export function documentExists(store: ProfileStore, carouselId: string): boolean {
  assertValidCarouselId(carouselId);
  return store.exists(docRelPath(carouselId));
}

export function readDocumentRaw(store: ProfileStore, carouselId: string): unknown {
  assertValidCarouselId(carouselId);
  return store.readJson(docRelPath(carouselId));
}

export function validateAgainstProfile(store: ProfileStore, doc: unknown): ValidateDocumentResult {
  const brand = loadBrand(store.roots.profileDir);
  const index = loadIndex(store.roots.profileDir);
  return validateDocument(doc, { brand, assetExists: assetExistsFactory(index) });
}

/** Reads and validates a persisted document, throwing with the field path on corruption (should not happen for anything the API itself wrote). */
export function readValidatedDocument(store: ProfileStore, carouselId: string): CarouselDocument {
  const raw = readDocumentRaw(store, carouselId);
  const result = validateAgainstProfile(store, raw);
  if (!result.valid) {
    const [first] = result.errors;
    throw new DocumentStoreError(
      `Stored document "${carouselId}" failed validation at "${first!.path}": ${first!.message}`,
    );
  }
  return result.document;
}

export function writeDocument(store: ProfileStore, doc: CarouselDocument): void {
  assertValidCarouselId(doc.id);
  store.writeJson(docRelPath(doc.id), doc);
}

/**
 * Writes a document through `writeJsonIfRevision` instead of the plain,
 * local-only `writeDocument` above. Every write path that can run
 * concurrently with an editor PUT (a chat proposal, an export job, the
 * compose/plan endpoints) must go through here in `s3` mode: `writeDocument`
 * only touches the local mirror, so the bucket's real revision never
 * advances, and a PUT that reads the (now stale) bucket revision can
 * silently clobber this write. `fs` mode behaves exactly as `writeDocument`
 * always has, since nothing else can write between this read and this write
 * inside one synchronous request handler.
 *
 * `create: true` skips the read and requires the document not to exist yet
 * (`expectedRevision: null`) — for the "create a brand-new carousel" call
 * sites, which already checked `documentExists` themselves.
 *
 * `expectedRevision` lets a caller carry the revision it actually built
 * `doc` from (e.g. `readValidatedDocumentRevision`'s result, read once
 * before a chat proposal's generation loop or before an export job was
 * queued) instead of this function re-reading "current" right before the
 * write. Re-reading here would silently pick up whatever the bucket holds
 * *now* — including a write that landed after `doc` was built — and
 * overwrite it without a conflict ever being detected. Omitting it falls
 * back to that re-read, for callers with no earlier read to carry (or that
 * intentionally always want "whatever is current now" semantics).
 */
export async function writeDocumentThroughRevision(
  store: ProfileStore,
  doc: CarouselDocument,
  options: { create?: boolean; expectedRevision?: string | null } = {},
): Promise<string> {
  assertValidCarouselId(doc.id);
  if (options.create) {
    return store.writeJsonIfRevision(docRelPath(doc.id), doc, null);
  }
  const expectedRevision =
    options.expectedRevision !== undefined
      ? options.expectedRevision
      : ((await store.readJsonRevision(docRelPath(doc.id)))?.revision ?? null);
  return store.writeJsonIfRevision(docRelPath(doc.id), doc, expectedRevision);
}

/**
 * `readValidatedDocument` paired with the revision it was read at (the
 * bucket's real `ETag` in `s3` mode, a content hash in `fs` mode) — for a
 * caller (a chat proposal, an export job) that needs to carry that revision
 * across an `await` gap into a later `writeDocumentThroughRevision` call,
 * instead of that function re-reading "current" right before it writes.
 * Throws `DocumentStoreError` for a carousel that doesn't exist or fails
 * validation, exactly like `readValidatedDocument`.
 */
export async function readValidatedDocumentRevision(
  store: ProfileStore,
  carouselId: string,
): Promise<{ document: CarouselDocument; revision: string | null }> {
  assertValidCarouselId(carouselId);
  const current = await store.readJsonRevision(docRelPath(carouselId));
  if (!current) {
    throw new DocumentStoreError(`No carousel "${carouselId}"`);
  }
  const result = validateAgainstProfile(store, current.value);
  if (!result.valid) {
    const [first] = result.errors;
    throw new DocumentStoreError(
      `Stored document "${carouselId}" failed validation at "${first!.path}": ${first!.message}`,
    );
  }
  return { document: result.document, revision: current.revision };
}

/**
 * Reads the current document together with an opaque revision token (the
 * bucket's `ETag` in `s3` mode, read straight from the bucket rather than
 * the local mirror; a content hash in `fs` mode) — the pairing
 * `writeDocumentIfRevision` needs to refuse a write that raced against
 * another one since this read. `undefined` when the carousel doesn't exist.
 */
export async function readDocumentRevision(
  store: ProfileStore,
  carouselId: string,
): Promise<{ value: unknown; revision: string } | undefined> {
  assertValidCarouselId(carouselId);
  return store.readJsonRevision(docRelPath(carouselId));
}

/**
 * Writes the document only if its current revision still matches
 * `expectedRevision` (or, when `null`, only if it doesn't exist yet) —
 * the PUT route's stale-copy 409 today, and in `s3` mode also a real
 * guard against two server instances racing on the same carousel.
 * Throws `RevisionConflictError` (from `profile-store.ts`) otherwise.
 */
export async function writeDocumentIfRevision(
  store: ProfileStore,
  doc: CarouselDocument,
  expectedRevision: string | null,
): Promise<string> {
  assertValidCarouselId(doc.id);
  return store.writeJsonIfRevision(docRelPath(doc.id), doc, expectedRevision);
}

/**
 * Snapshots the current on-disk document to `carousels/<id>/versions/<ISO
 * timestamp>.json` (specs/carousel-document, "Internal document versions").
 * No-ops if the document doesn't exist yet (nothing to snapshot for a
 * brand-new carousel).
 */
export function snapshotDocument(store: ProfileStore, carouselId: string): string | undefined {
  assertValidCarouselId(carouselId);
  if (!documentExists(store, carouselId)) return undefined;
  const current = readDocumentRaw(store, carouselId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const relPath = `carousels/${carouselId}/versions/${stamp}.json`;
  store.writeJson(relPath, current);
  return relPath;
}

export interface CarouselListingEntry {
  id: string;
  title: string;
  status: CarouselDocument["status"];
  updatedAt: string;
  slideCount: number;
}

/** Listing per specs/carousel-document's "Listing for a future gallery": id, title, status, updatedAt, slide count. */
export function listCarousels(store: ProfileStore): CarouselListingEntry[] {
  const entries = store.list("carousels");
  const out: CarouselListingEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !CAROUSEL_ID.test(entry.name)) continue;
    if (!documentExists(store, entry.name)) continue;
    try {
      const doc = readValidatedDocument(store, entry.name);
      out.push({
        id: doc.id,
        title: doc.title,
        status: doc.status,
        updatedAt: doc.updatedAt,
        slideCount: doc.slides.length,
      });
    } catch {
      // A corrupt document is skipped from the listing rather than
      // breaking the whole list — the per-carousel GET route will still
      // surface the real validation error if someone opens it directly.
      continue;
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Every version file's ISO timestamp for a carousel, most recent first (editor-api spec's "listing versions"). */
export function listVersions(store: ProfileStore, carouselId: string): string[] {
  assertValidCarouselId(carouselId);
  const entries = store.list(`carousels/${carouselId}/versions`);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.replace(/\.json$/, ""))
    .sort()
    .reverse();
}
