import assert from "node:assert/strict";

import { PngCache, pngCacheKey, Semaphore } from "./png-cache.js";

/** Pure helper module for the `/slides/:n/png` route's cache + concurrency cap — no Playwright involved, so this test never launches a browser. */

{
  // PngCache: basic get/set round-trips.
  const cache = new PngCache();
  assert.equal(cache.get("a"), undefined, "miss on empty cache");
  const buf = Buffer.from("png-bytes");
  cache.set("a", buf);
  assert.equal(cache.get("a"), buf, "hit returns the same buffer");
  console.log("ok  PngCache: set then get returns the same buffer");
}

{
  // PngCache: eviction is LRU, not FIFO — a touched key survives.
  const cache = new PngCache();
  for (let i = 0; i < 64; i++) cache.set(`k${i}`, Buffer.from(`v${i}`));
  cache.get("k0"); // touch the oldest key, moving it to the back
  cache.set("k64", Buffer.from("v64")); // forces one eviction
  assert.notEqual(cache.get("k0"), undefined, "recently-touched key survives eviction");
  assert.equal(cache.get("k1"), undefined, "the actual least-recently-used key was evicted instead");
  assert.equal(cache.size, 64, "cache stays capped at 64 entries");
  console.log("ok  PngCache: eviction respects recency (LRU), not just insertion order");
}

{
  // pngCacheKey: same slide + same HTML -> same key; different HTML -> different key.
  const k1 = pngCacheKey("acme", "launch-week", 0, "<html>a</html>");
  const k2 = pngCacheKey("acme", "launch-week", 0, "<html>a</html>");
  const k3 = pngCacheKey("acme", "launch-week", 0, "<html>b</html>");
  assert.equal(k1, k2, "identical inputs hash to the identical key");
  assert.notEqual(k1, k3, "a changed HTML content changes the key, even for the same slide index");
  console.log("ok  pngCacheKey: content (not just index) determines the key");
}

{
  // Semaphore: caps how many `fn` bodies run concurrently.
  const sem = new Semaphore(2);
  let concurrent = 0;
  let maxConcurrent = 0;

  async function slot(ms: number): Promise<void> {
    return sem.withSlot(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, ms));
      concurrent--;
    });
  }

  await Promise.all([slot(30), slot(30), slot(30), slot(30), slot(30)]);
  assert.equal(maxConcurrent <= 2, true, `expected at most 2 concurrent, saw ${maxConcurrent}`);
  console.log(`ok  Semaphore: caps concurrency at the configured limit (max seen: ${maxConcurrent})`);
}

console.log("\nAll png-cache tests passed.");
