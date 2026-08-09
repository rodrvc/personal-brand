import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { featuresOf, loadBrand } from "./brand-schema.js";
import { resolveProfileDir } from "./profile.js";
import { chunkSlides, renderDocuments, renderSlides } from "./render-batch.js";
import { renderDecorativeFrame } from "./templates/decorative-frame.js";
import { renderFullBleed } from "./templates/full-bleed.js";
import { renderListFormat } from "./templates/list-format.js";
import { renderSplitCard } from "./templates/split-card.js";
import type { CarouselInput, Slide, SlideTemplate } from "./types.js";
import { verifyOrThrow } from "./verify-slides.js";

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
 * Groups slides by category (preserving first-seen category order), then
 * chunks each category's slides into groups of at most `size`. This keeps
 * every "list-format" slide single-category — a slide with 3 events never
 * never mixes two categories — so the per-slide category header (solid color
 * + oversized category name) is always accurate for the whole slide, not
 * just one row in it. A category with more than `size` events simply spills
 * into a second, third, etc. slide for that same category.
 *
 * Generic over the slide type rather than typed `Slide[]` so it forwards the
 * `VerifiedSlide` brand its caller passes in: this function sits between
 * `verifyOrThrow` and `renderBatch`, and narrowing it to `Slide` here would
 * strip the brand and make the verified data indistinguishable from unverified
 * data by the time it reaches the render.
 */
function groupByCategoryThenChunk<T extends Slide>(slides: T[], size: number): T[][] {
  const byCategory = new Map<string, T[]>();
  for (const slide of slides) {
    const key = slide.category ?? "";
    const bucket = byCategory.get(key);
    if (bucket) {
      bucket.push(slide);
    } else {
      byCategory.set(key, [slide]);
    }
  }

  const groups: T[][] = [];
  for (const categorySlides of byCategory.values()) {
    groups.push(...chunkSlides(categorySlides, size));
  }
  return groups;
}

function parseArgs(argv: string[]): { profile: string } {
  const profileIndex = argv.indexOf("--profile");
  const profile = profileIndex !== -1 ? argv[profileIndex + 1] : undefined;
  if (!profile) {
    throw new Error("--profile <slug> is required (the brand to render with).");
  }
  return { profile };
}

async function main(): Promise<void> {
  const { profile } = parseArgs(process.argv.slice(2));
  // Every variant this harness renders declares its own needs, so the set is
  // the union of them — it stays correct as variants are added or removed.
  const brand = loadBrand(
    resolveProfileDir(profile),
    featuresOf([...Object.values(VARIANTS), renderListFormat]),
  );
  const input = loadInput();
  const { slides: allSlides } = input;
  if (allSlides.length === 0) {
    throw new Error("example-input.json has no slides to render.");
  }

  // The same guard the other entry points run. This is a layout-comparison
  // harness on a fixture, not a publishing flow — but it renders `slide.image`
  // through four templates, and it is the one script wired into package.json,
  // so exempting it is how an invented URL reaches a PNG anyway. No period:
  // the fixture is not date-bound.
  const slides = verifyOrThrow({
    slides: allSlides,
    input,
    inputPath: INPUT_PATH,
    profileDir: resolveProfileDir(profile),
    recipe: "layout-comparison",
    // The fixture ships with the engine and is reviewed in the diff, so its
    // own `sourceImageHosts` is the authority — there is no profile recipe.
    selfDeclaredProvenance: true,
  });

  // Only the first slide is rendered for each variant: the goal of this
  // deliverable is a side-by-side layout comparison on identical content,
  // not a full carousel export.
  const [firstSlide] = slides;

  // Launched once and shared across both passes below — renderBatch will not
  // close a browser it didn't launch, so this stays a single Chromium launch
  // instead of one per pass.
  const browser = await chromium.launch();
  try {
    const variantEntries = Object.entries(VARIANTS);
    await renderDocuments({
      items: variantEntries,
      toHtml: ([, renderTemplate]) => renderTemplate(brand, firstSlide),
      outputDir: OUTPUT_DIR,
      filename: ([variantName]) => `${variantName}.png`,
      browser,
    });

    // "list-format" is a group variant: it renders up to 3 events per image,
    // grouped by category first so a single slide never mixes categories —
    // each slide gets one accurate, full-width category header.
    const groups = groupByCategoryThenChunk(slides, 3);
    await renderSlides({
      items: groups,
      toHtml: (group) => renderListFormat(brand, group),
      outputDir: OUTPUT_DIR,
      filename: (_group, index) => `list-format-${index + 1}.png`,
      browser,
    });
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Carousel render failed:", error);
  process.exitCode = 1;
});
