import { BlobCache, blobStoreFromEnv } from "@personal-brand/storage/blob";
import { connect, createPgRepositories } from "@personal-brand/storage/pg";

import type { EditorStorage } from "./stored-read.js";

/**
 * Opens the stored side of the editor's read path: Postgres from `DATABASE_URL` and the bucket from `S3_*` (the same
 * variables the CLI and the reel engine read). With no `DATABASE_URL` it opens nothing and every brand is a folder,
 * exactly as before storage. Stored brands need the bucket too, so a database without one is refused at start.
 *
 * One bucket holds both worlds without collisions: stored blobs and exports live under `brands/<brandId>/` (storage's
 * `keys.ts`), the legacy mirror (#99, `STORAGE_BACKEND=s3`) under `<S3_PREFIX><slug>/` with `S3_PREFIX` defaulting to
 * `profiles/`. They could only meet if someone set `S3_PREFIX=brands/` and named a brand after a brand id; do not.
 */
export function openEditorStorage(env: NodeJS.ProcessEnv = process.env): { storage: EditorStorage; close(): Promise<void> } | undefined {
  if (!env.DATABASE_URL) return undefined;
  const store = blobStoreFromEnv(env);
  if (!store) throw new Error("DATABASE_URL is set but the bucket is not: set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.");
  const sql = connect(env);
  const repos = createPgRepositories(sql);
  return {
    storage: { brands: repos.brands, documents: repos.documents, assets: repos.assets, carousels: repos.carousels, blobs: (brandId) => new BlobCache(store, brandId) },
    close: () => sql.end(),
  };
}
