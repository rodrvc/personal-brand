/**
 * Web Mercator projection and map placement.
 *
 * Nothing here knows a city. Every function takes a bounding box supplied by
 * the caller, which the recipe requires the profile to declare.
 */

import { CANVAS_HEIGHT, CANVAS_WIDTH, type ItemPlacement } from "./types.js";

/** `[latMin, lonMin, latMax, lonMax]`, as declared in a profile's recipe. */
export type BBox = readonly [number, number, number, number];

/** Size of the generated SVG. Larger than the canvas so zooming stays sharp. */
export const MAP_WIDTH = 2400;
export const MAP_HEIGHT = 4200;

/**
 * The map layer is drawn larger than the canvas so it still covers 1080x1920
 * when centred on a coordinate near the edge of the bbox.
 *
 * At 0.55 the layer fell short and the page background showed through as a
 * pale band on items near the border. 1.0 is the minimum that covers; 1.15
 * keeps a margin. `placeItem` asserts coverage per item rather than trusting
 * this constant, so lowering it fails loudly instead of shipping the band.
 */
export const MAP_SCALE = 1.15;

/**
 * The largest bbox side the engine accepts, in degrees.
 *
 * Two independent reasons, both of which bite late if unchecked: at a wider
 * span the reel's zoom no longer reads as arriving somewhere, and an Overpass
 * query over that area times out after ~60s against a public server. Failing
 * at load costs a sentence; failing at fetch costs a minute and looks like a
 * network problem.
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
        `At that scale the reel's zoom does not read, and the Overpass query times out. Narrow the box.`,
    );
  }
  return [latMin, lonMin, latMax, lonMax];
}

/** Mercator y, in radians-projected units. */
function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 180 / 2));
}

/** Projects a coordinate to a pixel position inside the generated SVG. */
export function project(bbox: BBox, lat: number, lon: number): { x: number; y: number } {
  const [latMin, lonMin, latMax, lonMax] = bbox;
  const yMin = mercatorY(latMin);
  const yMax = mercatorY(latMax);
  return {
    x: ((lon - lonMin) / (lonMax - lonMin)) * MAP_WIDTH,
    y: MAP_HEIGHT - ((mercatorY(lat) - yMin) / (yMax - yMin)) * MAP_HEIGHT,
  };
}

export function isInsideBBox(bbox: BBox, lat: number, lon: number): boolean {
  const [latMin, lonMin, latMax, lonMax] = bbox;
  return lat >= latMin && lat <= latMax && lon >= lonMin && lon <= lonMax;
}

/**
 * Whether a coordinate can be centred on the canvas with the map still
 * covering it.
 *
 * A point at the very edge of the bbox cannot: centring it puts half the
 * canvas beyond where the map exists. That is geometry, not a bug — no
 * `MAP_SCALE` fixes it, because the shortfall grows with the scale it would
 * be fixed by.
 *
 * So the engine treats an edge coordinate as an item-level problem (drop it
 * and say why, like any other unrenderable item) rather than a crash. The
 * usable fraction is the canvas half-span expressed in map units: with the
 * layer at `MAP_SCALE`, a pin needs `canvas/2` of map on each side of it.
 */
export function isPlaceable(bbox: BBox, lat: number, lon: number): boolean {
  const { x, y } = project(bbox, lat, lon);
  const width = MAP_WIDTH * MAP_SCALE;
  const height = MAP_HEIGHT * MAP_SCALE;
  const marginX = CANVAS_WIDTH / 2 / width;
  const marginY = CANVAS_HEIGHT / 2 / height;
  const pctX = x / MAP_WIDTH;
  const pctY = y / MAP_HEIGHT;
  return pctX >= marginX && pctX <= 1 - marginX && pctY >= marginY && pctY <= 1 - marginY;
}

/**
 * Works out where the map layer must sit so a coordinate lands at the centre
 * of the canvas, and verifies the layer still covers the canvas from there.
 *
 * The coverage check is an assertion, not a clamp. Nudging the layer back
 * inside would silently move the pin off its street — a wrong pin looks
 * exactly as correct as a right one, so this fails instead.
 */
export function placeItem(bbox: BBox, lat: number, lon: number, label: string): ItemPlacement {
  const { x, y } = project(bbox, lat, lon);
  const pctX = x / MAP_WIDTH;
  const pctY = y / MAP_HEIGHT;
  const width = Math.round(MAP_WIDTH * MAP_SCALE);
  const height = Math.round(MAP_HEIGHT * MAP_SCALE);
  const left = Math.round(CANVAS_WIDTH / 2 - pctX * width);
  const top = Math.round(CANVAS_HEIGHT / 2 - pctY * height);

  if (left > 0 || left + width < CANVAS_WIDTH) {
    throw new Error(
      `The map does not cover the canvas horizontally for "${label}" (${lat}, ${lon}). ` +
        `Raise MAP_SCALE (currently ${MAP_SCALE}) or narrow map.bbox.`,
    );
  }
  if (top > 0 || top + height < CANVAS_HEIGHT) {
    throw new Error(
      `The map does not cover the canvas vertically for "${label}" (${lat}, ${lon}). ` +
        `Raise MAP_SCALE (currently ${MAP_SCALE}) or narrow map.bbox.`,
    );
  }

  return {
    pctX: Number((pctX * 100).toFixed(3)),
    pctY: Number((pctY * 100).toFixed(3)),
    left,
    top,
    width,
    height,
  };
}
