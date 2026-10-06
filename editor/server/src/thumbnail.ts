import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import sharp from "sharp";

import { loadIndexCached } from "./asset-index-cache.js";
import type { ProfileStore } from "./profile-store.js";

/**
 * On-demand WebP thumbnails for the Bucket pane's asset grid, so opening
 * the tab never downloads every full-size original.
 *
 * The cache lives OUTSIDE the profile: in `s3` storage mode the profile
 * directory is the local bucket mirror, and `storage/mirror.ts`'s `syncUp`
 * uploads everything under it, so a cache there would be pushed to the
 * bucket as ordinary profile objects. Same pattern as
 * `storage/config.ts`'s `PROFILE_CACHE_DIR`: an OS temp directory,
 * overridable by env var, keyed by profile slug. Entirely rebuildable.
 *
 * The cache key is the asset's content hash — the asset index entry's `id`
 * (a sha256 prefix of the file's bytes) — plus the width, so a cache hit
 * never touches the original (no read, no on-demand bucket hydration) and a
 * re-uploaded file with different bytes misses instead of serving a stale
 * thumbnail. A file the index doesn't know yet falls back to hashing its
 * bytes. Widths snap to a few fixed sizes so `?w=` can't mint unbounded
 * cache entries.
 */

export const THUMB_WIDTHS = [128, 256, 512] as const;
const DEFAULT_WIDTH = 256;

const THUMB_CACHE_ROOT = process.env.EDITOR_THUMB_CACHE_DIR || join(tmpdir(), "personal-brand-editor-thumbs-cache");

/** Parses `?w=` and snaps it up to the nearest of `THUMB_WIDTHS` (capped at the largest); a missing/invalid value falls back to the default rather than rejecting the request. */
export function resolveThumbWidth(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = value ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WIDTH;
  return THUMB_WIDTHS.find((width) => width >= n) ?? THUMB_WIDTHS[THUMB_WIDTHS.length - 1]!;
}

/** Absolute path for a cached thumbnail. */
export function thumbCachePath(slug: string, contentHash: string, width: number): string {
  return join(THUMB_CACHE_ROOT, slug, `${contentHash}-w${width}.webp`);
}

/**
 * The content hash a thumbnail is cached under. Confines the path first
 * (`resolveInProfile` throws `ProfileStoreError` on a traversal, before
 * anything is read), then prefers the index entry's id over reading the
 * file.
 */
async function thumbContentHash(store: ProfileStore, relPathUnderAssets: string): Promise<string> {
  const relPath = `assets/${relPathUnderAssets}`;
  store.resolveInProfile(relPath);
  try {
    const entry = loadIndexCached(store.roots.profileDir).entries.find((e) => e.path === relPath);
    if (entry) return entry.id;
  } catch {
    // No readable index yet — hash the bytes instead.
  }
  const original = await store.readFileAsync(relPath);
  return createHash("sha256").update(original).digest("hex").slice(0, 16);
}

/** Where `getOrCreateThumbnail` caches this asset at this width — for tests and diagnostics, so nothing outside this module re-derives the key. */
export async function resolveThumbCachePath(
  store: ProfileStore,
  relPathUnderAssets: string,
  width: number,
): Promise<string> {
  return thumbCachePath(store.slug, await thumbContentHash(store, relPathUnderAssets), width);
}

/**
 * Resolves (generating and caching on a miss) a ~`width`px WebP thumbnail
 * for the asset at `relPathUnderAssets` (e.g. `"generated/7f3a…9c.png"`).
 * The original is read only on a miss, through `store.readFileAsync` —
 * the same confinement and on-demand hydration as the plain files route.
 * The cache file itself lives outside `ProfileStore`'s roots by design, so
 * it is written with plain `fs`: to a temp name first, then renamed, so a
 * concurrent request never reads a half-written file.
 */
export async function getOrCreateThumbnail(
  store: ProfileStore,
  relPathUnderAssets: string,
  width: number,
): Promise<Buffer> {
  const cachePath = await resolveThumbCachePath(store, relPathUnderAssets, width);
  try {
    return await readFile(cachePath);
  } catch {
    // Miss — generate below.
  }

  const original = await store.readFileAsync(`assets/${relPathUnderAssets}`);
  const thumbnail = await sharp(original)
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 72 })
    .toBuffer();
  await mkdir(dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, thumbnail);
    await rename(tempPath, cachePath);
  } catch {
    // Caching is best-effort: the thumbnail is still served.
    await rm(tempPath, { force: true });
  }
  return thumbnail;
}
