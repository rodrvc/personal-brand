/**
 * The props contract between the engine's orchestrator and this composition.
 *
 * Everything arrives *resolved*: colors as CSS values, copy already
 * interpolated, images staged under `public/`. The composition knows nothing
 * about `brand.json`, recipes or profiles — `render-reel-week.ts` is the only
 * place that reads those and it flattens them into this shape. That keeps the
 * whole brand vocabulary on the Node side, where the schema helpers live.
 */

export type ReelPropsItem = {
  title: string;
  /** Already formatted for display ("Jue 23 Jul · 20:00"). */
  when: string;
  where: string;
  /** Short label shown over the map — usually the venue, not the address. */
  mapLabel: string;
  /** Upper-cased chip text; empty string hides the chip. */
  category: string;
  /** CSS background for the category chip (solid color or gradient). */
  categoryBackground: string;
  /** Path under `public/` (via staticFile) or an absolute URL. */
  image: string;
  lng: number;
  lat: number;
}

/**
 * A scene with its timing resolved on the Node side, in seconds. Mirrors
 * `Scene` in `timeline.ts` (this file cannot import across the bundle
 * boundary). `itemIndex` points into `items`, in the order the Node side
 * already sorted them.
 */
export type ReelScene = {
  kind: 'cover' | 'item' | 'closing';
  itemIndex?: number;
  narrationSeconds?: number;
  minSeconds?: number;
  start: number;
  duration: number;
  end: number;
}

export type ReelProps = {
  locale: string;
  colors: {
    accent: string;
    surface: string;
    onSurface: string;
    onSurfaceMuted: string;
    wordmark: string;
    /** Pre-blended decorative tints (the Node side owns the alpha math). */
    orbA: string;
    orbB: string;
    labelPlate: string;
    credit: string;
    pulse: string;
  };
  /** CSS gradient behind the cover and the closing card. */
  coverGradient: string;
  fonts: {
    /**
     * Font-family name for body text. It must already exist in the headless
     * Chromium that renders the video (system font or one Chromium bundles):
     * nothing loads it. If the brand needs an exact face, today only the logo
     * font travels as a file (`logoFontFile`); the body falls back through the
     * CSS font stack otherwise.
     */
    body: string;
    logo: string;
  };
  /** Path under `public/` of a woff2 for the logo face, when the profile ships one. */
  logoFontFile?: string;
  copy: {
    coverTitle: string;
    coverSubtitle: string;
    coverCount: string;
    closingCta: string;
    wordmark: string;
    site: string;
  };
  /** Basemap credit drawn over every map scene. Engine-owned, never blank. */
  attribution: string;
  map: {
    center: [number, number];
    zoom: number;
    span: [number, number];
  };
  items: ReelPropsItem[];
  /**
   * Optional scene list derived from a storyboard ("audio first"): each
   * scene lasts at least its narration. Absent, the composition runs the
   * fixed rhythm in `timeline.ts` — output identical to a reel without a
   * storyboard.
   */
  scenes?: ReelScene[];
  /**
   * Transition mode: 'cut' (default) for sharp transitions with no overlap,
   * or 'crossfade' for overlapping scene fades. When 'cut', each scene
   * appears at full opacity at its start and ends abruptly.
   */
  transitions?: 'crossfade' | 'cut';
}
