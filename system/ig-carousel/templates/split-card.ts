import { color, type BrandTokens } from "../brand-schema.js";
import { wrapDocument } from "../document.js";
import type { Slide, SlideTemplate } from "../types.js";

/**
 * Variant B — Split card: photo top ~70% + solid brand-color block bottom
 * ~30%. Card look rather than poster look.
 */
export const renderSplitCard: SlideTemplate = (brand: BrandTokens, slide: Slide) => {
  const styles = `
    .frame {
      width: 100%; height: 100%;
      display: flex; flex-direction: column;
      font-family: ${brand.fonts.body};
    }
    .photo { height: 70%; overflow: hidden; }
    .photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .info {
      height: 30%;
      background: ${color(brand, "wordmark")};
      color: #ffffff;
      display: flex; flex-direction: column; justify-content: center;
      padding: 0 64px;
    }
    .meta {
      font-size: 26px; font-weight: 600; letter-spacing: 0.04em;
      text-transform: uppercase; color: ${color(brand, "highlight")};
      margin-bottom: 14px;
    }
    .title { font-size: 48px; font-weight: 700; line-height: 1.15; margin-bottom: 14px; }
    .subtitle { font-size: 30px; font-weight: 400; opacity: 0.9; }
  `;

  const body = `
    <div class="frame">
      <div class="photo">${slide.image ? `<img src="${slide.image}" alt="">` : ""}</div>
      <div class="info">
        <div class="meta">${slide.meta}</div>
        <div class="title">${slide.title}</div>
        <div class="subtitle">${slide.subtitle}</div>
      </div>
    </div>
  `;

  return wrapDocument(styles, body, brand.googleFontsHref);
};

// Reads only core brand data (colors, fonts, radius) — nothing optional.
renderSplitCard.features = [] as const;
