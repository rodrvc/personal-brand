import { loadBrand } from "../../../system/ig-carousel/brand-schema.js";
import { loadIndex, type AssetEntry } from "../../../system/assets/index.js";

import { listCarousels } from "./document-store.js";
import { ProfileStore } from "./profile-store.js";

/**
 * Everything the profile picker's brand cards (editor-ui restyle, "generic
 * slop" feedback) need to render a distinct card per brand, computed from
 * files already on disk under `profiles/<slug>/` — no new brand data, just
 * a read-only summary of what's already there.
 *
 * Every field is optional except `carouselCount`: any missing or malformed
 * input (no brand.json, no carousels, no assets) degrades to an absent
 * field rather than a thrown error, so `buildCardSummary` never turns a
 * partially-set-up profile into a 500 for the whole listing.
 */
export interface ProfileCardSummary {
  /** Up to 6 hex values from `brand.colors`, for the palette swatch row. */
  colors: string[];
  logoFont?: string;
  googleFontsHref?: string;
  wordmark?: string;
  /** A gradient from `brand.gradients` to paint behind the cover when there is no image. */
  gradient?: string;
  /** Server-relative URL (e.g. `/api/profiles/<slug>/...`) for the cover image, if one was found. */
  coverImageUrl?: string;
  /** Server-relative URL for a `kind: "logo"` asset, if the profile has one. */
  logoAssetUrl?: string;
  carouselCount: number;
  /** ISO timestamp of the most recent carousel update or asset addition, whichever is newer. */
  lastEditedAt?: string;
}

const COVER_ASSET_KINDS = new Set(["background", "photo", "decoration", "unclassified"]);

function newestByCreatedAt(entries: AssetEntry[]): AssetEntry | undefined {
  return [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

function assetFileUrl(slug: string, entry: AssetEntry): string {
  return `/api/profiles/${slug}/assets/files/${entry.path.replace(/^assets\//, "")}`;
}

/**
 * Builds a card summary for one profile, or `undefined` when the profile
 * has no `brand.json` yet (the picker shows those disabled, with no card
 * data to compute). Never throws: a missing carousels dir or a corrupt
 * asset index just means that part of the summary is left out.
 */
export function buildCardSummary(slug: string): ProfileCardSummary | undefined {
  const store = new ProfileStore(slug);

  let brand;
  try {
    brand = loadBrand(store.roots.profileDir);
  } catch {
    return undefined;
  }

  let carousels: ReturnType<typeof listCarousels> = [];
  try {
    carousels = listCarousels(store);
  } catch {
    // No carousels dir yet — an empty list is a valid, expected state.
  }

  let coverImageUrl: string | undefined;
  let lastEditedAt: string | undefined = carousels[0]?.updatedAt;
  if (carousels.length > 0) {
    coverImageUrl = `/api/profiles/${slug}/carousels/${carousels[0].id}/slides/0/png`;
  }

  let logoAssetUrl: string | undefined;
  try {
    const index = loadIndex(store.roots.profileDir);
    const logoEntry = newestByCreatedAt(index.entries.filter((e) => e.kind === "logo" && e.status !== "hidden"));
    if (logoEntry) {
      logoAssetUrl = assetFileUrl(slug, logoEntry);
      if (!lastEditedAt || logoEntry.createdAt > lastEditedAt) lastEditedAt = logoEntry.createdAt;
    }

    if (!coverImageUrl) {
      const coverEntry = newestByCreatedAt(
        index.entries.filter(
          (e) => COVER_ASSET_KINDS.has(e.kind) && e.mime.startsWith("image/") && e.status !== "hidden",
        ),
      );
      if (coverEntry) {
        coverImageUrl = assetFileUrl(slug, coverEntry);
        if (!lastEditedAt || coverEntry.createdAt > lastEditedAt) lastEditedAt = coverEntry.createdAt;
      }
    }
  } catch {
    // No assets/index.json yet — a brand with no assets still gets a card,
    // just without an asset-derived cover or logo.
  }

  const gradient = brand.gradients ? Object.values(brand.gradients)[0] : undefined;

  return {
    colors: Object.values(brand.colors ?? {}).slice(0, 6),
    logoFont: brand.fonts?.logo,
    googleFontsHref: brand.googleFontsHref,
    wordmark: brand.copy?.wordmark,
    gradient,
    coverImageUrl,
    logoAssetUrl,
    carouselCount: carousels.length,
    lastEditedAt,
  };
}
