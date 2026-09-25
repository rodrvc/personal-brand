import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  resolveOutputBaseDir,
  resolveProfileDir,
  resolveProfilesRoot,
} from "../../../system/ig-carousel/profile.js";

/**
 * The ONLY module in `editor/server` that touches the filesystem for
 * profile data. Every route handler goes through this, mirroring the
 * Tauri app's `resolver_dentro()` (design.md D12, `app/src-tauri/src/main.rs`)
 * but with two allowed roots instead of one: a profile's own directory, and
 * that profile's resolved `outputs.base_dir` — which per `resolveOutputBaseDir`
 * may sit entirely outside the repo.
 *
 * Confinement rules, both enforced on every call:
 *   1. The requested relative path must not contain `..` segments and must
 *      not be absolute.
 *   2. Once resolved, the real path (following symlinks via `realpath` on
 *      the parent directory) must land inside one of the two allowed roots.
 *      This is what catches `system/templates/x` — a path with no `..` that
 *      still escapes — and a symlink planted inside `assets/` pointing at
 *      `system/`.
 *
 * A path that doesn't exist yet (a write target) is checked by resolving its
 * *parent* directory's real path instead — the file itself has no realpath
 * to follow.
 *
 * This class is always filesystem-backed — it never learns about the S3
 * storage backend (issue #99). In `s3` mode, `storage/runtime.ts` repoints
 * `BRAND_PROFILES_DIR`/`BRAND_OUTPUTS_ROOT` at a local bucket mirror before
 * any `ProfileStore` is constructed, and syncs that mirror against the
 * bucket around each request (`storage/mirror.ts`). `ProfileStore` itself,
 * and every confinement rule above, stays exactly as it is for the fs
 * backend — the mirror is just another directory tree on disk to it.
 */

const SLUG = /^[a-z0-9-]+$/;

export class ProfileStoreError extends Error {}

/**
 * Thrown by the bucket-backed write guarantees below (`writeJsonIfRevision`,
 * `appendLine`, `reserveOnce`) when the expected revision no longer matches
 * — a stale client copy in `fs` mode (practically unreachable mid-request,
 * since nothing else can write between the read and the write inside one
 * synchronous Node request handler) or a real concurrent writer race in
 * `s3` mode, where `ObjectStore.put`'s `ifMatch`/`ifNoneMatch` actually is
 * enforced by the bucket across independent server instances.
 */
export class RevisionConflictError extends ProfileStoreError {}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertValidSlug(slug: string): void {
  if (!SLUG.test(slug)) {
    throw new ProfileStoreError(
      `Invalid profile slug "${slug}" — must match ${SLUG} (lowercase letters, digits, hyphens).`,
    );
  }
}

/**
 * Rejects a relative path outright before any filesystem call: no `..`
 * segment, not absolute, no null bytes. This is the cheap, syntactic half of
 * confinement — the expensive half (symlink resolution against the real
 * roots) happens in `resolveConfined`.
 */
function assertSyntacticallySafe(relPath: string): void {
  if (isAbsolute(relPath)) {
    throw new ProfileStoreError(`Path must be relative, got an absolute path: "${relPath}"`);
  }
  if (relPath.includes("\0")) {
    throw new ProfileStoreError(`Path contains a null byte: "${relPath}"`);
  }
  const segments = relPath.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    throw new ProfileStoreError(`Path escapes its root with "..": "${relPath}"`);
  }
}

/** True when `target` is `root` itself or a descendant of it, comparing real paths. */
function isInsideRoot(target: string, root: string): boolean {
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return target === root || target.startsWith(rootWithSep);
}

/**
 * Resolves `relPath` against `root`, following symlinks, and throws unless
 * the real result stays inside one of `allowedRealRoots` (each itself
 * realpath'd once up front). Works for both existing files (realpath the
 * file itself) and write targets several directories deep that don't exist
 * yet: walks up to the nearest ancestor that does exist, realpath's only
 * that ancestor, and rejoins the not-yet-created suffix — a not-yet-created
 * segment has no symlink of its own to resolve.
 */
