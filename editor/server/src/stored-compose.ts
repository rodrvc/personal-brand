import { NotFoundError } from "@personal-brand/storage/contracts";

import type { CarouselDocument } from "../../../system/ig-carousel/carousel-document.js";
import { createStorageAssetLibrary } from "../../../system/assets/storage-library.js";

import type { PlannerSource } from "./compose/planner.js";
import { DocumentStoreError } from "./document-store.js";
import { storedStyle, validateStored, type StoredBrand } from "./stored-read.js";

/** A stored brand as the planner's source: its asset rows, stored style and language; generated images go to the bucket as `candidate` assets whose row carries the former sidecar as `generation`. */
export function storedPlannerSource(s: StoredBrand): PlannerSource {
  const library = createStorageAssetLibrary({ assets: s.storage.assets, blobs: s.storage.files, brandId: s.brandId, author: "editor" });
  return {
    assets: async () => (await s.storage.assets.list(s.brandId)).map(({ value: a }) => ({ id: a.assetId, kind: a.kind, status: a.status, tags: a.tags })),
    style: () => storedStyle(s),
    language: async () => undefined, // the stored `config` language is not wired yet (S10b6)
    storeImage: async (image, spec) => {
      const generation = { prompt: spec.prompt, model: image.model, costCents: image.costCents, createdAt: new Date().toISOString(), carouselId: spec.carouselId, slot: spec.slot, ...(image.usedReferenceIds.length > 0 ? { referenceIds: image.usedReferenceIds } : {}) };
      return library.register(image.buffer, { kind: spec.kind, origin: "ai", status: "candidate", generation });
    },
    costCents: async (assetId) => Number((await s.storage.assets.get(s.brandId, assetId)).value.generation?.costCents) || 0,
  };
}

/** Where a stored carousel was last written: the row and the version the next write must name. */
export type StoredToken = { rowId: string; version: number };

/**
 * Writes a composed document (validated; the column owns `status`). With a `prev` token it saves at exactly that version
 * (a write that landed meanwhile is a 409). Without one it saves over the current version or creates the row (the first
 * write of a plan/apply; a retry repeats it like the folder's re-read).
 */
export async function persistStoredDocument(s: StoredBrand, doc: CarouselDocument, prev?: StoredToken): Promise<StoredToken> {
  const result = await validateStored(s, doc);
  if (!result.valid) throw new DocumentStoreError(`Invalid document: ${JSON.stringify(result.errors)}`);
  const { status: _status, ...json } = result.document;
  const input = { title: result.document.title, document: { json, schemaVersion: 1 } };
  const meta = (expectedVersion: number | null) => ({ expectedVersion, author: "editor", source: "editor" as const, reason: "save" as const });
  let base = prev;
  if (!base) {
    try {
      const row = await s.storage.carousels.get(s.brandId, doc.id, (body) => body);
      base = { rowId: row.id, version: row.version };
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      const created = await s.storage.carousels.create(s.brandId, { slug: doc.id, ...input }, meta(null));
      return { rowId: created.id, version: created.version };
    }
  }
  const saved = await s.storage.carousels.save(base.rowId, input, meta(base.version));
  return { rowId: base.rowId, version: saved.version };
}
