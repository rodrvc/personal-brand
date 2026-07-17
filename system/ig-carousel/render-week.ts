import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./document.js";
import { renderListFormat } from "./templates/list-format.js";
import type { CarouselInput, Slide } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const INPUT_PATH = join(__dirname, "week-input.json");

const MONTH_ABBR = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];

/**
 * Returns "del D al D de <mes>" (or "del D de <mesA> al D de <mesB>" when the
 * week spans two months) for the calendar week (Monday-Sunday) containing
 * `reference`. Computed from a real date rather than hand-typed so the
 * header always matches the actual week being published. Pass a date inside
 * next week (or any other week) to generate for a week other than the
 * current one — the calculation is always "the Mon-Sun week containing this
 * date," not hardcoded to "today."
 */
function weekLabel(reference: Date): { label: string; monday: Date } {
  const day = reference.getDay(); // 0 = Sunday
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(reference);
  monday.setDate(reference.getDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const startDay = monday.getDate();
  const endDay = sunday.getDate();
  const startMonth = MONTH_ABBR[monday.getMonth()];
  const endMonth = MONTH_ABBR[sunday.getMonth()];

  const label =
    startMonth === endMonth
      ? `del ${startDay} al ${endDay} de ${endMonth}`
      : `del ${startDay} de ${startMonth} al ${endDay} de ${endMonth}`;

  return { label, monday };
}

/** "jul-06" — month abbreviation + the day the week's Monday falls on. */
function weekFolderName(monday: Date): string {
  return `${MONTH_ABBR[monday.getMonth()]}-${String(monday.getDate()).padStart(2, "0")}`;
}

/**
 * Reads `outputs.base_dir` with a plain regex instead of a full YAML parser
 * — this repo has no YAML dependency yet and pulling one in for a single
 * scalar field would be disproportionate. Checks `config.local.yaml` first
 * (the per-machine, gitignored file — this is machine-specific config, not
 * project config, so it belongs there per this repo's existing
 * config.yaml/config.local.yaml convention), falling back to `config.yaml`
 * for anyone not using a local override. Falls back to "outputs" (relative
 * to the profile folder) if neither file sets it.
 *
 * `base_dir` may be relative (resolved against the profile's own folder) or
 * an absolute/"~"-prefixed path (e.g. "~/Pictures/adondepo/carruseles") to
 * keep generated output entirely outside the repo — every machine/user
 * points this wherever makes sense for them; nothing about the path is
 * assumed by the script itself.
 */
function readOutputsBaseDir(profileDir: string): string {
  const extractBaseDir = (raw: string): string | undefined => {
    // Matches "base_dir: <value>" anywhere a line starts with that key,
    // ignoring any comment lines (lines starting with "#") that may sit
    // between "outputs:" and "base_dir:" in the YAML.
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

/** Resolves `baseDir` against `profileDir` unless it's already absolute. */
function resolveOutputsBaseDir(profileDir: string, baseDir: string): string {
  return isAbsolute(baseDir) ? baseDir : join(profileDir, baseDir);
}

// "Magazine card" list-format mixes categories freely per slide (matching
// the reference mockup, which shows Música/Fiesta/Comedia together under
// one "this week" cover) — plain chunking, no per-category grouping.
function chunkSlides(slides: Slide[], size: number): Slide[][] {
  const chunks: Slide[][] = [];
  for (let i = 0; i < slides.length; i += size) {
    chunks.push(slides.slice(i, i + size));
  }
  return chunks;
}

function parseArgs(argv: string[]): { profile: string; city: string } {
  const profileIndex = argv.indexOf("--profile");
  const cityIndex = argv.indexOf("--city");
  return {
    profile: profileIndex !== -1 ? argv[profileIndex + 1] : "adondepo",
    city: cityIndex !== -1 ? argv[cityIndex + 1] : "Antofagasta",
  };
}

async function main(): Promise<void> {
  const { profile, city } = parseArgs(process.argv.slice(2));
  const { slides } = JSON.parse(readFileSync(INPUT_PATH, "utf-8")) as CarouselInput;
  if (slides.length === 0) {
    throw new Error("week-input.json has no slides to render.");
  }

  const profileDir = join(REPO_ROOT, "profiles", profile);
  const baseDir = resolveOutputsBaseDir(profileDir, readOutputsBaseDir(profileDir));
  const { label: headerLabel, monday } = weekLabel(new Date());
  const outputDir = join(
    baseDir,
    String(monday.getFullYear()),
    weekFolderName(monday),
  );

  mkdirSync(outputDir, { recursive: true });

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
      deviceScaleFactor: 1,
    });

    // This layout is more spacious than the old design (bigger cards, more
    // air) — 3 cards no longer fit within the 1080x1350 canvas without
    // clipping the last one. 2 per slide is what actually fits cleanly.
    const groups = chunkSlides(slides, 2);
    const paths: string[] = [];
    for (const [index, group] of groups.entries()) {
      const html = renderListFormat(group, { headerLabel, city });
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
  console.error("Week carousel render failed:", error);
  process.exitCode = 1;
});
