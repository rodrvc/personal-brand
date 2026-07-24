import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BRAND } from "../brand.js";
import { wrapDocument } from "../document.js";
import type { Slide, SlideTemplate } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKGROUNDS_DIR = join(__dirname, "..", "backgrounds");

/**
 * Variant E — "Brand message": a presentation/onboarding carousel for people
 * who don't know Adondepo yet. Distinct in purpose from the weekly events
 * digest (`list-format.ts`, a dense scannable catalog) — this is a poster,
 * one big idea per slide.
 *
 * Went through two prior builds before this one: v1 was the generic
 * "cream background, terracotta accent, corner sparkle" default
 * `.claude/skills/frontend-design` calls out by name; v2 replaced the
 * sparkle with an SVG-drawn route/map signature (still flat CSS shapes —
 * no texture, no depth, since a Playwright/HTML render can only draw what's
 * described in flexbox/SVG). This version instead composites a real
 * AI-generated illustration per slide
 * (`system/ig-carousel/generate-backgrounds.ts`, gpt-image-1) as the
 * background — each image scene-matched to that slide's specific content
 * (e.g. slide 1's hook illustrates someone finding out about a plan too
 * late, not an abstract shape), giving the texture/depth HTML/CSS alone
 * cannot produce, while type and brand marks stay real HTML text (crisp,
 * on-brand, never baked into the image where it could be misspelled or
 * off-font).
 *
 * Falls back to the flat brand-color background (no image) if a
 * background PNG for this slide index is missing, so the template never
 * hard-fails when backgrounds haven't been generated yet.
 */
export const renderBrandMessage: SlideTemplate = (
  slide: Slide,
  options?: { index?: number; total?: number },
) => {
  const index = options?.index ?? 1;
  const total = options?.total ?? 1;

  let backgroundDataUri: string | null = null;
  try {
    const imgPath = join(BACKGROUNDS_DIR, `slide-${index}.png`);
    const b64 = readFileSync(imgPath).toString("base64");
    backgroundDataUri = `data:image/png;base64,${b64}`;
  } catch {
    backgroundDataUri = null;
  }

  const ink = "#ffffff";
  const inkSoft = "rgba(255,255,255,0.85)";

  const styles = `
    .frame {
      position: relative;
      width: 100%; height: 100%;
      background: ${backgroundDataUri ? BRAND.colors.backgroundLight : BRAND.colors.petrol};
      font-family: ${BRAND.fonts.body};
      overflow: hidden;
    }
    .bg {
      position: absolute;
      inset: 0;
      width: 100%; height: 100%;
      object-fit: cover;
    }
    .scrim {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      height: 56%;
      background: linear-gradient(to bottom, rgba(26,45,58,0) 0%, rgba(20,35,45,0.55) 35%, rgba(15,28,36,0.92) 100%);
    }
    .header {
      position: relative;
      z-index: 1;
      display: flex; align-items: center; justify-content: space-between;
      padding: 48px 56px 0;
    }
    .wordmark {
      font-family: ${BRAND.fonts.logo};
      font-size: 32px;
      color: #ffffff;
      text-shadow: 0 2px 12px rgba(0,0,0,0.35);
    }
    .stop-count {
      font-size: 19px;
      font-weight: 700;
      color: rgba(255,255,255,0.9);
      letter-spacing: 0.06em;
      text-shadow: 0 1px 8px rgba(0,0,0,0.35);
    }
    .content {
      position: absolute;
      left: 56px; right: 56px; bottom: 64px;
      z-index: 1;
    }
    .eyebrow {
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: ${BRAND.colors.gold};
      margin-bottom: 16px;
    }
    .title {
      font-family: ${BRAND.fonts.handwritten};
      font-weight: 700;
      font-size: 84px;
      line-height: 1.0;
      color: ${ink};
      max-width: 940px;
    }
    .subtitle {
      margin-top: 22px;
      font-size: 26px;
      line-height: 1.4;
      color: ${inkSoft};
      max-width: 680px;
    }
    .footer {
      margin-top: 32px;
      display: flex; align-items: center; gap: 16px;
      font-size: 20px;
      color: ${inkSoft};
    }
    .footer .link { color: ${BRAND.colors.gold}; font-weight: 700; }
  `;

  const body = `
    <div class="frame">
      ${backgroundDataUri ? `<img class="bg" src="${backgroundDataUri}" alt="">` : ""}
      <div class="scrim"></div>
      <div class="header">
        <div class="wordmark">Adondepo</div>
        <div class="stop-count">PARADA ${index}/${total}</div>
      </div>
      <div class="content">
        <div class="eyebrow">${slide.meta}</div>
        <div class="title">${slide.title}</div>
        ${slide.subtitle ? `<div class="subtitle">${slide.subtitle}</div>` : ""}
        <div class="footer">
          <span>Descubre más en <span class="link">adondepo.cl</span></span>
        </div>
      </div>
    </div>
  `;

  return wrapDocument(styles, body);
};
