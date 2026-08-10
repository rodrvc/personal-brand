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

// Scene timing (TIMING) now lives in `remotion/src/timeline.ts`, next to the
// camera math the Remotion composition renders with — still engine-owned
// editing rhythm, never brand identity.

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
