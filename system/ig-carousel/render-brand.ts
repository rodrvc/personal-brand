import { readFileSync } from "node:fs";
import { join } from "node:path";

import { featuresOf, loadBrand } from "./brand-schema.js";
import { resolveOutputBaseDir, resolveOutputSubfolder, resolveProfileDir } from "./profile.js";
import { renderSlides } from "./render-batch.js";
import { renderBrandMessage } from "./templates/brand-message.js";
import type { CarouselInput } from "./types.js";
import { verifyOrThrow } from "./verify-slides.js";

function parseArgs(argv: string[]): { profile: string; input?: string } {
  const profileIndex = argv.indexOf("--profile");
  const inputIndex = argv.indexOf("--input");
  const profile = profileIndex !== -1 ? argv[profileIndex + 1] : undefined;
  if (!profile) {
    throw new Error("--profile <slug> is required (which profile's brand and copy to render).");
  }
  return {
    profile,
    input: inputIndex !== -1 ? argv[inputIndex + 1] : undefined,
  };
}

/**
 * Runs the guard and, if it refused for a missing recipe, appends the way out.
 *
 * A rethrow with more text rather than a check-before-calling: duplicating "does
 * the recipe exist" here would be a second copy of the guard's own condition,
 * and the two would drift — the guard is the authority on when the recipe is
 * *required* (today: only when a slide actually carries an image), and that
 * condition should stay in exactly one place.
 *
 * Matched on the message because that is the only signal `verifyOrThrow` gives.
 * A miss costs nothing — the original error still surfaces intact, just without
 * the pointer — so this cannot turn a clear failure into a confusing one.
 */
function verifyImagePolicyAware<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    const message = (error as Error)?.message ?? "";
    if (message.includes("no recipe at") && message.includes("brand-message.yaml")) {
      throw new Error(
        `${message}\n\n` +
          `  This flow requires <profile>/recipes/brand-message.yaml. If it does not\n` +
          `  exist yet, create it — see system/recipes/brand-message.md for the\n` +
          `  contract and a copy-pasteable minimum:\n\n` +
          `    recipe: brand-message\n` +
          `    version: 1\n` +
          `    source: {}          # no image_hosts = "my images can come from anywhere"\n` +
          `    render:\n` +
          `      script: render-brand\n\n` +
          `  Add source.image_hosts (literal hosts, no wildcards) to restrict where\n` +
          `  images may come from, and copy that list to "sourceImageHosts" in the\n` +
          `  input. Omitting the key is the written opt-out; there is no "*".`,
      );
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const { profile, input } = parseArgs(process.argv.slice(2));

  const profileDir = resolveProfileDir(profile);
  // Derived from the template itself rather than hand-listed here. The
  // brand-message template is typography-only — no categories, no dates, no
  // list copy — which is what lets a personal-brand profile render from a
  // minimal brand.json.
  const brand = loadBrand(profileDir, featuresOf([renderBrandMessage]));

  const inputPath = input ?? join(profileDir, "carousels", "presentacion-marca.json");
  const parsed = JSON.parse(readFileSync(inputPath, "utf-8")) as CarouselInput;
  const { slides } = parsed;
  if (slides.length === 0) {
    throw new Error(`${inputPath} has no slides to render.`);
  }

  // The same guard every entry point runs. No period: this content is
  // deliberately not date-bound, and omitting it says so at the call site.
  //
  // `recipe: "brand-message"` means this flow requires
  // `<profile>/recipes/brand-message.yaml` — the file where the profile states
  // where its images may come from. That requirement had no documented way out:
  // the recipe existed in no profile, in no template and in no doc, and it did
  // not fail only because every `presentacion-marca.json` had zero images and
  // the host check returns before reading the recipe when there is nothing to
  // check. The first image added would have failed hard with "no recipe" and
  // nowhere to go. The contract now lives in `system/recipes/brand-message.md`,
  // and the catch below is what puts that pointer in front of whoever hits it —
  // the guard's own message names the missing path, but not the doc that
  // explains what to put in it.
  const kept = verifyImagePolicyAware(() =>
    verifyOrThrow({
      slides,
      input: parsed,
      inputPath,
      profileDir,
      recipe: "brand-message",
    }),
  );

  // Which subfolder these land in is an output-location decision, not a brand
  // decision — it sits alongside `outputs.base_dir` in the profile's config,
  // not in brand.json next to colors and type.
  const baseDir = resolveOutputBaseDir(profileDir);
  const outputDir = join(baseDir, resolveOutputSubfolder(profileDir, "brand_message"));

  await renderSlides({
    items: kept,
    toHtml: (slide, index) => renderBrandMessage(brand, slide, { index: index + 1, total: kept.length }),
    outputDir,
    manifest: true,
  });
}

main().catch((error) => {
  console.error("Brand carousel render failed:", error);
  process.exitCode = 1;
});
