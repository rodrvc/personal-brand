import { extname } from "node:path";

import type { BrandTokens } from "../../../system/ig-carousel/brand-schema.js";
import type { FontFace } from "../../../system/ig-carousel/document.js";
import type { FreeLayoutRenderContext } from "../../../system/ig-carousel/templates/free-layout.js";
import { loadIndex, type AssetIndexFile } from "../../../system/assets/index.js";
import { pickLogo } from "../../../system/assets/logo.js";

import type { ProfileStore } from "./profile-store.js";

/**
 * Builds the `FreeLayoutRenderContext` `renderFreeLayoutSlide` needs
 * (design.md D2, D9): asset ids resolved to HTTP URLs the browser preview
 * can load, local font files declared as `@font-face`, and the logo variant
 * picked for this specific slide's real background color.
 *
 * This lives in the server, not the engine, because the URL shape
 * (`/api/profiles/:slug/assets/...`) and "which logo for this background"
 * are server/request concerns (design.md's `FreeLayoutRenderContext` doc
 * comment says exactly this).
 */

function assetUrl(slug: string, relPathUnderAssets: string): string {
  return `/api/profiles/${slug}/assets/files/${relPathUnderAssets}`;
}

function assetPathById(index: AssetIndexFile, assetId: string): string | undefined {
  return index.entries.find((entry) => entry.id === assetId)?.path;
}

export function assetExistsFactory(index: AssetIndexFile): (assetId: string) => boolean {
  return (assetId: string) => index.entries.some((entry) => entry.id === assetId);
}

/** Resolves the local `@font-face` list from every `kind: font` entry in the library. */
function buildFontFaces(slug: string, index: AssetIndexFile): FontFace[] {
  return index.entries
    .filter((entry) => entry.kind === "font" && entry.status !== "hidden")
    .map((entry) => ({
      family: entry.family ?? entry.path.split("/").pop()!.replace(extname(entry.path), ""),
      url: assetUrl(slug, entry.path.replace(/^assets\//, "")),
    }));
}

/**
 * Resolves the background color that will actually paint behind the
 * footer, for logo-variant picking (design.md D8). Only handles the common
 * `mode: color` case directly; an `mode: asset` background falls back to
 * the brand's `surface` role, since picking a logo variant against an
 * arbitrary photo would require sampling pixels the caller doesn't have
 * (the exact PNG route, `contrast.ts`, is where real pixel sampling
 * happens — this is a best-effort default for the HTML preview only).
 */
function backgroundColorHexFor(
  brand: BrandTokens,
  background: { mode: "color"; colorKey: string } | { mode: "asset"; assetId: string },
): string {
  if (background.mode === "color") {
    return brand.colors[background.colorKey] ?? brand.colors[brand.roles.surface]!;
  }
  return brand.colors[brand.roles.surface]!;
}

export function buildRenderContext(
  store: ProfileStore,
  brand: BrandTokens,
  background: { mode: "color"; colorKey: string } | { mode: "asset"; assetId: string },
): FreeLayoutRenderContext {
  const index = loadIndex(store.roots.profileDir);
  const bgHex = backgroundColorHexFor(brand, background);
  const picked = pickLogo(index, bgHex);

  return {
    assetUrl: (assetId: string) => {
      const path = assetPathById(index, assetId);
      if (!path) {
        throw new Error(`Unknown asset id "${assetId}" — not present in the library index.`);
      }
      return assetUrl(store.slug, path.replace(/^assets\//, ""));
    },
    fontFaces: buildFontFaces(store.slug, index),
    logo: picked
      ? { ...picked, url: assetUrl(store.slug, picked.entry.path.replace(/^assets\//, "")) }
      : undefined,
  };
}

/**
 * The export-time equivalent of `buildRenderContext`: asset URLs resolve to
 * local filesystem paths (Playwright reading `file://` needs no HTTP
 * server), everything else identical.
 */
export function buildExportRenderContext(
  store: ProfileStore,
  brand: BrandTokens,
  background: { mode: "color"; colorKey: string } | { mode: "asset"; assetId: string },
): FreeLayoutRenderContext {
  const index = loadIndex(store.roots.profileDir);
  const bgHex = backgroundColorHexFor(brand, background);
  const picked = pickLogo(index, bgHex);

  const localPath = (relPath: string) => store.absPath(relPath);

  return {
    assetUrl: (assetId: string) => {
      const path = assetPathById(index, assetId);
      if (!path) {
        throw new Error(`Unknown asset id "${assetId}" — not present in the library index.`);
      }
      return localPath(path);
    },
    fontFaces: index.entries
      .filter((entry) => entry.kind === "font" && entry.status !== "hidden")
      .map((entry) => ({
        family: entry.family ?? entry.path.split("/").pop()!.replace(extname(entry.path), ""),
        url: localPath(entry.path),
      })),
    logo: picked ? { ...picked, url: localPath(picked.entry.path) } : undefined,
  };
}
