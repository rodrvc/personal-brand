/**
 * Bounding-box validation and camera framing for the tile-based renderer.
 *
 * Nothing here knows a city. Every function takes a bounding box supplied by
 * the caller, which the recipe requires the profile to declare. The old SVG
 * projection (pixel placement, zones, map scaling) is gone: with a MapLibre
 * camera, any coordinate inside the bbox can be centred, so "where does this
 * pin land on the canvas" stopped being the engine's problem.
 */

import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./types.js";

/** `[latMin, lonMin, latMax, lonMax]`, as declared in a profile's recipe. */
export type BBox = readonly [number, number, number, number];

/**
 * The largest bbox side the engine accepts, in degrees.
 *
 * Two reasons, both of which bite late if unchecked: at a wider span the
 * reel's wide-to-street zoom no longer reads as arriving somewhere, and the
 * Nominatim geocoding is bounded to this box — a box covering half a region
 * stops narrowing anything, so ambiguous venue names start resolving to the
 * wrong town. Failing at load costs a sentence.
 */
export const MAX_BBOX_SIDE_DEGREES = 0.5;

export function validateBBox(bbox: unknown): BBox {
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new Error(
      `map.bbox must be four finite numbers [latMin, lonMin, latMax, lonMax], got: ${JSON.stringify(bbox)}`,
    );
  }
  const [latMin, lonMin, latMax, lonMax] = bbox as [number, number, number, number];
  if (latMin >= latMax || lonMin >= lonMax) {
    throw new Error(
      `map.bbox is not a rectangle: expected latMin < latMax and lonMin < lonMax, got [${bbox.join(", ")}]. ` +
        `The order is [latMin, lonMin, latMax, lonMax].`,
    );
  }
  const side = Math.max(latMax - latMin, lonMax - lonMin);
  if (side > MAX_BBOX_SIDE_DEGREES) {
    throw new Error(
      `map.bbox spans ${side.toFixed(3)}° on its longest side, above the ${MAX_BBOX_SIDE_DEGREES}° limit. ` +
        `At that scale the reel's zoom does not read as arriving anywhere, and geocoding bounded to the box ` +
        `stops being bounded to a city. Narrow the box.`,
    );
  }
  return [latMin, lonMin, latMax, lonMax];
}

export function isInsideBBox(bbox: BBox, lat: number, lon: number): boolean {
  const [latMin, lonMin, latMax, lonMax] = bbox;
  return lat >= latMin && lat <= latMax && lon >= lonMin && lon <= lonMax;
}

/** Mercator y, in radians-projected units. */
function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2));
}

/** Inverse of {@link mercatorY}: projected y back to latitude in degrees. */
function inverseMercatorLat(y: number): number {
  return ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;
}

/** A verified item's coordinate, as the renderer carries it. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/**
 * How much the points' bounding box is inflated before fitting the wide zoom:
 * padding so the outermost pin is not glued to the canvas edge.
 */
const FRAME_PADDING = 1.4;

/**
 * Minimum half-span of the wide frame, in degrees per side of the centre. A
 * week whose items all sit in one neighbourhood must still open at a framing
 * that reads as "the city", not at street zoom.
 */
const MIN_HALF_SPAN_DEGREES = 0.035;

/**
 * The closest the wide framing is allowed to start. Past this it no longer
 * reads as an establishing shot before the dive to street level.
 */
const MAX_WIDE_ZOOM = 14;

export interface WideFraming {
  /** [lng, lat] centroid of the verified items, clamped to the bbox. */
  center: [number, number];
  /** Zoom at which the framed area fits the canvas, minus a little breathing room. */
  zoom: number;
  /** [lonSpan, latSpan] of the frame actually used (the points' box, padded), in degrees. */
  span: [number, number];
}

