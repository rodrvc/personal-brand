/**
 * Scene timing and camera math for the reel.
 *
 * Pure functions of time and the input — no React, no Remotion, no MapLibre —
 * so the engine's tests exercise exactly the code the render runs. Everything
 * here is engine-owned editing rhythm, not brand identity: a profile supplies
 * items and a bbox-derived wide framing, never a timing or an easing.
 */

/** Canvas of a vertical reel. Not configurable: it is the platform's format.
 * Kept in sync by hand with `../../types.ts` — this file cannot import across
 * the Remotion bundle boundary. */
export const CANVAS_WIDTH = 1080;
export const CANVAS_HEIGHT = 1920;
export const FPS = 30;

/** Scene timing, in seconds. */
export const TIMING = {
  cover: 2.2,
  map: 1.8,
  item: 3.2,
  closing: 2.0,
  /** Scenes overlap by this much so the cross-fade has somewhere to happen. */
  overlap: 0.35,
} as const;

/**
 * When the Cover actually unmounts and its text finishes fading: the cover
 * stays visible past `TIMING.cover` so it overlaps the first map scene's
 * fade-in instead of cutting to it.
 */
export const COVER_EXIT = TIMING.cover + 0.6;

/**
 * Street-level zoom the camera arrives at over each item. City-independent:
 * "close enough to read the blocks around the pin" means the same ground
 * distance everywhere.
 */
export const CLOSE_ZOOM = 17.25;

/**
 * How long the wide-to-pin camera move takes, within the map scene. Shorter
 * than `TIMING.map` on purpose: the camera arrives BEFORE the map scene ends,
 * so the pin drops on a map that has stopped moving — with the move spanning
 * the whole scene, the easeOut tail was still visibly travelling under the
 * pin. The rest of the scene (1.2→1.8) is the pin + label over the final
 * framing.
 */
export const CAMERA_MOVE_SECONDS = 1.2;

/** The pin drops exactly when the zoom stops — never over a moving map. */
export const PIN_DROP_SECONDS = CAMERA_MOVE_SECONDS;

/**
 * How long the pin's drop-and-settle spring runs. Slow enough to read as
 * deliberate, but it must finish before the scene starts fading at
 * `TIMING.map + overlap` (1.2 + 0.75 = 1.95 < 2.15).
 */
export const PIN_SETTLE_SECONDS = 0.75;

/** The label enters a beat after the pin starts dropping — the owner prefers reading the place name right away over clearing the drop. */
export const LABEL_IN_SECONDS = CAMERA_MOVE_SECONDS + 0.15;

export interface WideFraming {
  /** [lng, lat] centroid of the week's verified items, clamped to the bbox. */
  center: [number, number];
  /** Zoom at which the framed area fits the canvas, minus a little breathing room. */
  zoom: number;
  /** [lonSpan, latSpan] of the frame actually used, in degrees — scales the drift offsets. */
  span: [number, number];
}

export interface CameraTarget {
  lng: number;
  lat: number;
}

export interface Camera {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
}

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export const lerp = (from: number, to: number, progress: number): number =>
  from + (to - from) * progress;

/** Ease-out quint — numerically close to cubic-bezier(0.22, 1, 0.36, 1). */
export const easeOut = (value: number): number => 1 - (1 - clamp01(value)) ** 5;

export const mapStart = (index: number): number =>
  TIMING.cover + index * (TIMING.map + TIMING.item);

export const itemStart = (index: number): number => mapStart(index) + TIMING.map;

export const closingStart = (count: number): number =>
  TIMING.cover + count * (TIMING.map + TIMING.item);

export const totalSeconds = (count: number): number => closingStart(count) + TIMING.closing;

export const totalFrames = (count: number): number => Math.round(totalSeconds(count) * FPS);

/** Which item's map the camera is flying towards at this moment. */
export const activeItemIndex = (seconds: number, count: number): number => {
  for (let i = count - 1; i >= 0; i -= 1) {
    if (seconds >= mapStart(i)) return i;
  }
  return 0;
};

/**
 * The camera as a pure function of time.
 *
 * During each item's map scene it eases from the wide framing to the item's
 * coordinate at street zoom, and holds there under the item card. The wide
 * starting point is nudged off-centre by a fraction of the framed span so the
 * move reads as travel rather than a straight zoom; the fractions are the
 * prototype's offsets expressed relative to its frame, which is what makes
 * them hold for any city.
 */
export function cameraAt(
  seconds: number,
  wide: WideFraming,
  targets: CameraTarget[],
): Camera {
  if (targets.length === 0) {
    throw new Error('ReelProps.items is empty — nothing to render');
  }
  const active = activeItemIndex(seconds, targets.length);
  const target = targets[active]!;
  const progress = easeOut((seconds - mapStart(active)) / CAMERA_MOVE_SECONDS);
  const [lonSpan, latSpan] = wide.span;

  return {
    center: [
      lerp(wide.center[0] - 0.12 * lonSpan, target.lng, progress),
      lerp(wide.center[1] - 0.07 * latSpan, target.lat, progress),
    ],
    zoom: lerp(wide.zoom, CLOSE_ZOOM, progress),
    // Top-down, always: pitched raster tiles leave an empty horizon in
    // headless renders, and a bearing would rotate the street names.
    bearing: 0,
    pitch: 0,
  };
}

/**
 * Fade-in/fade-out envelope for a scene, matching the prototype's overlaps.
 */
export function opacityBetween(
  seconds: number,
  start: number,
  end: number,
  fade: number = TIMING.overlap,
): number {
  const fadeIn = clamp01((seconds - start) / fade);
  const fadeOut = clamp01((end - seconds) / fade);
  return Math.min(fadeIn, fadeOut);
}
