/**
 * OpenStreetMap data access: coastline, roads and landmark discovery.
 *
 * The map is drawn from OSM **data** (ODbL — commercial use permitted with
 * attribution), never from rendered tiles. That is a licensing constraint, not
 * a technical preference, and it is why this file exists at all:
 *
 *   - OSM's tile policy forbids bulk download ("any pre-emptive fetching of
 *     tiles other than those a user is actively viewing"). Pre-rendering a
 *     video is exactly that.
 *   - Google Maps/Earth imagery is barred from promotional content, which a
 *     brand reel is.
 *   - Mapbox Satellite needs a separate commercial licence.
 *
 * The "© OpenStreetMap" credit the composition draws on every map scene is
 * required by that licence. No profile field turns it off.
 */

import type { BBox } from "./geo.js";
import { withCache, type CacheOptions } from "./osm-cache.js";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  // Overpass saturates often and answers with an HTML error page instead of
  // JSON. The mirror is tried second rather than in parallel: two requests for
  // one answer is exactly the load that makes a free service unusable.
  "https://overpass.kumi.systems/api/interpreter",
];

/**
 * The landmark types a profile may ask for, and the OSM tags each expands to.
 *
 * A profile names a *type*; the engine writes the query. This is the boundary
 * that keeps `map.reference_types` configuration rather than remote code
 * execution: a profile that could supply Overpass QL would be running its own
 * queries against a third-party service through the engine's user agent.
 *
 * A list of *places* would be worse than a list of types — that is content
 * about one city, and it would have to live either in the engine (where no
 * city belongs) or in every profile (where it would rot). Types are stable
 * across cities; the places behind them are discovered per bbox.
 */
export const REFERENCE_TYPES = {
  mall: ['shop=mall', 'shop=department_store'],
  hospital: ['amenity=hospital'],
  stadium: ['leisure=stadium'],
  university: ['amenity=university'],
  square: ['place=square', 'leisure=park'],
  terminal: ['amenity=bus_station', 'public_transport=station'],
  museum: ['amenity=theatre', 'tourism=museum'],
  cemetery: ['landuse=cemetery'],
} as const satisfies Record<string, readonly string[]>;

export type ReferenceType = keyof typeof REFERENCE_TYPES;

export function validateReferenceTypes(values: unknown): ReferenceType[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(
      `map.reference_types must be a non-empty array. Supported: ${Object.keys(REFERENCE_TYPES).join(", ")}`,
    );
  }
  return values.map((value) => {
    if (typeof value !== "string" || !(value in REFERENCE_TYPES)) {
      throw new Error(
        `This profile asks for map.reference_types: ${JSON.stringify(value)}; ` +
          `this engine supports: ${Object.keys(REFERENCE_TYPES).join(", ")}`,
      );
    }
    return value as ReferenceType;
  });
}

export interface Landmark {
  name: string;
  lat: number;
  lon: number;
}

export interface OsmWay {
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

function bboxClause(bbox: BBox): string {
  const [latMin, lonMin, latMax, lonMax] = bbox;
  return `(${latMin},${lonMin},${latMax},${lonMax})`;
}

/**
 * Options threaded through to the cache. Every fetch here goes through it, so
 * a caller controls freshness and reporting in one place.
 */
export type FetchOptions = CacheOptions;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function overpassLive(query: string, userAgent: string): Promise<{ elements: unknown[] }> {
  let lastError: unknown;
  // Two passes over the endpoints with a wait between them. Overpass returns
  // 429/504 for saturation that clears in seconds, so giving up on the first
  // round throws away a request that would have succeeded shortly after. This
  // is affordable precisely because the cache means it happens rarely.
  for (const [attempt, backoffMs] of [0, 8_000].entries()) {
    if (backoffMs > 0) await sleep(backoffMs);
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "User-Agent": userAgent, "Content-Type": "text/plain" },
          body: query,
          signal: AbortSignal.timeout(90_000),
        });
        if (!response.ok) {
          throw new Error(`${endpoint} answered ${response.status}`);
        }
        const text = await response.text();
        // Overpass reports overload as an HTML page with a 200, so parsing is
        // the actual health check.
        if (!text.trimStart().startsWith("{")) {
          throw new Error(`${endpoint} returned a non-JSON body (usually means it is overloaded)`);
        }
        return JSON.parse(text) as { elements: unknown[] };
      } catch (error) {
        lastError = error;
        void attempt;
      }
    }
  }
  throw new Error(
    `Overpass is not answering (tried ${OVERPASS_ENDPOINTS.length} endpoints twice). Last error: ${String(lastError)}. ` +
      `This is usually transient — retry in a few minutes.`,
  );
}

