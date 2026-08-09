import { color, withAlpha, type BrandTokens } from "../brand-schema.js";
import { wrapDocument } from "../document.js";
import type { Slide, SlideTemplate } from "../types.js";

/**
 * Variant C — Decorative frame overlay.
 * Photo fills the whole slide inside a 24px gradient border. Text lives in a
 * thin semi-transparent strip at the top so it never competes with the framed
 * photo below (legibility over cleverness).
 *
 * Uses the profile's first declared gradient — the engine doesn't know any
 * gradient by name, so a profile declaring none simply gets a flat fill in
 * its wordmark color.
 */
export const renderDecorativeFrame: SlideTemplate = (brand: BrandTokens, slide: Slide) => {
  const borderWidth = 24;
  const border = Object.values(brand.gradients ?? {})[0] ?? color(brand, "wordmark");

  const styles = `
    .frame {
      width: 100%; height: 100%;
      background: ${border};
      padding: ${borderWidth}px;
      font-family: ${brand.fonts.body};
    }
    .window {
      position: relative;
      width: 100%; height: 100%;
      border-radius: ${brand.radius.card};
      overflow: hidden;
    }
    .window img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .strip {
      position: absolute; top: 0; left: 0; right: 0;
      background: ${withAlpha(color(brand, "wordmark"), 0.72)};
      color: #ffffff;
      padding: 40px 56px;
    }
    .meta {
      font-size: 24px; font-weight: 600; letter-spacing: 0.04em;
      text-transform: uppercase; color: ${color(brand, "highlight")};
      margin-bottom: 10px;
    }
    .title { font-size: 44px; font-weight: 700; line-height: 1.15; margin-bottom: 8px; }
    .subtitle { font-size: 26px; font-weight: 400; opacity: 0.95; }
  `;

  const body = `
    <div class="frame">
      <div class="window">
        ${slide.image ? `<img src="${slide.image}" alt="">` : ""}
        <div class="strip">
          <div class="meta">${slide.meta}</div>
          <div class="title">${slide.title}</div>
          <div class="subtitle">${slide.subtitle}</div>
        </div>
      </div>
    </div>
  `;

  return wrapDocument(styles, body, brand.googleFontsHref);
};

// Reads only core brand data (colors, fonts, radius) — nothing optional.
renderDecorativeFrame.features = [] as const;
