/**
 * Renders a weekly reel for a profile.
 *
 * Usage:
 *   npx tsx system/ig-reel/render-reel-week.ts --profile <slug> [--date YYYY-MM-DD]
 *
 * The profile slug is required and never inferred: rendering the wrong brand
 * silently is the expensive failure, and asking is cheap.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { featuresOf, loadBrand } from "../ig-carousel/brand-schema.js";
import { resolveOutputBaseDir, resolveOutputSubfolder, resolveProfileDir } from "../ig-carousel/profile.js";
import { buildComposition } from "./composition.js";
import { placeItem, validateBBox } from "./geo.js";
import { buildMapSvg } from "./map-svg.js";
import { fetchCoastline, fetchLandmarks, fetchRoads, geocode, validateReferenceTypes } from "./osm.js";
import { loadReelRecipe } from "./recipe.js";
import type { ReelInput } from "./types.js";
import { verifyOrThrow, type Period } from "./verify-items.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Monday-to-Sunday week containing the reference date, in local time. */
function weekOf(reference: Date): Period {
  const monday = new Date(reference);
  // getDay() is 0 for Sunday, which belongs to the week that started 6 days ago.
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const iso = (date: Date): string =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return { start: iso(monday), end: iso(sunday) };
}

async function main(): Promise<void> {
  const profile = flag("profile");
  if (!profile) {
    throw new Error("Missing --profile <slug>. The engine never guesses which brand to render.");
  }

  const profileDir = resolveProfileDir(profile);
  const brand = loadBrand(profileDir, featuresOf([buildComposition]));
  const recipe = loadReelRecipe(profileDir);
  const bbox = validateBBox(recipe.map.bbox);
  const referenceTypes = validateReferenceTypes(recipe.map.reference_types);
  const userAgent = recipe.map.geocode?.user_agent ?? `personal-brand-reel/1.0 (+${brand.copy.site})`;

  const dateFlag = flag("date");
  const reference = dateFlag ? new Date(`${dateFlag}T12:00:00`) : new Date();
  if (Number.isNaN(reference.getTime())) {
    throw new Error(`--date must be YYYY-MM-DD, got: ${dateFlag}`);
  }
  const period = weekOf(reference);

  const inputPath = join(profileDir, "reels", "week-input.json");
  const input = JSON.parse(readFileSync(inputPath, "utf-8")) as ReelInput;

  // Every network call goes through the on-disk cache, so a re-run of the same
  // week costs no requests at all. `--no-cache` forces fresh data; the cache
  // announces itself either way, because a silent cache is a trap.
  const fetchOptions = { noCache: process.argv.includes("--no-cache"), report: console.log };

  // Geocode anything the source did not carry coordinates for. Sequential and
  // one call per item, as Nominatim's usage policy requires.
  for (const item of input.items) {
    if (typeof item.lat === "number" && typeof item.lng === "number") continue;
    const found = await geocode(bbox, `${item.where}, ${input.city}`, userAgent, fetchOptions);
    if (found) {
      item.lat = found.lat;
      item.lng = found.lon;
    }
    // Anything still without a coordinate is dropped by verifyOrThrow, with a
    // reason. It is never defaulted to the centre of the bbox.
  }

  console.log(`Verifying items against ${period.start}..${period.end}`);
  const items = verifyOrThrow({ input, inputPath, bbox, period });
  console.log(`  ${items.length} item(s) verified`);

  // --- map ---
  // Sequential, not Promise.all: three concurrent queries is three times the
  // instantaneous load on a free public server, which is what gets a client
  // throttled into the 504s these calls otherwise fail with.
  console.log("Fetching OSM data…");
  const coastline = await fetchCoastline(bbox, userAgent, fetchOptions);
  const roads = await fetchRoads(bbox, userAgent, fetchOptions);
  const landmarks = await fetchLandmarks(bbox, referenceTypes, userAgent, fetchOptions);
  const { svg, landmarksDrawn } = buildMapSvg(bbox, coastline, roads, landmarks, brand);
  if (landmarksDrawn === 0) {
    console.warn(
      "  no landmarks fell inside the bbox — the map renders without labels. " +
        "Check map.reference_types if that is unexpected.",
    );
  } else {
    console.log(`  ${landmarksDrawn} landmark(s) drawn`);
  }

  const placements = items.map((item) => placeItem(bbox, item.lat, item.lng, item.mapLabel));

  // --- build the HyperFrames project in the output folder ---
  const outputDir = join(
    resolveOutputBaseDir(profileDir),
    resolveOutputSubfolder(profileDir, "reels"),
    period.start,
  );
  const assetsDir = join(outputDir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  writeFileSync(join(assetsDir, "map.svg"), svg);

  // Item images are copied in beside the composition so the render never
  // depends on the network — a fetch during render is non-deterministic and
  // fails the whole run when a host is slow.
  const imageSrcs = items.map((item, index) => {
    const local = join(profileDir, item.image.replace(/^\.?\//, ""));
    const target = `assets/item${index + 1}${(item.image.match(/\.\w+$/) ?? [".jpg"])[0]}`;
    try {
      copyFileSync(local, join(outputDir, target));
      return target;
    } catch {
      // A remote URL is left as-is: HyperFrames resolves it at build time.
      return item.image;
    }
  });

  // A local logo font, if the profile ships one, so preview and render agree.
  let logoFontSrc: string | undefined;
  const fontsDir = join(profileDir, "assets", "fonts");
  try {
    const font = readdirSync(fontsDir).find((name) => name.endsWith(".woff2"));
    if (font) {
      copyFileSync(join(fontsDir, font), join(assetsDir, font));
      logoFontSrc = `assets/${font}`;
    }
  } catch {
    // No font folder: the composition falls back to the named brand font.
  }

  writeFileSync(
    join(outputDir, "index.html"),
    buildComposition({
      brand,
      city: input.city,
      items,
      placements,
      mapSrc: "assets/map.svg",
      imageSrcs,
      logoFontSrc,
    }),
  );
  copyFileSync(join(__dirname, "hyperframes.json"), join(outputDir, "hyperframes.json"));

  // --- render ---
  const hyperframes = (...args: string[]): void => {
    execFileSync("npx", ["--yes", "hyperframes@0.7.101", ...args], {
      cwd: outputDir,
      stdio: "inherit",
    });
  };

  console.log("Checking the composition…");
  hyperframes("check");
  console.log("Rendering…");
  hyperframes("render");

  const rendersDir = join(outputDir, "renders");
  const rendered = readdirSync(rendersDir)
    .filter((name) => name.endsWith(".mp4"))
    .sort()
    .pop();
  if (!rendered) {
    throw new Error(`hyperframes render produced no MP4 in ${rendersDir}`);
  }

  // The silent audio track is not optional: HyperFrames emits no audio stream,
  // and several macOS players freeze on the first frame of a mute video — the
  // file looks broken while being fine. Nothing is audible; the track just
  // exists so the platform's own music can be added later.
  const finalPath = join(outputDir, `reel-${period.start}.mp4`);
  console.log("Adding the silent audio track…");
  execFileSync(
    "ffmpeg",
    [
      "-y", "-i", join(rendersDir, rendered),
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest",
      "-movflags", "+faststart", finalPath,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  console.log(`\nReel: ${basename(finalPath)}`);
  console.log(`Output folder: ${resolve(outputDir)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
