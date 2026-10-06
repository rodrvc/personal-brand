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
export const CAROUSEL_ID = /^[a-z0-9-]+$/;

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

const KNOWN_STATUSES: readonly CarouselDocument["status"][] = ["draft", "exported", "published"];

/**
 * The few fields every cheap, display-only reader needs from a
 * `carousel.json`, read raw — no `readValidatedDocument`, which also
 * reloads the brand and rescans the whole asset index per document (to
 * check every color/asset reference). On a 72-carousel profile that full
 * validation took the listing route from single-digit milliseconds to ~5s.
 * `slides` is the raw, unvalidated array: callers only count it or read
 * defensively from it.
 */
export interface CarouselHeader {
  id: string;
  title: string;
  status: CarouselDocument["status"];
  updatedAt: string;
  slides: unknown[];
}

/**
 * The one raw reader behind the carousel listing, the profile picker's
 * brand card and the library-ratio history, so all three agree on which
 * carousels exist. `undefined` (the caller skips it) for a directory name
 * that isn't a carousel id, a missing or unreadable file, a document whose
 * own `id` is not its directory name (the id the listing links to must be
 * the one the per-carousel routes resolve), an `updatedAt` that doesn't
 * parse as a date (it orders every listing), or any of the five shown
 * fields missing or mistyped.
 */
export function readCarouselHeader(store: ProfileStore, id: string): CarouselHeader | undefined {
  if (!CAROUSEL_ID.test(id)) return undefined;
  try {
    if (!store.exists(docRelPath(id))) return undefined;
    const raw = store.readJson<{
      id?: unknown;
      title?: unknown;
      status?: unknown;
      updatedAt?: unknown;
      slides?: unknown;
    }>(docRelPath(id));
    if (
      !raw ||
      raw.id !== id ||
      typeof raw.title !== "string" ||
      typeof raw.updatedAt !== "string" ||
      Number.isNaN(Date.parse(raw.updatedAt)) ||
      !Array.isArray(raw.slides) ||
      !KNOWN_STATUSES.includes(raw.status as CarouselDocument["status"])
    ) {
      return undefined;
    }
    return {
      id,
      title: raw.title,
      status: raw.status as CarouselDocument["status"],
      updatedAt: raw.updatedAt,
      slides: raw.slides,
    };
  } catch {
    // A corrupt document is skipped rather than breaking the whole list —
    // the per-carousel GET route still surfaces the real validation error
    // if someone opens it directly.
    return undefined;
  }
}

/**
 * Listing per specs/carousel-document's "Listing for a future gallery": id,
 * title, status, updatedAt, slide count — read through `readCarouselHeader`
 * (raw, shape-checked only), keyed by the directory name.
 */
export function listCarousels(store: ProfileStore): CarouselListingEntry[] {
  const out: CarouselListingEntry[] = [];
  for (const entry of store.list("carousels")) {
    if (!entry.isDirectory()) continue;
    const header = readCarouselHeader(store, entry.name);
    if (!header) continue;
    out.push({
      id: header.id,
      title: header.title,
      status: header.status,
      updatedAt: header.updatedAt,
      slideCount: header.slides.length,
    });
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
