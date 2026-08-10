/**
 * Geocoding, bounded to the profile's bbox and cached on disk.
 *
 * This is the engine's only remaining OSM data access: the map itself is now
 * rendered from raster tiles by the Remotion composition (see
 * `remotion/src/maplibre.ts` for the tile source and the legal note, and the
 * README for the attribution requirement). What stays here is Nominatim —
 * turning a venue's free-text address into a coordinate the camera can fly to.
 */

import type { BBox } from "./geo.js";
import { withCache, type CacheOptions } from "./osm-cache.js";

/**
 * Options threaded through to the cache. Every fetch here goes through it, so
 * a caller controls freshness and reporting in one place.
 */
export type FetchOptions = CacheOptions;

/**
 * Geocodes free-text locations with Nominatim, bounded to the bbox.
 *
 * Sequential and one request per item by design: Nominatim's usage policy caps
 * this at roughly one call per second, and a parallel burst is how a shared
 * free service ends up blocking the whole repo.
 *
 * Returns `undefined` when nothing matches. The caller drops the item — it
 * does not fall back to the centre of the bbox, because a pin in the wrong
 * place looks exactly as correct as a pin in the right one.
 */
export async function geocode(
  bbox: BBox,
  query: string,
  userAgent: string,
  options: FetchOptions = {},
): Promise<{ lat: number; lon: number } | undefined> {
  const [latMin, lonMin, latMax, lonMax] = bbox;
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("viewbox", `${lonMin},${latMax},${lonMax},${latMin}`);
  url.searchParams.set("bounded", "1");

  // Cached for speed, but also for courtesy: a re-run of the same week must
  // cost the shared free service no requests at all.
  //
  // Long TTL: a venue's address moves far less often than an event listing.
  const GEOCODE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

  return withCache(
    `nominatim:${url.toString()}`,
    `geocode ${query}`,
    async () => {
      const response = await fetch(url, {
        headers: { "User-Agent": userAgent },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`Nominatim answered ${response.status} for ${JSON.stringify(query)}`);
      }
      const results = (await response.json()) as { lat: string; lon: string }[];
      const first = results[0];
      return first ? { lat: Number(first.lat), lon: Number(first.lon) } : undefined;
    },
    { ttlMs: GEOCODE_TTL_MS, ...options },
  );
}
