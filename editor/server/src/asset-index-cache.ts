import { statSync } from "node:fs";
import { join } from "node:path";

import { loadIndex, type AssetIndexFile } from "../../../system/assets/index.js";

/**
 * In-process memo over `loadIndex`, scoped to editor/server — `system/`
 * stays untouched, since `loadIndex`'s own `indexMatchesDisk` safety check
 * (a full recursive walk of `assets/` on every call, so a hand-copied file
 * is never missed) is correct behaviour for the engine's "rebuildable
 * cache" contract, just not something a hot HTTP path should pay for on
 * every request.
 *
 * Measured on a 138-file profile: that walk alone costs ~100-150ms, and it
 * dominates `readValidatedDocument` (`document-store.ts`), which calls it
 * once per document read — including once per *other* carousel when
 * computing the library-ratio stat (see `routes/compose.ts`).
 *
 * Safe by construction: every write this server makes to a profile's asset
 * library goes through `registerFile`/`updateEntry` in `system/assets/
 * index.ts`, and every call site of those in this codebase calls
 * `invalidateAssetIndex` right after — so a mutation this process makes is
 * never observed stale. The short TTL below is only a safety net for an
 * asset that changed some other way (a hand-copied file, another editor
 * process) — never the primary invalidation mechanism.
 *
 * A hit also requires `assets/index.json` to still carry the mtime and size
 * it had when the entry was cached. That one `stat` is what keeps the memo
 * honest against writers this server does not route through
 * `registerFile`/`updateEntry` in-process: the bucket mirror's `syncDown`
 * replacing the index with a newer copy from the bucket (`storage/mirror.ts`),
 * or another process that edits the same profile — none of them call
 * `invalidateAssetIndex`, but all of them rewrite the file.
 *
 * The returned index is shared by every caller until it expires, so it is
 * read-only: the object and its `entries` array are frozen (entries
 * themselves are not), and a caller that needs a different shape copies
 * (`map`/`filter`/`[...entries]`) rather than mutating in place. Writers go
 * through `registerFile`/`updateEntry`, which load their own copy.
 */
const TTL_MS = 5000;

const cache = new Map<string, { index: AssetIndexFile; loadedAt: number; fingerprint: string }>();

function indexFingerprint(profileDir: string): string {
  try {
    const stats = statSync(join(profileDir, "assets", "index.json"));
    return `${stats.mtimeMs}:${stats.size}`;
  } catch {
    return "missing";
  }
}

export function loadIndexCached(profileDir: string): AssetIndexFile {
  const hit = cache.get(profileDir);
  const fingerprint = indexFingerprint(profileDir);
  if (hit && Date.now() - hit.loadedAt < TTL_MS && hit.fingerprint === fingerprint) return hit.index;
  const loaded = loadIndex(profileDir);
  const index: AssetIndexFile = Object.freeze({ ...loaded, entries: Object.freeze(loaded.entries) as AssetIndexFile["entries"] });
  // Re-read after `loadIndex`, which may itself have (re)written the index
  // while rebuilding it from disk.
  cache.set(profileDir, { index, loadedAt: Date.now(), fingerprint: indexFingerprint(profileDir) });
  return index;
}

/** Drops any cached index for this profile — call right after any write through `registerFile`/`updateEntry`. */
export function invalidateAssetIndex(profileDir: string): void {
  cache.delete(profileDir);
}

/** Test-only: clears every cached profile, so tests don't leak state into each other. */
export function __resetAssetIndexCacheForTests(): void {
  cache.clear();
}
