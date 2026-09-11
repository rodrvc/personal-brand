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