function resolveConfined(root: string, relPath: string, allowedRealRoots: string[]): string {
  assertSyntacticallySafe(relPath);
  const candidate = resolve(root, relPath);

  // Walk up from the candidate until an ancestor that actually exists is
  // found (the candidate itself, for a read; some not-yet-created ancestor
  // directory, for a write target several levels deep — `mkdir -p`-shaped
  // callers never guarantee the immediate parent exists). Only that
  // existing ancestor's realpath is trustworthy; the remaining suffix is
  // plain path segments with no symlink of its own to resolve, since
  // nothing on disk claims that name yet.
  let existingAncestor = candidate;
  const remainingSegments: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = join(existingAncestor, "..");
    if (parent === existingAncestor) {
      // Reached the filesystem root without finding anything that exists.
      throw new ProfileStoreError(`No existing ancestor directory found for: "${relPath}"`);
    }
    remainingSegments.unshift(relative(parent, existingAncestor));
    existingAncestor = parent;
  }

  const realAncestor = realpathSync(existingAncestor);
  const realTarget = remainingSegments.length > 0 ? join(realAncestor, ...remainingSegments) : realAncestor;

  const allowed = allowedRealRoots.some((allowedRoot) => isInsideRoot(realTarget, allowedRoot));
  if (!allowed) {
    throw new ProfileStoreError(`Path resolves outside the allowed roots: "${relPath}"`);
  }
  return realTarget;
}

/** Which of `ProfileStore`'s two allowed roots a bucket-backed method's key/path is under — matches `mirror.ts`'s own "profile" vs "outputs" object-key areas. */
export type StorageArea = "profile" | "outputs";

export interface ProfileRoots {
  profileDir: string;
  outputsBaseDir: string;
}

/**
 * Resolves a profile's two allowed roots. Both must exist on disk for their
 * realpath to be computable — `mkdirSync` them first if a caller needs a
 * brand-new profile or output tree, then call this again.
 */
export function resolveProfileRoots(slug: string): ProfileRoots {
  assertValidSlug(slug);
  const profileDir = resolveProfileDir(slug);
  const outputsBaseDir = resolveOutputBaseDir(profileDir);
  return { profileDir, outputsBaseDir };
}

function realRootsFor(roots: ProfileRoots): { profileReal: string; outputsReal: string } {
  mkdirSync(roots.profileDir, { recursive: true });
  mkdirSync(roots.outputsBaseDir, { recursive: true });
  return {
    profileReal: realpathSync(roots.profileDir),
    outputsReal: realpathSync(roots.outputsBaseDir),
  };
}

/**
 * A `ProfileStore` bound to one profile slug. Every method takes a path
 * relative to *either* allowed root and resolves it against whichever root
 * the path actually lives under, honoring symlinks and rejecting an escape
 * from both. Callers pick the root implicitly by whichever one the relative
 * path resolves inside — most editor state lives under the profile dir, and
 * only export output lives under `outputsBaseDir`.
 */
export class ProfileStore {
  readonly slug: string;
  readonly roots: ProfileRoots;

  constructor(slug: string) {
    this.slug = slug;
    this.roots = resolveProfileRoots(slug);
  }

  /** Resolves a path relative to the profile directory, confined to {profileDir, outputsBaseDir}. */
  resolveInProfile(relPath: string): string {
    const { profileReal, outputsReal } = realRootsFor(this.roots);
    return resolveConfined(this.roots.profileDir, relPath, [profileReal, outputsReal]);
  }

  /** Resolves a path relative to the resolved outputs base dir, confined to {profileDir, outputsBaseDir}. */
  resolveInOutputs(relPath: string): string {
    const { profileReal, outputsReal } = realRootsFor(this.roots);
    return resolveConfined(this.roots.outputsBaseDir, relPath, [profileReal, outputsReal]);
  }

  readJson<T = unknown>(relPath: string): T {
    const abs = this.resolveInProfile(relPath);
    return JSON.parse(readFileSync(abs, "utf-8")) as T;
  }

  writeJson(relPath: string, value: unknown): void {
    const abs = this.resolveInProfile(relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, JSON.stringify(value, null, 2) + "\n", "utf-8");
  }

  readFile(relPath: string): Buffer {
    const abs = this.resolveInProfile(relPath);
    return readFileSync(abs);
  }

