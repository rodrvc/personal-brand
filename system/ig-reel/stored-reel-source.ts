/** Opens the stored side of a reel render: Postgres, the bucket and the blob cache. Kept apart from `stored-reel.ts`, which stays pure of both. */

import { BlobCache, blobStoreFromEnv } from "@personal-brand/storage/blob";
import { connect, createPgRepositories } from "@personal-brand/storage/pg";

import { resolveRenderSource, type RenderSource } from "../ig-carousel/render-source.js";
import type { ReelStorage } from "./stored-reel.js";

/**
 * Opens the brand the way the carousel does (`resolveRenderSource`: no `DATABASE_URL` is a folder, exactly as before).
 * A stored brand also needs the bucket (`S3_*`, as the editor and the CLI read them) and the local blob cache.
 */
export async function openReelSource(slug: string, env: NodeJS.ProcessEnv = process.env): Promise<{ source: RenderSource; storage?: ReelStorage; close(): Promise<void> }> {
  if (!env.DATABASE_URL) return { source: await resolveRenderSource(slug), close: async () => {} };
  const sql = connect(env);
  try {
    const repos = createPgRepositories(sql);
    const source = await resolveRenderSource(slug, repos);
    if (source.kind === "folder") return { source, close: () => sql.end() };
    const store = blobStoreFromEnv(env);
    if (!store) throw new Error(`Brand "${slug}" is served from storage: set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.`);
    const brandId = (await repos.brands.getBySlug(slug)).id;
    const storage: ReelStorage = { brandId, recipes: repos.recipes, assets: repos.assets, runs: repos.runs, artifacts: repos.runArtifacts, tts: repos.tts, store, cache: new BlobCache(store, brandId) };
    return { source, storage, close: () => sql.end() };
  } catch (error) {
    await sql.end();
    throw error;
  }
}
