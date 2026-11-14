import { createHash } from "node:crypto";

import { putBlob } from "@personal-brand/storage/blob";
import { AlreadyExistsError, type Asset, type AssetRepository, type BlobStore, type Versioned } from "@personal-brand/storage/contracts";

import { detectImage, storageAssetEntrySchema, type AssetLibrary, type StorageAssetEntry } from "./index.js";

export interface StorageAssetLibraryOptions {
  assets: AssetRepository;
  blobs: BlobStore;
  brandId: string;
  author?: string;
}

/** Storage entries have a `blobKey` and no `path`: there is no file on disk. */
function toEntry(row: Versioned<Asset>): StorageAssetEntry {
  const a = row.value;
  return storageAssetEntrySchema.parse({
    id: a.assetId,
    blobKey: a.blobKey,
    sha256: a.sha256,
    kind: a.kind,
    mime: a.mime,
    ...(a.width ? { w: a.width } : {}),
    ...(a.height ? { h: a.height } : {}),
    bytes: a.bytes,
    origin: a.origin,
    status: a.status,
    tags: a.tags,
    createdAt: a.createdAt,
    ...(a.family ? { family: a.family } : {}),
  });
}

/**
 * The asset library on `AssetRepository` + blobs (no `index.json`, no sidecars). Blob first, then the row:
 * an orphan blob after a failed row insert is harmless (content addressed) and can be collected later.
 */
export function createStorageAssetLibrary(options: StorageAssetLibraryOptions): AssetLibrary {
  const { assets, blobs, brandId } = options;
  const meta = (expectedVersion: number | null, reason: "save" | "structural") => ({
    expectedVersion,
    author: options.author ?? "system:assets",
    source: "system" as const,
    reason,
  });

  return {
    list: async () => (await assets.list(brandId)).map(toEntry),

    async register(content, opts = {}) {
      // `destRelPath` is only a file-name hint here: it decides the mime of non-image files.
      const detected = detectImage(content, opts.destRelPath ?? "");
      const origin = opts.origin ?? "manual";
      const { sha256 } = await putBlob(blobs, brandId, content, detected.mime);
      try {
        return toEntry(
          await assets.register(
            brandId,
            {
              sha256,
              kind: opts.kind ?? (detected.mime.startsWith("font/") ? "font" : "unclassified"),
              mime: detected.mime,
              bytes: content.byteLength,
              origin,
              status: opts.status ?? (origin === "ai" ? "candidate" : "approved"),
              tags: opts.tags ?? [],
              ...(detected.w ? { width: detected.w } : {}),
              ...(detected.h ? { height: detected.h } : {}),
              ...(opts.family ? { family: opts.family } : {}),
              ...(opts.generation ? { generation: opts.generation } : {}),
            },
            meta(null, "save"),
          ),
        );
      } catch (error) {
        // Same bytes twice: the existing entry wins, untouched (as in the folder library).
        if (!(error instanceof AlreadyExistsError)) throw error;
        return toEntry(await assets.get(brandId, createHash("sha256").update(content).digest("hex").slice(0, 16)));
      }
    },

    /** Last writer wins: it re-reads the current version, so a concurrent classification change is overwritten, not rejected. */
    async update(id, changes) {
      const current = await assets.get(brandId, id);
      return toEntry(await assets.update(brandId, id, changes, meta(current.version, "structural")));
    },

    async read(id) {
      return (await blobs.get((await assets.get(brandId, id)).value.blobKey)).body;
    },
  };
}