/**
 * Zoom at which `lonSpan` degrees × the `latMin..latMax` band fits the canvas.
 *
 * Web-Mercator convention: at zoom 0 the whole world is one 512px tile, and
 * each zoom level doubles the pixels. So the zoom that fits `lonSpan` degrees
 * across `CANVAS_WIDTH` pixels solves `512 * 2^z * lonSpan/360 = CANVAS_WIDTH`,
 * i.e. `z = log2((CANVAS_WIDTH/512) * 360/lonSpan)`; vertically the band
 * covers `latFrac = (mercY(latMax) - mercY(latMin)) / 2π` of the world, so
 * `z = log2((CANVAS_HEIGHT/512) / latFrac)`. The smaller of the two fits both
 * axes, and 0.3 is subtracted for air around the edges.
 */
function fitZoom(lonSpan: number, latMin: number, latMax: number): number {
  const latFrac = (mercatorY(latMax) - mercatorY(latMin)) / (2 * Math.PI);
  const zoomForWidth = Math.log2(((CANVAS_WIDTH / 512) * 360) / lonSpan);
  const zoomForHeight = Math.log2(CANVAS_HEIGHT / 512 / latFrac);
  return Math.min(zoomForWidth, zoomForHeight) - 0.3;
}

/**
 * The wide camera framing for this reel's verified items.
 *
 * The framing is built from the ITEMS, not from the bbox: the bbox declares
 * the territory whose coordinates are valid — it is a filter, not a shot. In
 * a coastal city its midpoint sits in the water, and a wide shot centred
 * there, fitted to the whole box, opens on seconds of near-uniform ocean with
 * not a street in frame — which reads as a frozen video, not as a map.
 *
 * So instead: the centre is the centroid of the verified points (arithmetic
 * mean for longitude; the Mercator midpoint of the points' min/max for
 * latitude, since the projection stretches with latitude and the arithmetic
 * midpoint sits visibly off-centre on a tall frame), clamped to the bbox. The
 * zoom fits the points' own bounding box inflated by {@link FRAME_PADDING},
 * with a floor of {@link MIN_HALF_SPAN_DEGREES} per side, and is clamped to
 * `[fit of the full bbox, MAX_WIDE_ZOOM]` — never farther out than the city
 * the profile declared, never so close it stops reading as an establishing
 * shot.
 */
export function wideFraming(bbox: BBox, points: readonly GeoPoint[]): WideFraming {
  if (points.length === 0) {
    throw new Error(
      "wideFraming needs at least one verified item coordinate to frame — " +
        "an empty week has nothing to point the camera at.",
    );
  }
  const [latMin, lonMin, latMax, lonMax] = bbox;

  const lngs = points.map((p) => p.lng);
  const lats = points.map((p) => p.lat);
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));

  const centerLng = clamp(lngs.reduce((sum, lng) => sum + lng, 0) / lngs.length, lonMin, lonMax);
  const yMid = (mercatorY(Math.min(...lats)) + mercatorY(Math.max(...lats))) / 2;
  const centerLat = clamp(inverseMercatorLat(yMid), latMin, latMax);

  const lonHalf = Math.max(
    ((Math.max(...lngs) - Math.min(...lngs)) / 2) * FRAME_PADDING,
    MIN_HALF_SPAN_DEGREES,
  );
  const latHalf = Math.max(
    ((Math.max(...lats) - Math.min(...lats)) / 2) * FRAME_PADDING,
    MIN_HALF_SPAN_DEGREES,
  );

  const pointsFit = fitZoom(2 * lonHalf, centerLat - latHalf, centerLat + latHalf);
  const bboxFit = fitZoom(lonMax - lonMin, latMin, latMax);
  const zoom = Number(clamp(pointsFit, bboxFit, MAX_WIDE_ZOOM).toFixed(2));

  return {
    center: [Number(centerLng.toFixed(6)), Number(centerLat.toFixed(6))],
    zoom,
    span: [2 * lonHalf, 2 * latHalf],
  };
}
