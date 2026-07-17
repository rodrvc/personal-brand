import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./document.js";
import { renderDecorativeFrame } from "./templates/decorative-frame.js";
import { renderFullBleed } from "./templates/full-bleed.js";
import { renderListFormat } from "./templates/list-format.js";
import { renderSplitCard } from "./templates/split-card.js";
import type { CarouselInput, Slide, SlideTemplate } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPUT_PATH = join(__dirname, "example-input.json");
const OUTPUT_DIR = join(__dirname, "output");

/**
 * Registry of available layout variants. Adding a new variant means adding
 * one entry here plus its template module — no changes to the render loop.
 */
const VARIANTS: Record<string, SlideTemplate> = {
  "full-bleed": renderFullBleed,
  "split-card": renderSplitCard,
  "decorative-frame": renderDecorativeFrame,
};

function loadInput(): CarouselInput {
  const raw = readFileSync(INPUT_PATH, "utf-8");
  return JSON.parse(raw) as CarouselInput;
}

/**
 * Splits an array into consecutive chunks of at most `size` elements each.
 * The last chunk may be smaller — used to group slides for "list-format",
 * where a group of 5 slides yields chunks of [3, 2].
 */
function chunkSlides(slides: Slide[], size: number): Slide[][] {
  const chunks: Slide[][] = [];
  for (let i = 0; i < slides.length; i += size) {
    chunks.push(slides.slice(i, i + size));
  }
  return chunks;
}

/**
 * Groups slides by category (preserving first-seen category order), then
 * chunks each category's slides into groups of at most `size`. This keeps
 * every "list-format" slide single-category — a slide with 3 events never
 * mixes Música with Deporte — so the per-slide category header (solid color
 * + oversized category name) is always accurate for the whole slide, not
 * just one row in it. A category with more than `size` events simply spills
 * into a second, third, etc. slide for that same category.
 */
function groupByCategoryThenChunk(slides: Slide[], size: number): Slide[][] {
  const byCategory = new Map<string, Slide[]>();
  for (const slide of slides) {
    const key = slide.category ?? "Evento";
    const bucket = byCategory.get(key);
    if (bucket) {
      bucket.push(slide);
    } else {
      byCategory.set(key, [slide]);
    }
  }

  const groups: Slide[][] = [];
  for (const categorySlides of byCategory.values()) {
    groups.push(...chunkSlides(categorySlides, size));
  }
  return groups;
}

async function main(): Promise<void> {
  const { slides } = loadInput();
  if (slides.length === 0) {
    throw new Error("example-input.json has no slides to render.");
  }

  // Only the first slide is rendered for each variant: the goal of this
  // deliverable is a side-by-side layout comparison on identical content,
  // not a full carousel export.
  const [firstSlide] = slides;

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
      deviceScaleFactor: 1,
    });

    for (const [variantName, renderTemplate] of Object.entries(VARIANTS)) {
      const html = renderTemplate(firstSlide);
      await page.setContent(html, { waitUntil: "networkidle" });
      // "networkidle" only guarantees the font files finished downloading,
      // not that Chromium has finished parsing/swapping them in — without
      // this, screenshots can be taken mid-swap and show fallback glyphs
      // (e.g. Pacifico rendering as a generic serif) despite the font
      // having loaded successfully over the network.
      await page.evaluate(() => document.fonts.ready);

      const outputPath = join(OUTPUT_DIR, `${variantName}.png`);
      await page.screenshot({ path: outputPath });
      console.log(`Rendered ${variantName} -> ${outputPath}`);
    }

    // "list-format" is a group variant: it renders up to 3 events per image,
    // grouped by category first so a single slide never mixes categories —
    // each slide gets one accurate, full-width category header.
    const groups = groupByCategoryThenChunk(slides, 3);
    for (const [index, group] of groups.entries()) {
      const html = renderListFormat(group);
      await page.setContent(html, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);

      const outputPath = join(OUTPUT_DIR, `list-format-${index + 1}.png`);
      await page.screenshot({ path: outputPath });
      console.log(`Rendered list-format-${index + 1} -> ${outputPath}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Carousel render failed:", error);
  process.exitCode = 1;
});
