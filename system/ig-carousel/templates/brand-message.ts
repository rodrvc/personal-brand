import { color, templateCopy, type BrandTokens } from "../brand-schema.js";
import { wrapDocument } from "../document.js";
import type { Slide, SlideTemplate } from "../types.js";

/**
 * Variant E — "Brand message": typography-led slide for carousels that carry
 * a statement (hook, pitch, CTA) rather than an event listing. No photo —
 * a profile with no brand photography library (see its `brand-spec.md`)
 * leans entirely on the type pairing and accent flourish already established
 * in `list-format.ts`, applied to one big idea per slide instead of a grid of
 * event cards.
 *
 * `slide.meta` is the small eyebrow label above the title; `slide.subtitle`
 * is the supporting line below it. Background stays the profile's single
 * surface color across every slide (design-principles.md's "max 1-2
 * background colors across the whole carousel").
 */
export const renderBrandMessage: SlideTemplate = (
  brand: BrandTokens,
  slide: Slide,
  options?: { index?: number; total?: number },
) => {
  const accent = color(brand, "accent");
  const copy = templateCopy(brand, "brandMessage");
  const showNumber = options?.index && options?.total;

  const styles = `
    .frame {
      position: relative;
      width: 100%; height: 100%;
      background: ${color(brand, "surface")};
      font-family: ${brand.fonts.body};
      display: flex; flex-direction: column;
      padding: 64px;
    }
    .wordmark {
      font-family: ${brand.fonts.handwritten};
      font-weight: 700;
      font-size: 40px;
      color: ${color(brand, "wordmark")};
    }
    .deco {
      position: absolute;
      top: 140px;
      right: 48px;
      width: 170px;
      height: 170px;
      pointer-events: none;
    }
    .content {
      flex: 1;
      display: flex;
      flex-direction: column;
      justify-content: center;
      max-width: 880px;
    }
    .eyebrow {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: ${accent};
      margin-bottom: 20px;
    }
    .title {
      font-family: ${brand.fonts.handwritten};
      font-weight: 700;
      font-size: 72px;
      line-height: 1.08;
      color: ${color(brand, "onSurface")};
    }
    .subtitle {
      margin-top: 28px;
      font-size: 32px;
      line-height: 1.4;
      color: ${color(brand, "onSurfaceMuted")};
      max-width: 720px;
    }
    .footer {
      margin-top: auto;
      display: flex; align-items: center; justify-content: space-between;
      font-size: 22px;
      color: ${color(brand, "onSurfaceMuted")};
    }
    .footer .link { color: ${accent}; font-weight: 600; }
    .page-num {
      font-size: 22px;
      font-weight: 600;
      color: ${color(brand, "onSurfaceMuted")};
    }
  `;

  const flourish = `
    <svg class="deco" viewBox="0 0 170 170" fill="none">
      <circle cx="130" cy="40" r="26" stroke="${color(brand, 'flourish')}" stroke-width="2" stroke-opacity="0.55"/>
      <circle cx="130" cy="40" r="40" stroke="${color(brand, 'flourish')}" stroke-width="2" stroke-opacity="0.35"/>
      <path d="M40 100 L44 112 L56 116 L44 120 L40 132 L36 120 L24 116 L36 112 Z" fill="${accent}" fill-opacity="0.7"/>
      <path d="M84 130 L86 137 L93 139 L86 141 L84 148 L82 141 L75 139 L82 137 Z" fill="${accent}" fill-opacity="0.5"/>
    </svg>
  `;

  const body = `
    <div class="frame">
      <div class="wordmark">${brand.copy.wordmark}</div>
      ${flourish}
      <div class="content">
        <div class="eyebrow">${slide.meta}</div>
        <div class="title">${slide.title}</div>
        <div class="subtitle">${slide.subtitle}</div>
      </div>
      <div class="footer">
        <span>${copy.footerCta} <span class="link">${brand.copy.site}</span></span>
        ${showNumber ? `<span class="page-num">${options!.index}/${options!.total}</span>` : ""}
      </div>
    </div>
  `;

  return wrapDocument(styles, body, brand.googleFontsHref);
};

renderBrandMessage.features = ["brandMessage"] as const;
