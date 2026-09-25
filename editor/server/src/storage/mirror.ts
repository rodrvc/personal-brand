import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

import type { ObjectStore } from "./object-store.js";
import { ObjectNotFoundError, PreconditionFailedError } from "./object-store.js";
import type { S3StorageConfig } from "./config.js";

/**
 * The local working copy of a profile living in an S3-compatible bucket
 * (issue #99). The bucket is the source of truth; every path-based tool in
 * this repo (render, image prep, `system/ig-carousel`, `system/assets`)
 * still reads and writes plain files, so `syncDown` pulls a profile's
 * objects into a local mirror before anything reads it, and `syncUp` pushes
 * back whatever a "bypass" writer (Playwright's export PNGs, the asset
 * index) put directly into that mirror.
 *
 * Mirror layout, rooted at `<PROFILE_CACHE_DIR>/<bucket>/`:
 *   profiles/<slug>/          <- BRAND_PROFILES_DIR points here
 *   outputs/<slug>/           <- BRAND_OUTPUTS_ROOT points here
 *
 * Object key layout, rooted at `<S3_PREFIX>`:
 *   <prefix><slug>/<relPath>            <- a profile file
 *   <prefix><slug>/_outputs/<relPath>   <- a resolved-output file
 *
 * A per-slug manifest (`<PROFILE_CACHE_DIR>/<bucket>/.manifests/<slug>.json`,
 * deliberately outside both mirrored trees so it is never itself swept up
 * by `syncUp`) records, per object key, the remote etag last seen and the
 * local content hash last synced — the two independent facts that decide
 * whether a `syncDown`/`syncUp` pass has anything to do.
 *
 * Every manifest write below is a synchronous read-patch-save
 * (`patchManifestEntry`) rather than a load-once/save-once-at-the-end: the
 * latter let a `syncDown`/`syncUp` in progress silently revert a concurrent
 * writer's manifest entry when it finally saved its own stale in-memory
 * copy, and let `syncUp` re-upload a local file unconditionally even when
 * the bucket had a newer write this manifest never saw.
 */

export interface ManifestEntry {
  etag: string;
  hash: string;
}

export type Manifest = Record<string, ManifestEntry>;

export interface MirrorRoots {
  profileMirrorRoot: string;
  outputsMirrorRoot: string;
  profileDir: string;
  outputsDir: string;
  manifestPath: string;
}

const OUTPUTS_MARKER = "_outputs/";

export function resolveMirrorRoots(config: S3StorageConfig, cacheDir: string, slug: string): MirrorRoots {
  const bucketRoot = join(cacheDir, config.bucket);
  const profileMirrorRoot = join(bucketRoot, "profiles");
  const outputsMirrorRoot = join(bucketRoot, "outputs");
  return {
    profileMirrorRoot,
    outputsMirrorRoot,
    profileDir: join(profileMirrorRoot, slug),
    outputsDir: join(outputsMirrorRoot, slug),
    manifestPath: join(bucketRoot, ".manifests", `${slug}.json`),
  };
}

/** The object key for a profile or output file, given its path relative to whichever mirror root it lives under. Shared with the migration script so both compute the exact same key layout. */
export function objectKeyFor(config: S3StorageConfig, slug: string, area: "profile" | "outputs", relPath: string): string {
  const posixRel = relPath.split(sep).join("/");
  return area === "profile"
    ? `${config.prefix}${slug}/${posixRel}`
    : `${config.prefix}${slug}/${OUTPUTS_MARKER}${posixRel}`;
}

function loadManifest(manifestPath: string): Manifest {
  if (!existsSync(manifestPath)) return {};
  try {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest;
  } catch {
    return {};
  }
}

function saveManifest(manifestPath: string, manifest: Manifest): void {
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/** Loads the manifest fresh, sets one entry, and saves it back — synchronous start to finish, so it can never race a concurrent caller of this same function. */
function patchManifestEntry(manifestPath: string, key: string, entry: ManifestEntry): void {
  const manifest = loadManifest(manifestPath);
  manifest[key] = entry;
  saveManifest(manifestPath, manifest);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function listLocalFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile()) {
        results.push(abs);
      }
    }
  };
  walk(root);
  return results;
}

/**
 * Downloads every object under `<prefix><slug>/` whose remote etag differs
 * from the manifest into the local mirror, and records the new etag/hash.
 * Never deletes a local file that disappeared remotely — this is hydration,
 * not a mirror reset, so it can't destroy a bypass writer's in-flight work.
 */
