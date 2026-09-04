#!/usr/bin/env node
/**
 * Downloads, once, the webfont files a profile's `brand.json` references via
 * `googleFontsHref`, saving them as `.woff2` under `assets/fonts/` and
 * indexing them as `kind: "font"`.
 *
 * Usage:
 *   npx tsx system/assets/fetch-fonts.ts --profile <slug>
 *
 * Why this exists at all: `googleFontsHref` is a `<link>` fetched at
 * render/preview time — see `system/config/brand.schema.md`'s "Fuentes"
 * feature and design decision D9. Fetching the actual font files once and
 * keeping them in the profile means preview, export, and (per D9) the
 * editor's `@font-face` embedding never depend on the network again.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { loadBrand } from "../ig-carousel/brand-schema.js";
import { resolveProfileDir } from "../ig-carousel/profile.js";
import { registerFile } from "./index.js";

// A modern desktop UA: Google Fonts' CSS endpoint serves different `src`
// formats depending on the requesting browser, and only a fairly recent one
// gets woff2 (the format this repo standardizes on) instead of a broader
// but heavier legacy set.
const MODERN_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function parseArgs(argv: string[]): { profile: string } {
  const profileIndex = argv.indexOf("--profile");
  const profile = profileIndex >= 0 ? argv[profileIndex + 1] : undefined;
  if (!profile) {
    throw new Error("Usage: fetch-fonts.ts --profile <slug>");
  }
  return { profile };
}

/** Extracts `family: url(...)` pairs from a Google Fonts CSS response. */
export function extractFontFaces(css: string): Array<{ family: string; url: string }> {
  const results: Array<{ family: string; url: string }> = [];
  const blockRe = /@font-face\s*{([^}]*)}/g;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(css))) {
    const body = block[1]!;
    const familyMatch = /font-family:\s*['"]?([^'";]+)['"]?/.exec(body);
    const urlMatch = /url\(([^)]+\.woff2)\)/.exec(body);
    if (familyMatch && urlMatch) {
      results.push({
        family: familyMatch[1]!.trim(),
        url: urlMatch[1]!.replace(/^['"]|['"]$/g, ""),
      });
    }
  }
  return results;
}

async function fetchText(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { "User-Agent": MODERN_UA } });
  } catch (error) {
    throw new Error(
      `fetch-fonts: could not reach ${url} — check network connectivity. ` +
        `Original error: ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new Error(`fetch-fonts: ${url} returned HTTP ${response.status}`);
  }
  return response.text();
}

async function fetchBuffer(url: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { "User-Agent": MODERN_UA } });
  } catch (error) {
    throw new Error(
      `fetch-fonts: could not reach ${url} — check network connectivity. ` +
        `Original error: ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new Error(`fetch-fonts: ${url} returned HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchFontsForProfile(profileDir: string): Promise<string[]> {
  const brand = loadBrand(profileDir);
  if (!brand.googleFontsHref) {
    console.log("fetch-fonts: brand.json declares no googleFontsHref — nothing to fetch.");
    return [];
  }

  const css = await fetchText(brand.googleFontsHref);
  const faces = extractFontFaces(css);
  if (faces.length === 0) {
    throw new Error(
      `fetch-fonts: no woff2 @font-face rules found in the CSS from ${brand.googleFontsHref}. ` +
        "The stylesheet may have served a legacy format for this User-Agent.",
    );
  }

  const fontsDir = join(profileDir, "assets", "fonts");
  mkdirSync(fontsDir, { recursive: true });

  const saved: string[] = [];
  for (const face of faces) {
    const buffer = await fetchBuffer(face.url);
    const filename = `${face.family.replace(/\s+/g, "")}-${basename(face.url).split("?")[0]}`;
    const destRelPath = join("assets", "fonts", filename);
    const destAbsPath = join(profileDir, destRelPath);
    writeFileSync(destAbsPath, buffer);

    const metaPath = destAbsPath.replace(/\.\w+$/, "") + ".meta.json";
    writeFileSync(metaPath, JSON.stringify({ family: face.family }, null, 2) + "\n", "utf-8");

    registerFile(profileDir, buffer, {
      kind: "font",
      origin: "manual",
      destRelPath,
    });
    saved.push(destRelPath);
  }
  return saved;
}

// Only run as a CLI when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const { profile } = parseArgs(process.argv.slice(2));
  const profileDir = resolveProfileDir(profile);
  fetchFontsForProfile(profileDir)
    .then((saved) => {
      console.log(`fetch-fonts: saved ${saved.length} file(s):`);
      for (const path of saved) console.log(`  ${path}`);
    })
    .catch((error) => {
      console.error(error.message ?? error);
      process.exitCode = 1;
    });
}
