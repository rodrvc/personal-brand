import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
 */

const SLUG = /^[a-z0-9-]+$/;

export class ProfileStoreError extends Error {}

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

  /** Absolute path helpers for callers that need to hand a path to another engine function (e.g. Playwright). */
  absPath(relPath: string): string {
    return this.resolveInProfile(relPath);
  }

  relativeToProfile(absPath: string): string {
    return relative(this.roots.profileDir, absPath).split(sep).join("/");
  }
}

export function listProfiles(): string[] {
  const root = resolveProfilesRoot();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SLUG.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}