export async function syncDown(
  store: ObjectStore,
  config: S3StorageConfig,
  cacheDir: string,
  slug: string,
): Promise<void> {
  const roots = resolveMirrorRoots(config, cacheDir, slug);
  const remotePrefix = `${config.prefix}${slug}/`;
  const objects = await store.list(remotePrefix);
  // A snapshot for the cheap "did this change remotely" check only — the
  // actual write below re-reads and patches the manifest fresh, so a stale
  // snapshot here can cause a redundant re-download at worst, never a lost
  // update.
  const manifestSnapshot = loadManifest(roots.manifestPath);

  for (const object of objects) {
    if (manifestSnapshot[object.key]?.etag === object.etag) continue;

    const isOutput = object.key.startsWith(`${remotePrefix}${OUTPUTS_MARKER}`);
    const relPath = isOutput
      ? object.key.slice((remotePrefix + OUTPUTS_MARKER).length)
      : object.key.slice(remotePrefix.length);
    if (!relPath) continue;

    const localPath = join(isOutput ? roots.outputsDir : roots.profileDir, relPath);
    const { body } = await store.get(object.key);
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, body);
    patchManifestEntry(roots.manifestPath, object.key, { etag: object.etag, hash: sha256(body) });
  }
}

/**
 * Uploads every local mirror file whose content hash differs from the
 * manifest's last-synced hash — the catch-all for writers that touch the
 * mirror directly instead of going through a bucket-aware write path (the
 * asset index, Playwright's export PNGs). Never deletes a remote object:
 * a file that disappeared locally is left alone in the bucket.
 *
 * Every upload is a real conditional `PutObject`: `ifMatch` against the
 * manifest's last-seen etag when one is on record, `ifNoneMatch: "*"` when
 * it isn't (including a missing/corrupt manifest — "no entry" is never
 * treated as "safe to overwrite unconditionally"). A precondition failure
 * means the bucket has a newer write this manifest never saw; that local
 * file is left alone rather than clobbering it.
 */
export async function syncUp(
  store: ObjectStore,
  config: S3StorageConfig,
  cacheDir: string,
  slug: string,
): Promise<void> {
  const roots = resolveMirrorRoots(config, cacheDir, slug);
  const manifestSnapshot = loadManifest(roots.manifestPath);

  const areas: Array<["profile" | "outputs", string]> = [
    ["profile", roots.profileDir],
    ["outputs", roots.outputsDir],
  ];

  for (const [area, root] of areas) {
    for (const absPath of listLocalFiles(root)) {
      const relPath = relative(root, absPath);
      const key = objectKeyFor(config, slug, area, relPath);
      const content = readFileSync(absPath);
      const hash = sha256(content);
      const entry = manifestSnapshot[key];
      if (entry?.hash === hash) continue;

      try {
        const result = entry
          ? await store.put(key, content, { ifMatch: entry.etag })
          : await store.put(key, content, { ifNoneMatch: "*" });
        const nextEntry = { etag: result.etag, hash };
        patchManifestEntry(roots.manifestPath, key, nextEntry);
        manifestSnapshot[key] = nextEntry;
      } catch (error) {
        if (error instanceof PreconditionFailedError) {
          console.warn(`syncUp: "${key}" changed remotely since the last sync for profile "${slug}" — not overwriting; the next syncDown will pick up the remote copy.`);
          continue;
        }
        throw error;
      }
    }
  }
}

const lastSyncedAt = new Map<string, number>();
const DEFAULT_TTL_MS = 3000;

/** Calls `syncDown` for `slug` only if it hasn't run in the last `ttlMs` — the "first access, then at most every few seconds" hydration policy. */
export async function hydrateIfStale(
  store: ObjectStore,
  config: S3StorageConfig,
  cacheDir: string,
  slug: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<void> {
  const last = lastSyncedAt.get(slug) ?? 0;
  const now = Date.now();
  if (now - last < ttlMs) return;
  await syncDown(store, config, cacheDir, slug);
  lastSyncedAt.set(slug, now);
}

/** Test-only: clears the hydration TTL cache between test cases. */
export function resetHydrationCache(): void {
  lastSyncedAt.clear();
}

/** Lists profile slugs directly from the bucket (s3-mode `listProfiles`), by the top-level "directories" under the configured prefix. */
export async function listProfileSlugsFromBucket(store: ObjectStore, config: S3StorageConfig): Promise<string[]> {
  const objects = await store.list(config.prefix);
  const slugs = new Set<string>();
  for (const object of objects) {
    const rest = object.key.slice(config.prefix.length);
    const slug = rest.split("/")[0];
    if (slug) slugs.add(slug);
  }
  return [...slugs].sort();
}

/** True when `<prefix><slug>/brand.json` exists in the bucket. */
export async function bucketHasBrand(store: ObjectStore, config: S3StorageConfig, slug: string): Promise<boolean> {
  try {
    await store.head(`${config.prefix}${slug}/brand.json`);
    return true;
  } catch (error) {
    if (error instanceof ObjectNotFoundError) return false;
    throw error;
  }
}

/** True when a local mirror path exists inside a directory tree — used only by tests to assert on-disk state. */
export function existsInMirror(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
