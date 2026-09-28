import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invalidateAssetIndex, loadIndexCached, __resetAssetIndexCacheForTests } from "./asset-index-cache.js";

/**
 * `loadIndexCached` exists purely to avoid paying `loadIndex`'s full
 * `assets/` walk (~100ms+ on a real profile — see document-store.ts's
 * comment) on every document validation within a short window. These
 * tests prove the two things that matter about a cache like this: a
 * second read within the window doesn't see a file added after the first
 * read (it's actually cached, not accidentally always fresh), and
 * `invalidateAssetIndex` makes the very next read see it (mutations this
 * server makes are never stale).
 */

function freshProfileDir(): string {
  const root = mkdtempSync(join(tmpdir(), "editor-server-asset-index-cache-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  return root;
}

{
  __resetAssetIndexCacheForTests();
  const profileDir = freshProfileDir();
  const first = loadIndexCached(profileDir);
  assert.equal(first.entries.length, 0, "empty assets/ starts with an empty index");

  // A file added after the first read, within the cache's TTL window.
  writeFileSync(join(profileDir, "assets", "new.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  const second = loadIndexCached(profileDir);
  assert.equal(second.entries.length, 0, "a cached read does not re-walk disk and so misses the new file");
  console.log("ok  loadIndexCached: a second call within the TTL window reuses the cached index");
}

{
  __resetAssetIndexCacheForTests();
  const profileDir = freshProfileDir();
  loadIndexCached(profileDir); // warms the cache
  writeFileSync(join(profileDir, "assets", "new.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));

  invalidateAssetIndex(profileDir);
  const afterInvalidate = loadIndexCached(profileDir);
  assert.equal(afterInvalidate.entries.length, 1, "invalidateAssetIndex forces the next read to see a file added in between");
  console.log("ok  loadIndexCached: invalidateAssetIndex makes the next read observe a change immediately");
}

{
  __resetAssetIndexCacheForTests();
  const profileA = freshProfileDir();
  const profileB = freshProfileDir();
  writeFileSync(join(profileB, "assets", "b.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));

  const a = loadIndexCached(profileA);
  const b = loadIndexCached(profileB);
  assert.equal(a.entries.length, 0, "profile A's cache entry is unaffected by profile B");
  assert.equal(b.entries.length, 1, "profile B's cache entry is scoped independently");
  console.log("ok  loadIndexCached: caching is scoped per profileDir, not global");
}

{
  __resetAssetIndexCacheForTests();
  const profileDir = freshProfileDir();
  writeFileSync(join(profileDir, "assets", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  const first = loadIndexCached(profileDir);
  assert.equal(first.entries.length, 1, "the index is built (and written) from the one file on disk");

  // Another writer (e.g. the bucket mirror's syncDown) replaces index.json
  // without calling invalidateAssetIndex: here, one entry retagged.
  const indexPath = join(profileDir, "assets", "index.json");
  const onDisk = JSON.parse(readFileSync(indexPath, "utf-8")) as { entries: Array<{ tags: string[] }> };
  onDisk.entries[0]!.tags = ["rewritten-out-of-band"];
  writeFileSync(indexPath, JSON.stringify(onDisk, null, 2) + "\n");

  const second = loadIndexCached(profileDir);
  assert.deepEqual(second.entries[0]!.tags, ["rewritten-out-of-band"], "a rewritten index.json is picked up without an explicit invalidation");
  console.log("ok  loadIndexCached: an index.json rewritten by another writer is not served stale");
}

{
  __resetAssetIndexCacheForTests();
  const profileDir = freshProfileDir();
  writeFileSync(join(profileDir, "assets", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  const shared = loadIndexCached(profileDir);
  assert.ok(Object.isFrozen(shared), "the memoised index object is frozen");
  assert.ok(Object.isFrozen(shared.entries), "its entries array is frozen too");
  assert.throws(() => (shared.entries as unknown[]).push({}), TypeError, "an in-place push cannot leak into other callers");
  assert.equal(loadIndexCached(profileDir).entries.length, 1, "the next caller still sees the untouched index");
  console.log("ok  loadIndexCached: the shared index is read-only");
}
