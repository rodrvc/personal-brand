/**
 * On-disk cache for third-party geodata lookups.
 *
 * What a reel geocodes does not change between runs: the bbox comes from the
 * profile's recipe and a venue's address is stable. Without a cache the engine
 * asks Nominatim about the same venues every single render — which is slow
 * when that public service is healthy and a hard failure when it is not.
 *
 * **What is cached is the raw upstream response, keyed on the literal
 * request.** The key is *only declared input*: change anything about the
 * query and the cache misses on its own, with nothing to remember to bump.
 *
 * The cache lives at `<repo>/.cache/`, deliberately **not** inside
 * `profiles/<slug>/`. A profile is a transportable declaration of a brand; a
 * cache is a derivative with an expiry date. Copying a profile folder to
 * another machine must carry the brand, not a silent eight-month-old snapshot
 * of a city's geocodes.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, "..", "..", ".cache", "osm");

/**
 * How long an entry is served without re-fetching.
 *
 * OSM data does change, so a map frozen forever is a slow bug rather than a
 * feature. Thirty days suits urban geometry: streets and landmarks move on a
 * far longer timescale than that, and a month bounds how stale a published
 * video's map can be.
 */
export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface CacheEntry<T> {
  /** ISO timestamp, stored in the file rather than encoded in its name. */
  fetchedAt: string;
  payload: T;
}

export interface CacheOptions {
  /** Skip reading the cache and refresh the entry. Writing still happens. */
  noCache?: boolean;
  ttlMs?: number;
  /**
   * Called with a one-line description of where the data came from and how old
   * it is. A silent cache is a trap; a cache that announces itself is a tool —
   * without this line a run is no longer auditable from its own output.
   */
  report?: (message: string) => void;
}

function pathFor(key: string): string {
  return join(CACHE_DIR, `${createHash("sha256").update(key).digest("hex")}.json`);
}

function readEntry<T>(key: string): CacheEntry<T> | undefined {
  try {
    return JSON.parse(readFileSync(pathFor(key), "utf-8")) as CacheEntry<T>;
  } catch {
    // A missing or unreadable entry is a miss, never an error: a corrupt cache
    // file must not be able to stop a render.
    return undefined;
  }
}

function ageOf(entry: CacheEntry<unknown>): number {
  const fetchedAt = Date.parse(entry.fetchedAt);
  return Number.isNaN(fetchedAt) ? Infinity : Date.now() - fetchedAt;
}

function describeAge(ms: number): string {
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} old`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"} old`;
  return "fresh";
}

/**
 * Returns a cached response, or fetches and stores one.
 *
 * When the fetch fails and an expired entry exists, that entry is served and
 * the staleness is announced. A dead cache must not mean a dead render: this
 * turns today's hard failure into a stated degradation, which is the whole
 * reason the engine can stop treating a public service's uptime as its own.
 */
export async function withCache<T>(
  key: string,
  label: string,
  fetcher: () => Promise<T>,
  options: CacheOptions = {},
): Promise<T> {
  const { noCache = false, ttlMs = DEFAULT_TTL_MS, report = () => {} } = options;
  const existing = readEntry<T>(key);

  if (!noCache && existing && ageOf(existing) <= ttlMs) {
    report(`  ${label}: from cache (${describeAge(ageOf(existing))})`);
    return existing.payload;
  }

  try {
    const payload = await fetcher();
    const entry: CacheEntry<T> = { fetchedAt: new Date().toISOString(), payload };
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(pathFor(key), JSON.stringify(entry));
    report(`  ${label}: fetched`);
    return payload;
  } catch (error) {
    if (existing) {
      report(
        `  ${label}: upstream unavailable — using expired cache (${describeAge(ageOf(existing))}). ` +
          `Re-run later for current data.`,
      );
      return existing.payload;
    }
    throw error;
  }
}
