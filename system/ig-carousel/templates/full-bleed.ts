import { color, withAlpha, type BrandTokens } from "../brand-schema.js";
import { wrapDocument } from "../document.js";
import type { Slide, SlideTemplate } from "../types.js";

/**
 * Variant A — Full-bleed photo + bottom overlay.
 * Photo fills the entire 4:5 frame; a dark gradient (transparent -> the
 * brand's wordmark color) sits over the bottom third with title/subtitle/meta
 * in white text. Poster/story look.
 */
export const renderFullBleed: SlideTemplate = (brand: BrandTokens, slide: Slide) => {
  const scrim = color(brand, "wordmark");

  const styles = `
    .frame { position: relative; width: 100%; height: 100%; }
    .frame img {
      width: 100%; height: 100%; object-fit: cover; display: block;
    }
    .overlay {
      position: absolute; left: 0; right: 0; bottom: 0;
      height: 42%;
      background: linear-gradient(to bottom, ${withAlpha(scrim, 0)} 0%, ${withAlpha(scrim, 0.55)} 45%, ${withAlpha(scrim, 0.92)} 100%);
      display: flex; flex-direction: column; justify-content: flex-end;
      padding: 56px 64px 72px;
      font-family: ${brand.fonts.body};
      color: #ffffff;
    }
    .meta {
      font-size: 28px; font-weight: 600; letter-spacing: 0.04em;
      text-transform: uppercase; opacity: 0.9; margin-bottom: 12px;
    }
    .title {
      font-size: 56px; font-weight: 700; line-height: 1.1; margin-bottom: 16px;
    }
    .subtitle { font-size: 32px; font-weight: 400; opacity: 0.95; }
  `;

  const body = `
    <div class="frame">
      ${slide.image ? `<img src="${slide.image}" alt="">` : ""}
      <div class="overlay">
        <div class="meta">${slide.meta}</div>
        <div class="title">${slide.title}</div>
        <div class="subtitle">${slide.subtitle}</div>
      </div>
    </div>
  `;

  return wrapDocument(styles, body, brand.googleFontsHref);
};

// Reads only core brand data (colors, fonts, radius) — nothing optional.
renderFullBleed.features = [] as const;