  writeFile(relPath: string, content: Buffer | string): void {
    const abs = this.resolveInProfile(relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }

  /** Lists entries of a directory relative to the profile dir. Returns [] if it doesn't exist. */
  list(relPath: string): Dirent[] {
    const abs = this.resolveInProfile(relPath);
    if (!existsSync(abs)) return [];
    return readdirSync(abs, { withFileTypes: true });
  }

  mkdir(relPath: string): string {
    const abs = this.resolveInProfile(relPath);
    mkdirSync(abs, { recursive: true });
    return abs;
  }

  exists(relPath: string): boolean {
    try {
      const abs = this.resolveInProfile(relPath);
      return existsSync(abs);
    } catch {
      return false;
    }
  }

  private absForArea(relPath: string, area: StorageArea): string {
    return area === "outputs" ? this.resolveInOutputs(relPath) : this.resolveInProfile(relPath);
  }

  /**
   * Resolves the bucket side of a call, when the process is running in `s3`
   * mode — `undefined` in `fs` mode, which is what every method below uses
   * to fall back to the plain filesystem path with no other behaviour
   * change. This is the only place in `ProfileStore` that reaches into
   * `storage/runtime.ts`; every other method stays exactly as filesystem-only
   * as it always was.
   */
  private async bucketContext(
    relPath: string,
    area: StorageArea,
  ): Promise<
    | { key: string; store: import("./storage/object-store.js").ObjectStore; s3: import("./storage/config.js").S3StorageConfig; cacheDir: string }
    | undefined
  > {
    const { getStorageRuntime } = await import("./storage/runtime.js");
    const { config, store } = getStorageRuntime();
    if (config.backend !== "s3" || !store || !config.s3) return undefined;
    const { objectKeyFor } = await import("./storage/mirror.js");
    return { key: objectKeyFor(config.s3, this.slug, area, relPath), store, s3: config.s3, cacheDir: config.cacheDir };
  }

  private async recordSyncedWrite(
    bucket: { s3: import("./storage/config.js").S3StorageConfig; cacheDir: string; key: string },
    etag: string,
    hash: string,
  ): Promise<void> {
    const { updateManifestEntry } = await import("./storage/mirror.js");
    updateManifestEntry(bucket.s3, bucket.cacheDir, this.slug, bucket.key, { etag, hash });
  }

  /**
   * Reads a JSON file together with an opaque revision token — the
   * bucket's real `ETag` in `s3` mode (read straight from the bucket, not
   * the local mirror, so a request always sees the authoritative current
   * state before deciding whether it may overwrite it), or a content hash
   * in `fs` mode. `undefined` when the file doesn't exist yet.
   */
  async readJsonRevision<T = unknown>(
    relPath: string,
    area: StorageArea = "profile",
  ): Promise<{ value: T; revision: string } | undefined> {
    const bucket = await this.bucketContext(relPath, area);
    if (bucket) {
      const { ObjectNotFoundError } = await import("./storage/object-store.js");
      try {
        const { body, etag } = await bucket.store.get(bucket.key);
        return { value: JSON.parse(body.toString("utf-8")) as T, revision: etag };
      } catch (error) {
        if (error instanceof ObjectNotFoundError) return undefined;
        throw error;
      }
    }

    const abs = this.absForArea(relPath, area);
    if (!existsSync(abs)) return undefined;
    const raw = readFileSync(abs);
    return { value: JSON.parse(raw.toString("utf-8")) as T, revision: sha256Hex(raw) };
  }

  /**
   * Writes a JSON file only if its current revision still matches
   * `expectedRevision` (from an earlier `readJsonRevision`), or — when
   * `expectedRevision` is `null` — only if the file does not exist yet.
   * Throws `RevisionConflictError` otherwise, translated by the carousel
   * PUT route into the same 409 it has always returned for a stale copy.
   *
   * In `s3` mode this is a real conditional `PutObject` against the
   * bucket (`ifMatch`/`ifNoneMatch`), so it also catches two server
   * instances racing on the same document — not just a stale client copy —
   * which is exactly the guarantee `fs` mode never needed to provide
   * because nothing else can write between the read and the write inside
   * one synchronous request handler. The local mirror is updated
   * write-through, and the sync manifest records the etag/hash this write
   * produced so a later `syncUp` sees the mirror already in sync and never
   * re-uploads (or clobbers) this object.
   */
  async writeJsonIfRevision<T>(
    relPath: string,
    value: T,
    expectedRevision: string | null,
    area: StorageArea = "profile",
  ): Promise<string> {
    const content = Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf-8");
    // Confinement (`absForArea`) MUST run before any bucket call, so an
    // unsafe path never reaches the bucket at all.
    const abs = this.absForArea(relPath, area);
    const bucket = await this.bucketContext(relPath, area);

    if (bucket) {
      const { PreconditionFailedError } = await import("./storage/object-store.js");
      const hash = sha256Hex(content);
      let etag: string;
      try {
        const result =
          expectedRevision === null
            ? await bucket.store.put(bucket.key, content, { ifNoneMatch: "*", metadata: { sha256: hash } })
            : await bucket.store.put(bucket.key, content, { ifMatch: expectedRevision, metadata: { sha256: hash } });
        etag = result.etag;
      } catch (error) {
        if (error instanceof PreconditionFailedError) {
          throw new RevisionConflictError(`"${relPath}" changed since it was last read.`);
        }
        throw error;
      }
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
      await this.recordSyncedWrite(bucket, etag, hash);
      return etag;
    }

    const exists = existsSync(abs);
    if (expectedRevision === null && exists) {
      throw new RevisionConflictError(`"${relPath}" already exists.`);
    }
    if (expectedRevision !== null) {
      if (!exists) throw new RevisionConflictError(`"${relPath}" no longer exists.`);
      if (sha256Hex(readFileSync(abs)) !== expectedRevision) {
        throw new RevisionConflictError(`"${relPath}" changed since it was last read.`);
      }
    }
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
    return sha256Hex(content);
  }

  /**
   * Appends one line to a text log (the chat log's `.jsonl`), safely
   * against concurrent appenders in `s3` mode: reads the current content
   * and etag straight from the bucket, appends, and writes back with
   * `ifMatch` (or `ifNoneMatch: "*"` for a brand-new log) — retrying, with
   * a small jittered backoff, when another writer's append lands first
   * (`PreconditionFailedError`), up to `maxAttempts` times before giving
   * up. `fs` mode appends directly (there is no cross-process writer to
   * race inside one request handler) and never retries.
   */
  async appendLine(relPath: string, line: string, area: StorageArea = "profile", maxAttempts = 5): Promise<string> {
    // Confinement before any bucket call — see the comment in
    // `writeJsonIfRevision`. Computed once and reused for every retry below.
    const abs = this.absForArea(relPath, area);
    const bucket = await this.bucketContext(relPath, area);
    if (!bucket) {
      const current = existsSync(abs) ? readFileSync(abs, "utf-8") : "";
      mkdirSync(join(abs, ".."), { recursive: true });
      const next = current + line + "\n";
      writeFileSync(abs, next, "utf-8");
      return sha256Hex(Buffer.from(next, "utf-8"));
    }

    const { ObjectNotFoundError, PreconditionFailedError } = await import("./storage/object-store.js");
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let current = "";
      let expectedRevision: string | null = null;
      try {
        const { body, etag } = await bucket.store.get(bucket.key);
        current = body.toString("utf-8");
        expectedRevision = etag;
      } catch (error) {
        if (!(error instanceof ObjectNotFoundError)) throw error;
      }

      const nextContent = Buffer.from(current + line + "\n", "utf-8");
      try {
        const result =
          expectedRevision === null
            ? await bucket.store.put(bucket.key, nextContent, { ifNoneMatch: "*" })
            : await bucket.store.put(bucket.key, nextContent, { ifMatch: expectedRevision });
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, nextContent);
        await this.recordSyncedWrite(bucket, result.etag, sha256Hex(nextContent));
        return result.etag;
      } catch (error) {
        if (!(error instanceof PreconditionFailedError) || attempt === maxAttempts) {
          if (error instanceof PreconditionFailedError) {
            throw new RevisionConflictError(`"${relPath}" could not be appended to after ${maxAttempts} attempts (lost every race).`);
          }
          throw error;
        }
        const backoffMs = 5 * attempt + Math.floor(Math.random() * 10);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    // Unreachable — the loop above always returns or throws.
    throw new RevisionConflictError(`"${relPath}" could not be appended to.`);
  }

  /**
   * Atomically claims a name that must be created at most once — the
   * export version-reservation marker (`v<N>/.reserved`). Returns `true`
   * when this call created it, `false` when it already existed (the caller
   * tries the next candidate name). `s3` mode uses a conditional
   * `PutObject` (`ifNoneMatch: "*"`); `fs` mode opens the file with the
   * exclusive `"wx"` flag, which throws `EEXIST` exactly when another
   * writer already has it — the same atomic "claim or fail" primitive,
   * expressed against whichever backend is active.
   */
  async reserveOnce(relPath: string, area: StorageArea = "outputs"): Promise<boolean> {
    // Confinement before any bucket call — see the comment in
    // `writeJsonIfRevision`.
    const abs = this.absForArea(relPath, area);
    const bucket = await this.bucketContext(relPath, area);
    if (bucket) {
      const { PreconditionFailedError } = await import("./storage/object-store.js");
      try {
        const result = await bucket.store.put(bucket.key, Buffer.alloc(0), { ifNoneMatch: "*" });
        mkdirSync(join(abs, ".."), { recursive: true });
        writeFileSync(abs, Buffer.alloc(0));
        await this.recordSyncedWrite(bucket, result.etag, sha256Hex(Buffer.alloc(0)));
        return true;
      } catch (error) {
        if (error instanceof PreconditionFailedError) return false;
        throw error;
      }
    }

    mkdirSync(join(abs, ".."), { recursive: true });
    try {
      writeFileSync(abs, "", { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") return false;
      throw error;
    }
  }

  /** Absolute path helpers for callers that need to hand a path to another engine function (e.g. Playwright). */
  absPath(relPath: string): string {
    return this.resolveInProfile(relPath);
  }

  relativeToProfile(absPath: string): string {
    return relative(this.roots.profileDir, absPath).split(sep).join("/");
  }
}

/**
 * True when `entry` (a top-level child of the profiles root) is a directory
 * — following one level of symlink if `entry` itself is one. A real profile
 * lives outside the repo (see `resolveProfilesRoot`'s doc comment) and is
 * linked in as `profiles/<slug> -> /path/to/it`; `Dirent.isDirectory()`
 * reports the *link's* type, not its target's, so a symlinked profile would
 * otherwise be silently dropped from the listing. `statSync` (which follows
 * symlinks, unlike `lstatSync`) gives the target's type instead. A dangling
 * symlink makes `statSync` throw, which is treated as "not a directory"
 * rather than a listing failure.
 */
function isProfileDirectory(root: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(root, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

export interface ProfileListingEntry {
  slug: string;
  /** False when the profile directory has no `brand.json` yet — the route layer (profiles.ts) uses this to disable it in the picker rather than let every other endpoint fail on it one at a time. */
  hasBrand: boolean;
}

/** Every profile directory under the profiles root, flagging which ones are missing `brand.json` (editor-api spec's brand-missing handling) rather than throwing — a profile mid-setup should still show up, just disabled. */
export function listProfiles(): ProfileListingEntry[] {
  const root = resolveProfilesRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => SLUG.test(entry.name) && isProfileDirectory(root, entry))
    .map((entry) => ({ slug: entry.name, hasBrand: existsSync(join(root, entry.name, "brand.json")) }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Same listing, but sourced from the bucket directly in `s3` mode (issue
 * #99) instead of the local mirror — a profile with no request served yet
 * has no mirror on disk at all, so listing the mirror would silently hide
 * it. In `fs` mode this is exactly `listProfiles()`, resolved immediately.
 */
export async function listProfilesAsync(): Promise<ProfileListingEntry[]> {
  const { getStorageRuntime } = await import("./storage/runtime.js");
  const { config, store } = getStorageRuntime();
  if (config.backend !== "s3" || !store || !config.s3) {
    return listProfiles();
  }
  const { listProfileSlugsFromBucket, bucketHasBrand } = await import("./storage/mirror.js");
  const slugs = await listProfileSlugsFromBucket(store, config.s3);
  const entries = await Promise.all(
    slugs
      .filter((slug) => SLUG.test(slug))
      .map(async (slug) => ({ slug, hasBrand: await bucketHasBrand(store, config.s3!, slug) })),
  );
  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}
