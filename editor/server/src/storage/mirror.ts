import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

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

/** Rejects a relative path that could escape its mirror root — `..` segments, an absolute path, or a null byte — before it is ever joined onto a local directory. `syncDown` derives `relPath` straight from a remote object key, so a bucket returning a hostile key must not be trusted to stay inside the mirror. */
function assertSafeRelPath(relPath: string): void {
  if (isAbsolute(relPath)) {
    throw new Error(`Refusing an absolute path from a remote key: "${relPath}"`);
  }
  const segments = relPath.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`Refusing a path that escapes its root with "..": "${relPath}"`);
  }
  if (relPath.includes("\0")) {
    throw new Error(`Refusing a path with a null byte: "${relPath}"`);
  }
}

/** Defence in depth behind `assertSafeRelPath`: the resolved local path must still land inside `root` once symlink-free path math is done. */
function assertWithinRoot(candidate: string, root: string): void {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rootWithSep = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(rootWithSep)) {
    throw new Error(`Refusing a path that resolves outside the mirror root: "${candidate}"`);
  }
}

/** True when `localPath` already has content that hasn't been synced up yet — a local edit `syncDown` must not clobber. A missing manifest entry for an existing local file is treated the same as a known mismatch (unknown provenance, never assumed safe to overwrite). */
function hasUnsyncedLocalEdit(localPath: string, manifestEntry: ManifestEntry | undefined): boolean {
  if (!existsSync(localPath)) return false;
  if (!manifestEntry) return true;
  return sha256(readFileSync(localPath)) !== manifestEntry.hash;
}

/**
 * Large, rarely-needed-on-open media under a resolved output's `_outputs/`
 * area (a rendered image/video) is excluded from eager `syncDown` by
 * default, fetched on demand instead via `fetchObjectOnDemand` — so opening
 * a profile for the first time doesn't pull its whole export history
 * before the editor can even show a carousel list. Generic (no brand
 * literal) and overridable via `S3_MIRROR_LAZY_MEDIA_EXTENSIONS`.
 */
export const DEFAULT_LAZY_MEDIA_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".mp4", ".mov", ".m4v"];

