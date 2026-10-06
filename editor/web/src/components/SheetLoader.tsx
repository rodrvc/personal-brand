import { t } from "../i18n";
import "./SheetLoader.css";

export interface SheetLoaderProps {
  /** One-line caption in the chrome's mono micro-label style (e.g. "Cargando carruseles", "Creando carrusel", "Abriendo carrusel"). Optional visually; a screen-reader-only fallback text is always announced regardless. */
  caption?: string;
  /**
   * The travelling light's colour, and the source every other colour here
   * derives from via `color-mix()` (the glow blur, the placeholder-block
   * tint) — never a second hardcoded value. Omit when there's no brand in
   * context (the profile picker's own loading state): falls back to the
   * chrome's own `--ui-accent`.
   */
  accentColor?: string;
  className?: string;
}

/**
 * "The sheet that composes itself" — the app's one loading indicator,
 * replacing three previously-different loading states (profile picker
 * skeleton cards, carousel list skeleton rows, editor's plain "Cargando
 * carrusel…" text) with the same animated piece everywhere, so a
 * multi-step flow (e.g. create → editor) reads as one continuous load
 * rather than a sequence of different-looking screens.
 *
 * An SVG outline of a 4:5 sheet with a short bright segment travelling
 * around its border (stroke-dasharray/dashoffset, `pathLength="1000"` so
 * the numbers are independent of the actual rounded-rect geometry) trailed
 * by a wider, blurred copy of the same stroke for the glow. Inside,
 * placeholder blocks (title bar, image block, three text lines) fade/slide
 * in one after another on a staggered `animation-delay`, hold, fade out,
 * and loop — "a slide being composed".
 *
 * `prefers-reduced-motion` is handled twice, deliberately: `tokens.css`'s
 * existing global rule already disables every animation here (which,
 * because the *base* — non-animated — CSS already declares blocks at full
 * opacity, means "blocks visible" falls out for free); `SheetLoader.css`
 * additionally collapses the travelling segment into one steady stroke
 * around the whole perimeter instead of leaving it frozen mid-travel on
 * one edge, matching "steady (non-moving) glow" rather than "randomly stuck
 * highlight".
 */
export function SheetLoader({ caption, accentColor, className }: SheetLoaderProps) {
  const style = accentColor ? ({ "--sheet-loader-accent": accentColor } as React.CSSProperties) : undefined;

  return (
    <div className={["sheet-loader", className].filter(Boolean).join(" ")} role="status" aria-live="polite">
      <svg className="sheet-loader-svg" viewBox="0 0 200 250" style={style} aria-hidden="true">
        <rect className="sheet-loader-outline" x="4" y="4" width="192" height="242" rx="10" />
        <rect
          className="sheet-loader-glow"
          x="4"
          y="4"
          width="192"
          height="242"
          rx="10"
          pathLength={1000}
        />
        <rect
          className="sheet-loader-light"
          x="4"
          y="4"
          width="192"
          height="242"
          rx="10"
          pathLength={1000}
        />
        <g className="sheet-loader-blocks">
          <rect className="sheet-loader-block sheet-loader-block-title" x="24" y="26" width="88" height="14" rx="3" />
          <rect className="sheet-loader-block sheet-loader-block-image" x="24" y="54" width="152" height="96" rx="4" />
          <rect className="sheet-loader-block sheet-loader-block-line1" x="24" y="166" width="152" height="10" rx="3" />
          <rect className="sheet-loader-block sheet-loader-block-line2" x="24" y="184" width="130" height="10" rx="3" />
          <rect className="sheet-loader-block sheet-loader-block-line3" x="24" y="202" width="100" height="10" rx="3" />
        </g>
      </svg>
      <span className={caption ? "sheet-loader-caption" : "sheet-loader-caption sr-only"}>
        {caption ?? t("sheetLoader.fallback")}
      </span>
    </div>
  );
}
