import type { BrandTokens } from "../../../system/ig-carousel/brand-schema.js";
import { wrapDocument } from "../../../system/ig-carousel/document.js";

import { getSharedBrowser } from "./browser.js";
import type { ProfileStore } from "./profile-store.js";
import { buildExportRenderContext } from "./render-context.js";

/** One line of text to rasterise, in a CSS font family, size in pixels, weight and a #rrggbb colour. */
export interface TextRun {
  text: string;
  family: string;
  size: number;
  weight: number;
  color: string;
}

/** Each run as a PNG on a transparent background, in the same order. */
export type Rasterise = (runs: TextRun[]) => Promise<Buffer[]>;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cssValue(value: string): string {
  if (/[;{}<]/.test(value)) throw new Error(`A font family or colour contains a disallowed character: "${value}"`);
  return value;
}

/**
 * Rasterises with the same warm Chromium and the same fonts (the brand's web fonts and the profile's local font
 * files) that render the slides, so a text drawn into an image reads like the editable texts around it.
 */
export function chromiumRasteriser(store: ProfileStore, brand: BrandTokens): Rasterise {
  return async (runs) => {
    if (runs.length === 0) return [];
    const { fontFaces } = buildExportRenderContext(store, brand, { mode: "color", colorKey: brand.roles.surface });
    const spans = runs.map(
      (run, i) =>
        `<div><span id="run-${i}" style="font-family: ${cssValue(run.family)}; font-size: ${run.size}px; font-weight: ${run.weight}; color: ${cssValue(run.color)}">${escapeHtml(run.text)}</span></div>`,
    );
    // A little padding keeps overhanging glyphs (an italic, a wide bold) inside the element's screenshot.
    const styles = "html, body { width: auto; height: auto; overflow: visible; background: transparent; } span { display: inline-block; white-space: pre; line-height: 1.4; padding: 0 0.3em; }";
    const browser = await getSharedBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(wrapDocument(styles, spans.join(""), brand.googleFontsHref, fontFaces), { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      const images: Buffer[] = [];
      for (let i = 0; i < runs.length; i++) images.push(await page.locator(`#run-${i}`).screenshot({ omitBackground: true }));
      return images;
    } finally {
      await page.close();
    }
  };
}
