/**
 * The data contract for a reel.
 *
 * Deliberately separate from the carousel's `Slide`: a reel item carries a
 * geographic coordinate and a pre-formatted `when` string, and the carousel
 * has neither. Reusing `Slide` here would have meant widening it with two
 * fields no carousel template renders.
 */

/** Canvas of a vertical reel. Not configurable: it is the platform's format. */
export const CANVAS_WIDTH = 1080;
export const CANVAS_HEIGHT = 1920;

/**
 * Scene timing, in seconds. Engine-owned, not profile-owned — see
 * `system/recipes/reel-week.md` stage 7. These are editing rhythm validated
 * against the format, not brand identity.
 */
export const TIMING = {
  cover: 2.2,
  map: 1.8,
  item: 3.2,
  closing: 2.0,
  /** Scenes overlap by this much so the cross-fade has somewhere to happen. */
  overlap: 0.35,
} as const;

/** How far the map zooms in over a transition. */
export const MAP_ZOOM = 2.4;

export interface ReelItem {
  title: string;
  /** `YYYY-MM-DD`. Not rendered — it is what lets the engine verify the period. */
  date: string;
  /** Already formatted for display ("Thu 23 Jul · 20:00"). */
  when: string;
  where: string;
  image: string;
  category?: string;
  lat: number;
  lng: number;
  /** Short label shown over the map — usually the venue, not the full address. */
  mapLabel: string;
}

export interface ReelInput {
  city: string;
  region?: string;
  /**
   * Hosts the item images are allowed to come from, copied verbatim from the
   * profile recipe's `source.image_hosts`. Omitted means "no allowlist"; an
   * empty array is an error, not "allow nothing" — see the carousel's
   * `verify-slides.ts` for the full argument, which applies unchanged here.
   */
  sourceImageHosts?: string[];
  items: ReelItem[];
}

/**
 * An item that has been checked against the period and the image-host policy.
 *
 * Same nominal-type trick as the carousel's `VerifiedSlide`, and for the same
 * reason: the render entry point accepts only this type, so "did anyone verify
 * these?" is answered by the compiler rather than by reviewer memory. The
 * symbol is `declare`d and never exported, so the type cannot be constructed —
 * `verifyOrThrow` is the only place that mints it.
 */
declare const verified: unique symbol;
export type VerifiedReelItem = ReelItem & { readonly [verified]: true };

/** Where an item sits on the generated map, in canvas coordinates. */
export interface ItemPlacement {
  /** Position of the pin as a percentage of the SVG, for `transform-origin`. */
  pctX: number;
  pctY: number;
  /** Offset and size of the map layer so the pin lands at canvas centre. */
  left: number;
  top: number;
  width: number;
  height: number;
}
