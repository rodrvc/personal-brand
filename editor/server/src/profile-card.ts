import { loadBrand } from "../../../system/ig-carousel/brand-schema.js";
import type { Slide } from "../../../system/ig-carousel/carousel-document.js";
import { loadIndex, type AssetEntry, type AssetIndexFile } from "../../../system/assets/index.js";

import { listCarousels, readValidatedDocument } from "./document-store.js";
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
 * True when `assetId` resolves to a file the PNG route can actually serve:
 * present in the asset index AND its file still exists on disk at
 * `entry.path`. Mirrors what happens at render time — `assetExistsFactory`
 * (render-context.ts) only checks the index, but `GET
 * /assets/files/*splat` (routes/assets.ts) calls `ProfileStore.readFile`,
 * which throws for an index entry whose file went missing (e.g. it was
 * only ever uploaded to a remote bucket, or got deleted from disk without
 * a rescan) — Chromium then paints nothing for that `<img>`. An index-only
 * check would have picked exactly that carousel as the cover and rendered
 * a blank sheet.
 */
function assetResolves(store: ProfileStore, index: AssetIndexFile, assetId: string): boolean {
  const entry = index.entries.find((e) => e.id === assetId);
  return entry !== undefined && store.exists(entry.path);
}

/**
 * True when a slide carries something worth showing as a cover: a
 * background resolved to an image that actually exists on disk (`mode:
 * "asset"`), an asset object whose `assetId` resolves the same way, or a
 * text object with non-empty text. A freshly created carousel's default
 * slide (color background, no objects, or objects still `pending`/empty)
 * fails every one of these, and so does a slide whose only object is an
 * asset reference nothing can actually render — which is the point: a
 * brand-new or unrenderable-content carousel must not win the "most
 * recent" race against an older carousel with real, renderable content.
 */
function slideHasContent(slide: Slide, store: ProfileStore, index: AssetIndexFile): boolean {
  if (slide.background.mode === "asset") return assetResolves(store, index, slide.background.assetId);
  return slide.objects.some((object) => {
    if (object.kind === "asset") return Boolean(object.assetId) && assetResolves(store, index, object.assetId!);
    if (object.kind === "text") return object.text.trim().length > 0;
    return false;
  });
}

/**
 * Picks the most recently updated carousel whose first slide actually has
 * content, walking `carousels` (already sorted newest-first by
 * `listCarousels`) until one qualifies. Returns `undefined` when none do
 * (every carousel is still empty, has only unrenderable asset references,
 * or the list itself is empty) — the caller falls back to an asset cover,
 * then a gradient.
 */
function pickCoverCarouselId(
  store: ProfileStore,
  carousels: ReturnType<typeof listCarousels>,
  index: AssetIndexFile,
): string | undefined {
  for (const summary of carousels) {
    try {
      const doc = readValidatedDocument(store, summary.id);
      const firstSlide = doc.slides[0];
      if (firstSlide && slideHasContent(firstSlide, store, index)) return summary.id;
    } catch {
      // A corrupt document is skipped, same as listCarousels already does.
      continue;
    }
  }
  return undefined;
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

  // Loaded once up front (rather than inside the asset-fallback block
  // below) because `pickCoverCarouselId` needs it too, to tell an asset
  // reference that actually resolves apart from one that doesn't.
  let index: AssetIndexFile = { entries: [] };
  try {
    index = loadIndex(store.roots.profileDir);
  } catch {
    // No assets/index.json yet — a brand with no assets still gets a card,
    // just without an asset-derived cover, logo, or resolvable slide asset.
  }

  let coverImageUrl: string | undefined;
  let lastEditedAt: string | undefined = carousels[0]?.updatedAt;
  const coverCarouselId = pickCoverCarouselId(store, carousels, index);
  if (coverCarouselId) {
    coverImageUrl = `/api/profiles/${slug}/carousels/${coverCarouselId}/slides/0/png`;
  }

  // Same reasoning as `assetResolves` above: an index entry whose file is
  // gone from disk (remote-only upload, manual deletion without a rescan)
  // must not be offered as a logo or cover either — `store.exists` is the
  // same check the confined `assets/files/*` route effectively performs.
  let logoAssetUrl: string | undefined;
  const logoEntry = newestByCreatedAt(
    index.entries.filter((e) => e.kind === "logo" && e.status !== "hidden" && store.exists(e.path)),
  );
  if (logoEntry) {
    logoAssetUrl = assetFileUrl(slug, logoEntry);
    if (!lastEditedAt || logoEntry.createdAt > lastEditedAt) lastEditedAt = logoEntry.createdAt;
  }

  if (!coverImageUrl) {
    const coverEntry = newestByCreatedAt(
      index.entries.filter(
        (e) => COVER_ASSET_KINDS.has(e.kind) && e.mime.startsWith("image/") && e.status !== "hidden" && store.exists(e.path),
      ),
    );
    if (coverEntry) {
      coverImageUrl = assetFileUrl(slug, coverEntry);
      if (!lastEditedAt || coverEntry.createdAt > lastEditedAt) lastEditedAt = coverEntry.createdAt;
    }
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
