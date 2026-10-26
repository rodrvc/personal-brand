import { BrandArchivedError, NotFoundError } from "@personal-brand/storage/contracts";

import type { CarouselDocument } from "../../../system/ig-carousel/carousel-document.js";
import { createStorageAssetLibrary } from "../../../system/assets/storage-library.js";

import type { PlannerSource } from "./compose/planner.js";
import { DocumentStoreError } from "./document-store.js";
import { storedStyle, validateStored, type StoredBrand } from "./stored-read.js";

/** The stored `config` document's `profile.primary_language` (the importer stores config.yaml parsed as JSON); undefined when there is no config or no language. */
async function storedLanguage(s: StoredBrand): Promise<string | undefined> {
  try {
    const config = (await s.storage.documents.get(s.brandId, "config", "", (body) => body)).value as { profile?: { primary_language?: unknown } } | null;
    const language = config?.profile?.primary_language;
    return typeof language === "string" && language.trim() ? language.trim() : undefined;
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}

/** A stored brand as the planner's source: its asset rows, stored style and copy language; generated images go to the bucket as `candidate` assets whose row carries the former sidecar as `generation`. */
export function storedPlannerSource(s: StoredBrand): PlannerSource {
  const library = createStorageAssetLibrary({ assets: s.storage.assets, blobs: s.storage.files, brandId: s.brandId, author: "editor" });
  return {
    assets: async () => (await s.storage.assets.list(s.brandId)).map(({ value: a }) => ({ id: a.assetId, kind: a.kind, status: a.status, tags: a.tags })),
    style: () => storedStyle(s),
    language: () => storedLanguage(s),
    storeImage: async (image, spec) => {
      const generation = { prompt: spec.prompt, model: image.model, costCents: image.costCents, createdAt: new Date().toISOString(), carouselId: spec.carouselId, slot: spec.slot, ...(image.usedReferenceIds.length > 0 ? { referenceIds: image.usedReferenceIds } : {}) };
      return library.register(image.buffer, { kind: spec.kind, origin: "ai", status: "candidate", generation });
    },
    costCents: async (assetId) => {
      try { return Number((await s.storage.assets.get(s.brandId, assetId)).value.generation?.costCents) || 0; } catch (error) { if (error instanceof NotFoundError) return 0; throw error; }
    },
  };
}

/** Refuses a write to an archived brand (403), for the routes that generate before they save and so cannot wait for the repository to refuse. */
export async function assertWritable(s: StoredBrand): Promise<void> {
  if ((await s.storage.brands.getBySlug(s.slug)).value.status === "archived") throw new BrandArchivedError(s.slug);
}

/** Where a stored carousel was last written: the row and the version the next write must name. */
export type StoredToken = { rowId: string; version: number };

/**
 * Writes a composed document (validated; the column owns `status`). With a `prev` token it saves at exactly that version
 * (a write that landed meanwhile is a VersionConflictError). Without one it only creates the row (`expectedVersion: null`;
 * a carousel that exists is an `AlreadyExistsError`, a conflict): that is the first write of a plan/apply. Every later
 * write, and a retry (which resumes from the token the apply kept), names a version, so nothing the user saved or created
 * in between is ever overwritten.
 */
export async function persistStoredDocument(s: StoredBrand, doc: CarouselDocument, prev?: StoredToken, reason: "save" | "snapshot" = "save"): Promise<StoredToken> {
  const result = await validateStored(s, doc);
  if (!result.valid) throw new DocumentStoreError(`Invalid document: ${JSON.stringify(result.errors)}`);
  const { status: _status, ...json } = result.document;
  const input = { title: result.document.title, document: { json, schemaVersion: 1 } };
  const meta = (expectedVersion: number | null) => ({ expectedVersion, author: "editor", source: "editor" as const, reason });
  if (!prev) {
    const created = await s.storage.carousels.create(s.brandId, { slug: doc.id, ...input }, meta(null));
    return { rowId: created.id, version: created.version };
  }
  const base = prev;
  const saved = await s.storage.carousels.save(base.rowId, input, meta(base.version));
  return { rowId: base.rowId, version: saved.version };
}
