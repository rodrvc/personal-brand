import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./document.js";
import { renderBrandMessage } from "./templates/brand-message.js";
import type { CarouselInput } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const INPUT_PATH = join(__dirname, "brand-input.json");

/**
 * Same `outputs.base_dir` resolution as `render-week.ts` (config.local.yaml
 * first, falling back to config.yaml, then "outputs"), duplicated rather
 * than shared because pulling in a shared module for a handful of lines
 * would be disproportionate for two scripts.
 */
function readOutputsBaseDir(profileDir: string): string {
  const extractBaseDir = (raw: string): string | undefined => {
    const match = raw.match(/^\s*base_dir:\s*(\S+)/m);
    return match?.[1]?.replace(/^["']|["']$/g, "");
  };

  const readConfig = (filename: string): string | undefined => {
    try {
      return extractBaseDir(readFileSync(join(profileDir, filename), "utf-8"));
    } catch {
      return undefined;
    }
  };

  const value = readConfig("config.local.yaml") ?? readConfig("config.yaml") ?? "outputs";
  return value.startsWith("~")
    ? join(homedir(), value.slice(1).replace(/^\/+/, ""))
    : value;
}

function resolveOutputsBaseDir(profileDir: string, baseDir: string): string {
  return isAbsolute(baseDir) ? baseDir : join(profileDir, baseDir);
}

function parseArgs(argv: string[]): { profile: string } {
  const profileIndex = argv.indexOf("--profile");
  return { profile: profileIndex !== -1 ? argv[profileIndex + 1] : "adondepo" };
}

async function main(): Promise<void> {
  const { profile } = parseArgs(process.argv.slice(2));
  const { slides } = JSON.parse(readFileSync(INPUT_PATH, "utf-8")) as CarouselInput;
  if (slides.length === 0) {
    throw new Error("brand-input.json has no slides to render.");
  }

  const profileDir = join(REPO_ROOT, "profiles", profile);
  const baseDir = resolveOutputsBaseDir(profileDir, readOutputsBaseDir(profileDir));
  const outputDir = join(baseDir, "presentacion-marca");

  mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
      deviceScaleFactor: 1,
    });

    const paths: string[] = [];
    for (const [index, slide] of slides.entries()) {
      const html = renderBrandMessage(slide, { index: index + 1, total: slides.length });
      await page.setContent(html, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);

      const outputPath = join(outputDir, `slide-${index + 1}.png`);
      await page.screenshot({ path: outputPath });
      paths.push(outputPath);
      console.log(`Rendered slide-${index + 1} -> ${outputPath}`);
    }

    writeFileSync(join(outputDir, "manifest.json"), JSON.stringify({ slides: paths }, null, 2));
    console.log(`\nOutput folder: ${outputDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Brand carousel render failed:", error);
  process.exitCode = 1;
});
