import { BRAND } from "../brand.js";
import { wrapDocument } from "../document.js";
import type { Slide, SlideTemplate } from "../types.js";

/**
 * Variant C — Decorative frame overlay.
 * Photo fills the whole slide inside a 24px gold->coral gradient border.
 * Text lives in a thin semi-transparent petrol strip at the top so it never
 * competes with the framed photo below (legibility over cleverness).
 */
export const renderDecorativeFrame: SlideTemplate = (slide: Slide) => {
  const borderWidth = 24;

  const styles = `
    .frame {
      width: 100%; height: 100%;
      background: ${BRAND.gradients.goldCoral};
      padding: ${borderWidth}px;
      font-family: ${BRAND.fonts.body};
    }
    .window {
      position: relative;
      width: 100%; height: 100%;
      border-radius: ${BRAND.radius.card};
      overflow: hidden;
    }
    .window img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .strip {
      position: absolute; top: 0; left: 0; right: 0;
      background: rgba(26, 95, 122, 0.72);
      color: #ffffff;
      padding: 40px 56px;
    }
    .meta {
      font-size: 24px; font-weight: 600; letter-spacing: 0.04em;
      text-transform: uppercase; color: ${BRAND.colors.gold};
      margin-bottom: 10px;
    }
    .title { font-size: 44px; font-weight: 700; line-height: 1.15; margin-bottom: 8px; }
    .subtitle { font-size: 26px; font-weight: 400; opacity: 0.95; }
  `;

  const body = `
    <div class="frame">
      <div class="window">
        <img src="${slide.image}" alt="">
        <div class="strip">
          <div class="meta">${slide.meta}</div>
          <div class="title">${slide.title}</div>
          <div class="subtitle">${slide.subtitle}</div>
        </div>
      </div>
    </div>
  `;

  return wrapDocument(styles, body);
};
