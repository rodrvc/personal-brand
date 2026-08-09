import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";

import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./document.js";
import type { SlideTemplate, VerifiedSlide } from "./types.js";

interface RenderBatchOptions<T> {
  items: T[];
  toHtml: (item: T, index: number) => string;
  outputDir: string;
  // Default: `slide-${index + 1}.png` — overridden by callers whose files
  // follow a different naming convention (e.g. variant name, list-format-N).
  filename?: (item: T, index: number) => string;
  // Writes manifest.json (the ordered list of rendered paths) and the final
  // "Output folder: ..." line. Off by default because render.ts's two-pass
  // variant-comparison harness has no single manifest to write.
  manifest?: boolean;
  // Reuse an existing browser instead of launching a new one. When provided,
  // the caller owns its lifecycle — renderBatch will not close it. This lets
  // a multi-pass caller (render.ts) launch Chromium once and share it across
  // calls instead of paying the launch cost twice.
  browser?: Browser;
}

const defaultFilename = (_item: unknown, index: number) => `slide-${index + 1}.png`;

/**
 * Renders `items` to PNG screenshots via a shared Playwright page, one
 * `setContent` + `screenshot` per item. Extracted from render.ts,
 * render-week.ts and render-brand.ts, which all ran this exact loop with
 * only the HTML-producing step differing.
 */
async function renderBatchInternal<T>(opts: RenderBatchOptions<T>): Promise<string[]> {
  const { items, toHtml, outputDir, filename = defaultFilename, manifest = false } = opts;

  mkdirSync(outputDir, { recursive: true });

  const ownsBrowser = !opts.browser;
  const browser = opts.browser ?? (await chromium.launch());
  // Closed in the inner `finally` regardless of who owns the browser: a
  // borrowed browser outlives this call, so leaving the page open would leak
  // one per invocation.
  const page = await browser.newPage({
    viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
    deviceScaleFactor: 1,
  });

  try {
    const paths: string[] = [];
    for (const [index, item] of items.entries()) {
      const html = toHtml(item, index);
      await page.setContent(html, { waitUntil: "networkidle" });
      // "networkidle" only guarantees the font files finished downloading,
      // not that Chromium has finished parsing/swapping them in — without
      // this, screenshots can be taken mid-swap and show fallback glyphs
      // (e.g. a script face rendering as a generic serif) despite the font
      // having loaded successfully over the network.
      await page.evaluate(() => document.fonts.ready);

      const name = filename(item, index);
      const outputPath = join(outputDir, name);
      await page.screenshot({ path: outputPath });
      paths.push(outputPath);
      console.log(`Rendered ${name.replace(/\.png$/, "")} -> ${outputPath}`);
    }

    if (manifest) {
      writeFileSync(join(outputDir, "manifest.json"), JSON.stringify({ slides: paths }, null, 2));
      console.log(`\nOutput folder: ${outputDir}`);
    }

    return paths;
  } finally {
    await page.close();
    if (ownsBrowser) {
      await browser.close();
    }
  }
}

/**
 * Splits an array into consecutive chunks of at most `size` elements each.
 * The last chunk may be smaller — used to group slides for "list-format",
 * where a group of 5 slides yields chunks of [3, 2].
 *
 * Generic on purpose: typed to `Slide[]` it would launder the `VerifiedSlide`
 * brand off mid-pipeline, and `renderBatch` would accept the result of grouping
 * unverified slides. The brand has to survive grouping.
 */
export function chunkSlides<T>(slides: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < slides.length; i += size) {
    chunks.push(slides.slice(i, i + size));
  }
  return chunks;
}

/**
 * Renders verified slides — the only way slide data reaches a PNG.
 *
 * **Not generic, on purpose.** This signature is the pre-render guard, and it
 * took three attempts to get right because each earlier version was a
 * conditional type over a type parameter, which leaks in a way plain parameters
 * cannot:
 *
 *  1. `items: T[]` — `T = Slide` was as acceptable as any other `T`. A 24-line
 *     file imported this directly and rendered an invented image URL.
 *  2. A conditional rejecting `[T] extends [Slide]` — caught subtypes but not
 *     *wider* types. `{ image?: string; title: string }` slipped through, which
 *     is easy to write by accident when trimming a parameter to the fields a
 *     template reads.
 *  3. Adding the reverse test `[Slide] extends [T]` — closed that family, then
 *     failed open inside a generic body: for an unresolved `S extends Slide`,
 *     the conditional defers, `SlideLike<S>` evaluates to `boolean` rather than
 *     `true`, and `boolean extends true` is false, so the reject branch was
 *     skipped. A helper generic over "some kind of slide" — precisely what a
 *     fourth entry point would write — rendered an invented URL at exit 0.
 *
 * The lesson is about polarity, not about missing a case: a gate phrased as
 * "reject what I can prove is slide data" accepts everything it cannot resolve.
 * A concrete parameter type has no unresolved case to default on. `VerifiedSlide`
 * is nominal and only `verifyOrThrow` can mint it, so this signature says the
 * whole rule with no branches for a future caller to slip between.
 */
export async function renderSlides(opts: RenderBatchOptions<VerifiedSlide>): Promise<string[]>;
export async function renderSlides(opts: RenderBatchOptions<VerifiedSlide[]>): Promise<string[]>;
// Overloads rather than a union parameter: a union would leave `toHtml`'s
// argument un-inferable at every call site, forcing callers to annotate it.
export async function renderSlides(
  opts: RenderBatchOptions<VerifiedSlide> | RenderBatchOptions<VerifiedSlide[]>,
): Promise<string[]> {
  return renderBatchInternal(opts as RenderBatchOptions<VerifiedSlide | VerifiedSlide[]>);
}

/**
 * Renders one template per layout variant — the comparison harness in
 * `render.ts`, whose items are template functions, not slide data.
 *
 * **Concrete, like `renderSlides`, and for the reason six review rounds
 * established: every version of this guard built on a conditional type leaked.**
 * The last one asked "is `T` slide-shaped?" and never "does `T` *contain*
 * slides", so `Slide[][]` — the exact shape `chunkSlides` produces and this file
 * passes around twelve lines away — was "provably not a slide" and walked
 * through. No bad faith needed: a caller reading two function names and guessing
 * wrong got a PNG of an invented image URL, and the compiler agreed.
 *
 * A concrete parameter has no unresolved case to default on and no container to
 * recurse through. There is exactly one real caller and this is its shape; if a
 * second kind of non-slide item ever needs rendering, add an overload naming it
 * rather than reaching for a type parameter again.
 */
export async function renderDocuments(
  opts: RenderBatchOptions<readonly [string, SlideTemplate]>,
): Promise<string[]> {
  return renderBatchInternal(opts);
}
