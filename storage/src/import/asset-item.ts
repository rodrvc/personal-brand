import { putBlob } from "../blob/put-blob.ts";
import { blobKey, InvalidInputError, ObjectNotFoundError, type AssetKind, type AssetOrigin, type AssetStatus, type BlobStore } from "../contracts/index.ts";
import { canon, found, sha256, type CollectContext, type Item } from "./shared.ts";

/** Everything the importer decides about one asset before it is registered. */
export interface AssetSpec {
  /** First 16 hex of `sha`: the asset id. */
  id: string;
  sha: string;
  bytes: Buffer;
  mime: string;
  kind: AssetKind;
  origin: AssetOrigin;
  status: AssetStatus;
  tags: string[];
  family?: string;
  generation: Record<string, unknown> | null;
  /** Best-effort: filled at registration only, never compared afterwards (cache drift can neither conflict nor dirty verification). */
  width?: number | null;
  height?: number | null;
  /** A batch render may only create a row or update one that is already a hidden, unclassified, manual batch asset: it never hides an asset registered anywhere else. */
  adoptOnly?: boolean;
  /** What the item hash is made of besides the content (sidecars, extra tags): a change in any of them is an update. */
  hashParts: string[];
}

/**
 * The one way an asset becomes an import item: blob first (`putBlob`, content-addressed), then the row; an update
 * moves only what a user can reclassify (keep in step with `AssetPatch`); `verifyBlobs` re-downloads and hashes the blob.
 */
export function assetItem({ repos, blobs }: Pick<CollectContext, "repos" | "blobs">, s: AssetSpec): Item {
  const { id, sha, bytes, mime, kind, origin, status, tags, family, generation, width, height } = s;
  const row = { sha256: sha, kind, mime, bytes: bytes.length, origin, status, tags, family: family ?? null, generation };
  return {
    key: `asset:${id}`, entityType: "brand_asset",
    hash: sha256([sha, ...s.hashParts].join("\n")),
    payload: row,
    read: async (brandId) => {
      const a = await found(repos.assets.get(brandId, id));
      return a && { id: a.id, version: a.version, value: { sha256: a.value.sha256, kind: a.value.kind, mime: a.value.mime, bytes: a.value.bytes, origin: a.value.origin, status: a.value.status, tags: a.value.tags, family: a.value.family, generation: a.value.generation } };
    },
    write: async (brandId, expectedVersion, meta) => {
      if (expectedVersion !== null) {
        // Only what a user can reclassify moves. Everything else is fixed at registration, so a difference is reported instead
        // of stored: the item hash would otherwise move without the row and verification would stay dirty. That includes `origin`
        // and `mime`: moving a file into references/ or generated/, or renaming its extension, is a conflict by design.
        const current = (await repos.assets.get(brandId, id)).value as unknown as Record<string, unknown>;
        const fixed: Record<string, unknown> = { sha256: sha, mime, bytes: bytes.length, origin, generation };
        const changed = [...Object.keys(fixed).filter((k) => canon(current[k] ?? null) !== canon(fixed[k] ?? null)), ...(current.family && !family ? ["family"] : [])];
        if (s.adoptOnly && (current.status !== "hidden" || current.kind !== "unclassified" || current.origin !== "manual")) throw new InvalidInputError(`asset ${id}: registered outside a batch; a batch would hide it`);
        if (changed.length) throw new InvalidInputError(`asset ${id}: ${changed.join(", ")} changed in the folder; registered fields cannot be updated`);
        return repos.assets.update(brandId, id, { kind, tags, status, ...(family ? { family } : {}) }, { ...meta, expectedVersion });
      }
      await putBlob(blobs as BlobStore, brandId, bytes, mime);
      return repos.assets.register(brandId, { sha256: sha, kind, mime, bytes: bytes.length, origin, status, tags, ...(width ? { width } : {}), ...(height ? { height } : {}), ...(family ? { family } : {}), ...(generation ? { generation } : {}) }, { ...meta, expectedVersion: null });
    },
    verifyBlobs: async (brandId) => {
      try {
        return sha256((await (blobs as BlobStore).get(blobKey(brandId, sha))).body) === sha;
      } catch (error) {
        if (error instanceof ObjectNotFoundError) return false;
        throw error;
      }
    },
  };
}