function isLazyOutput(relPath: string, config: S3StorageConfig): boolean {
  const extensions = config.lazyMediaExtensions ?? DEFAULT_LAZY_MEDIA_EXTENSIONS;
  const lower = relPath.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

export interface SyncDownResult {
  downloaded: number;
  /** A remote object whose local counterpart had an unsynced edit, or whose key failed the path-safety check — skipped rather than overwritten or fetched. */
  conflicts: number;
  /** A remote object matched the lazy-media rule and was left for `fetchObjectOnDemand` to pull later. */
  skippedLazy: number;
}

const inFlightSyncDown = new Map<string, Promise<SyncDownResult>>();

/**
 * Downloads every non-lazy object under `<prefix><slug>/` whose remote etag
 * differs from the manifest into the local mirror, and records the new
 * etag/hash. Never deletes a local file that disappeared remotely — this is
 * hydration, not a mirror reset, so it can't destroy a bypass writer's
 * in-flight work.
 *
 * At most one `syncDown` per (cache dir, bucket, slug) runs at a time — a
 * second caller while one is already in flight (e.g. two requests for the
 * same profile landing back to back through `hydrateIfStale`) is handed the
 * same in-flight promise instead of starting a redundant full listing.
 */
export async function syncDown(
  store: ObjectStore,
  config: S3StorageConfig,
  cacheDir: string,
  slug: string,
): Promise<SyncDownResult> {
  const dedupeKey = `${cacheDir}\u0000${config.bucket}\u0000${slug}`;
  const existing = inFlightSyncDown.get(dedupeKey);
  if (existing) return existing;

  const promise = runSyncDown(store, config, cacheDir, slug).finally(() => {
    inFlightSyncDown.delete(dedupeKey);
  });
  inFlightSyncDown.set(dedupeKey, promise);
  return promise;
}

async function runSyncDown(
  store: ObjectStore,
  config: S3StorageConfig,
  cacheDir: string,
  slug: string,
): Promise<SyncDownResult> {
  const roots = resolveMirrorRoots(config, cacheDir, slug);
  const remotePrefix = `${config.prefix}${slug}/`;
  const objects = await store.list(remotePrefix);
  // A snapshot for the cheap "did this change remotely" check only — the
  // actual write below re-reads and patches the manifest fresh, so a stale
  // snapshot here can cause a redundant re-download at worst, never a lost
  // update.
  const manifestSnapshot = loadManifest(roots.manifestPath);

  let downloaded = 0;
  let conflicts = 0;
  let skippedLazy = 0;

  for (const object of objects) {
    const manifestEntry = manifestSnapshot[object.key];
    if (manifestEntry?.etag === object.etag) continue;

    const isOutput = object.key.startsWith(`${remotePrefix}${OUTPUTS_MARKER}`);
    const relPath = isOutput
      ? object.key.slice((remotePrefix + OUTPUTS_MARKER).length)
      : object.key.slice(remotePrefix.length);
    if (!relPath) continue;

    try {
      assertSafeRelPath(relPath);
    } catch (error) {
      conflicts++;
      console.error(`syncDown: refusing key "${object.key}" for profile "${slug}": ${(error as Error).message}`);
      continue;
    }

    if (isOutput && isLazyOutput(relPath, config)) {
      skippedLazy++;
      continue;
    }

    const mirrorRoot = isOutput ? roots.outputsMirrorRoot : roots.profileMirrorRoot;
    const localPath = join(isOutput ? roots.outputsDir : roots.profileDir, relPath);
    try {
      assertWithinRoot(localPath, mirrorRoot);
    } catch (error) {
      conflicts++;
      console.error(`syncDown: refusing key "${object.key}" for profile "${slug}": ${(error as Error).message}`);
      continue;
    }

    if (hasUnsyncedLocalEdit(localPath, manifestEntry)) {
      conflicts++;
      console.warn(`syncDown: "${relPath}" has an unsynced local edit for profile "${slug}" — keeping local, not overwriting from the bucket.`);
      continue;
    }

    const { body } = await store.get(object.key);
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, body);
    patchManifestEntry(roots.manifestPath, object.key, { etag: object.etag, hash: sha256(body) });
    downloaded++;
  }

  return { downloaded, conflicts, skippedLazy };
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
 * file is left alone rather than clobbering it, and counted as a conflict.
 */
export interface SyncUpResult {
  uploaded: number;
  /** A local file whose upload lost a race against a newer remote write — left alone; the next `syncDown` picks up the remote copy. */
  conflicts: number;
}

export async function syncUp(
  store: ObjectStore,
  config: S3StorageConfig,
  cacheDir: string,
  slug: string,
): Promise<SyncUpResult> {
  const roots = resolveMirrorRoots(config, cacheDir, slug);
  const manifestSnapshot = loadManifest(roots.manifestPath);

  let uploaded = 0;
  let conflicts = 0;

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
        uploaded++;
      } catch (error) {
        if (error instanceof PreconditionFailedError) {
          conflicts++;
          console.warn(`syncUp: "${key}" changed remotely since the last sync for profile "${slug}" — not overwriting; the next syncDown will pick up the remote copy.`);
          continue;
        }
        throw error;
      }
    }
  }

  return { uploaded, conflicts };
}

/**
 * Fetches one object on demand into the local mirror, streaming straight to
 * disk (the response body is never buffered whole in memory) rather than
 * through `syncDown`'s eager, list-everything pass — the other half of the
 * lazy-media exclusion above: a caller that actually needs one specific
 * excluded file (an old export's PNG) calls this instead of waiting for a
 * full resync. Runs the same path-safety checks `syncDown` does.
 */
export async function fetchObjectOnDemand(
  store: ObjectStore,
  config: S3StorageConfig,
  cacheDir: string,
  slug: string,
  area: "profile" | "outputs",
  relPath: string,
): Promise<string> {
  assertSafeRelPath(relPath);
  const roots = resolveMirrorRoots(config, cacheDir, slug);
  const mirrorRoot = area === "outputs" ? roots.outputsMirrorRoot : roots.profileMirrorRoot;
  const localPath = join(area === "outputs" ? roots.outputsDir : roots.profileDir, relPath);
  assertWithinRoot(localPath, mirrorRoot);

  const key = objectKeyFor(config, slug, area, relPath);
  const { stream, etag } = await store.getStream(key);

  mkdirSync(dirname(localPath), { recursive: true });
  const hasher = createHash("sha256");
  await pipeline(
    stream,
    async function* hashThrough(source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        hasher.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(localPath),
  );

  patchManifestEntry(roots.manifestPath, key, { etag, hash: hasher.digest("hex") });
  return localPath;
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
