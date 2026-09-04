import type { Page } from "playwright";

import { contrast, passesAA } from "@personal-brand/core/color";

import { color, type BrandTokens } from "./brand-schema.js";
import { resolveSlide, type ResolvedObject } from "./carousel-document-resolve.js";
import type { CarouselDocument, Slide } from "./carousel-document.js";
import type { LayoutTemplate } from "./layout-template.js";

/** Resolves a resolved text object's actual painted text color: its own pinned `colorKey` wins, otherwise the slot's `colorRole`. Mirrors the precedence `free-layout.ts` paints with. */
function resolvedTextColor(brand: BrandTokens, content: { colorKey?: string; colorRole?: string }): string | undefined {
  if (content.colorKey) return brand.colors[content.colorKey];
  if (content.colorRole) return color(brand, content.colorRole as keyof BrandTokens["roles"]);
  return undefined;
}

// Fallbacks used only when a text object's own style is left unset (an
// unstyled free object, or a slot the template doesn't fully specify) — the
// sampled box still needs *some* height to measure contrast against.
/** Default font size (px) assumed for height estimation when `fontSize` is unset. */
const DEFAULT_FONT_SIZE_PX = 32;
/** Default line height assumed when `lineHeight` is unset — mirrors the body copy's typical leading. */
const DEFAULT_LINE_HEIGHT = 1.3;

/** Per-object measured contrast result (design.md D9: measured, not estimated). */
export interface ObjectContrast {
  objectId: string;
  /** WCAG contrast ratio of the object's text color against the sampled background behind its box. 0 for a non-text object or one that could not be sampled. */
  ratio: number;
  passesAA: boolean;
}

/**
 * Converts a `[r, g, b]` (0-255 each) average into `#rrggbb`.
 */
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Given a Playwright `page` that already has one slide's HTML loaded
 * (`renderFreeLayoutSlide`'s output via `page.setContent`), measures the
 * real, rendered background color behind each text object's box and returns
 * its WCAG contrast ratio against that object's own text color.
 *
 * "Real background" here means whatever is visually behind the text box —
 * a flat color fill, a photo, or a semi-transparent overlay stacked on
 * either — which is exactly why this samples the painted canvas rather than
 * re-deriving a color from the document's `background` field: the document
 * only states *intent* (a color key or an asset id), not what ends up under
 * a given px once zones and objects are layered.
 *
 * Sampling happens in-page via a `<canvas>` `drawImage` + `getImageData` on
 * a temporary full-page screenshot data URL, kept dependency-free per the
 * design's D9/4.4 requirement — no PNG-decoding library, just what Chromium
 * already exposes to page scripts.
 */
export async function measureContrast(
  page: Page,
  brand: BrandTokens,
  doc: CarouselDocument,
  slide: Slide,
  template: LayoutTemplate,
): Promise<ObjectContrast[]> {
  const resolved = resolveSlide(doc, slide, template);
  const textObjects = resolved.objects.filter(
    (object): object is ResolvedObject & { content: { kind: "text" } } => object.content.kind === "text",
  );
  if (textObjects.length === 0) {
    return [];
  }

  // One full-page screenshot, sampled per-object in-page — cheaper than one
  // clip screenshot per text object, and immune to layout shifting between
  // shots since it's a single frozen frame.
  const screenshotBuffer = await page.screenshot();
  const dataUrl = `data:image/png;base64,${screenshotBuffer.toString("base64")}`;

  const boxes = textObjects.map((object) => ({
    id: object.id,
    x: object.geometry.x,
    y: object.geometry.y,
    w: object.geometry.w,
    h: object.geometry.h ?? Math.round((object.content.fontSize ?? DEFAULT_FONT_SIZE_PX) * (object.content.lineHeight ?? DEFAULT_LINE_HEIGHT)),
  }));

  const averages = await page.evaluate(
    async ({ dataUrl: src, boxes: sampleBoxes }) => {
      const img = new Image();
      const loaded = new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("failed to load screenshot into <img> for sampling"));
      });
      img.src = src;
      await loaded;

      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        return sampleBoxes.map((box) => ({ id: box.id, r: 0, g: 0, b: 0, ok: false }));
      }
      context.drawImage(img, 0, 0);

      return sampleBoxes.map((box) => {
        const x = Math.max(0, Math.min(box.x, canvas.width - 1));
        const y = Math.max(0, Math.min(box.y, canvas.height - 1));
        const w = Math.max(1, Math.min(box.w, canvas.width - x));
        const h = Math.max(1, Math.min(box.h, canvas.height - y));
        const { data } = context.getImageData(x, y, w, h);
        let rSum = 0;
        let gSum = 0;
        let bSum = 0;
        const pixelCount = data.length / 4;
        for (let i = 0; i < data.length; i += 4) {
          rSum += data[i]!;
          gSum += data[i + 1]!;
          bSum += data[i + 2]!;
        }
        return {
          id: box.id,
          r: rSum / pixelCount,
          g: gSum / pixelCount,
          b: bSum / pixelCount,
          ok: true,
        };
      });
    },
    { dataUrl, boxes },
  );

  return textObjects.map((object) => {
    const sample = averages.find((entry) => entry.id === object.id);
    const textColor = resolvedTextColor(brand, object.content);
    if (!sample?.ok || !textColor) {
      return { objectId: object.id, ratio: 0, passesAA: false };
    }
    const bgHex = rgbToHex(sample.r, sample.g, sample.b);
    const ratio = contrast(textColor, bgHex);
    return { objectId: object.id, ratio, passesAA: passesAA(textColor, bgHex) };
  });
}
