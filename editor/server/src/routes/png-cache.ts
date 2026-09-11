import { createHash } from "node:crypto";

/**
 * Small in-memory cache + concurrency limiter for the PNG render route
 * (`/slides/:n/png`). Pure and browser-free so it is unit-testable without
 * Playwright — see `png-cache.test.ts`.
 */

const MAX_ENTRIES = 64;

/**
 * Insertion-order LRU: a `Map` already preserves insertion order in V8, so
 * "touch on read" (delete + re-set) plus "evict oldest" (delete the first
 * key) gives LRU semantics without a second data structure.
 */
export class PngCache {
  private readonly entries = new Map<string, Buffer>();

  get(key: string): Buffer | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: Buffer): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Cache key: the slide's identity plus a hash of its rendered HTML — the HTML is the true content key, since the same (slug, carouselId, index) can render differently across edits. */
export function pngCacheKey(slug: string, carouselId: string, slideIndex: number, html: string): string {
  const contentHash = createHash("sha256").update(html).digest("hex");
  return `${slug}/${carouselId}/${slideIndex}/${contentHash}`;
}

/**
 * Caps concurrent screenshot page creation at `limit` slots (same idea as
 * `export-queue.ts`'s serial `queueTail` promise chain, generalized to N
 * concurrent slots instead of 1). `withSlot` queues `fn` behind whichever
 * slot frees up first and always releases its slot, success or failure.
 */
export class Semaphore {
  private readonly slots: Promise<void>[];
  private cursor = 0;

  constructor(limit: number) {
    this.slots = Array.from({ length: limit }, () => Promise.resolve());
  }

  /** Round-robins across the fixed slot pool: each call claims the next slot and waits for whatever was queued on it before, so at most `limit` calls run their `fn` concurrently. */
  async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.slots.length;
    const prior = this.slots[index]!;
    let release!: () => void;
    this.slots[index] = new Promise((resolve) => (release = resolve));
    await prior;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