/**
 * Runs an Overpass query, through the on-disk cache.
 *
 * The cache key is the query text itself rather than a hand-built key of bbox
 * and types. The query already derives from every input, so it cannot drift
 * out of sync with them: change the tags behind a landmark type and the key
 * changes with it, no invalidation to remember.
 */
async function overpass(
  query: string,
  userAgent: string,
  label: string,
  options: FetchOptions = {},
): Promise<{ elements: unknown[] }> {
  return withCache(`overpass:${query}`, label, () => overpassLive(query, userAgent), options);
}

/** Coastline ways inside the bbox. Absent inland, which is not an error. */
export async function fetchCoastline(
  bbox: BBox,
  userAgent: string,
  options: FetchOptions = {},
): Promise<OsmWay[]> {
  const data = await overpass(
    `[out:json][timeout:60];(way["natural"="coastline"]${bboxClause(bbox)};);out geom;`,
    userAgent,
    "coastline",
    options,
  );
  return data.elements as OsmWay[];
}

/** Major roads inside the bbox, which give the map its recognisable shape. */
export async function fetchRoads(
  bbox: BBox,
  userAgent: string,
  options: FetchOptions = {},
): Promise<OsmWay[]> {
  const data = await overpass(
    `[out:json][timeout:60];(way["highway"~"^(motorway|trunk|primary|secondary)$"]${bboxClause(bbox)};);out geom;`,
    userAgent,
    "roads",
    options,
  );
  return data.elements as OsmWay[];
}

/**
 * Discovers landmarks of the requested types inside the bbox.
 *
 * Returns whatever OSM has, including nothing. An empty result is warned about
 * by the caller and does not abort the run: a map without labels is plain, not
 * wrong, and a missing landmark is a poor reason to lose a video.
 */
export async function fetchLandmarks(
  bbox: BBox,
  types: ReferenceType[],
  userAgent: string,
  options: FetchOptions = {},
): Promise<Landmark[]> {
  const clauses = types
    .flatMap((type) => REFERENCE_TYPES[type])
    .flatMap((tag) => {
      const [key, value] = tag.split("=");
      const selector = `["${key}"="${value}"]["name"]`;
      // Landmarks are mapped as nodes or ways depending on the feature;
      // querying only nodes misses most malls and every campus. Relations are
      // deliberately left out: they multiply the query's cost on a free public
      // server for features that are almost always also mapped as a way, and
      // an Overpass timeout costs the whole run.
      return ["node", "way"].map((kind) => `${kind}${selector}${bboxClause(bbox)};`);
    });

  const data = await overpass(
    `[out:json][timeout:60];(${clauses.join("")});out center;`,
    userAgent,
    "landmarks",
    options,
  );

  const landmarks: Landmark[] = [];
  for (const raw of data.elements) {
    const element = raw as {
      lat?: number;
      lon?: number;
      center?: { lat: number; lon: number };
      tags?: { name?: string };
    };
    const name = element.tags?.name;
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if (name && typeof lat === "number" && typeof lon === "number") {
      landmarks.push({ name, lat, lon });
    }
  }

  // OSM often carries the same landmark as both a node and an enclosing way.
  const seen = new Set<string>();
  return landmarks.filter((landmark) => {
    const key = landmark.name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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

  // Cached like the Overpass calls, and for a sharper reason than speed: the
  // geocoding pass runs *before* the map is fetched, so an Overpass failure
  // used to throw away every Nominatim result already obtained and hammer the
  // service again on the retry. Caching here is what makes a re-run cost no
  // network at all.
  //
  // Longer TTL than the map: a venue's address moves far less often than a
  // city's streets get remapped.
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
