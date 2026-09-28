import { loadBrand } from "../../../system/ig-carousel/brand-schema.js";
import { loadIndex, type AssetEntry, type AssetIndexFile } from "../../../system/assets/index.js";

import { CAROUSEL_ID, readCarouselHeader } from "./document-store.js";
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
 *
 * Takes the slide as unparsed JSON (`unknown`), not the validated `Slide`
 * type — see `listCarouselIds`'s doc comment for why: the listing route
 * reads every carousel's file, and paying full schema validation on all of
 * them per request is what made `GET /api/profiles` slow in the first
 * place. Every field access here is defensive (`typeof` checks, optional
 * chaining) precisely because nothing has validated this shape yet.
 */
function rawSlideHasContent(slide: unknown, store: ProfileStore, index: AssetIndexFile): boolean {
  if (!slide || typeof slide !== "object") return false;
  const { background, objects } = slide as { background?: unknown; objects?: unknown };

  if (background && typeof background === "object") {
    const bg = background as { mode?: unknown; assetId?: unknown };
    if (bg.mode === "asset" && typeof bg.assetId === "string") return assetResolves(store, index, bg.assetId);
  }

  if (!Array.isArray(objects)) return false;
  return objects.some((object) => {
    if (!object || typeof object !== "object") return false;
    const obj = object as { kind?: unknown; assetId?: unknown; text?: unknown };
    if (obj.kind === "asset") return typeof obj.assetId === "string" && assetResolves(store, index, obj.assetId);
    if (obj.kind === "text") return typeof obj.text === "string" && obj.text.trim().length > 0;
    return false;
  });
}

interface RawCarouselMeta {
  id: string;
  updatedAt: string;
  firstSlide: unknown;
}

/**
 * Every carousel directory name under `carousels/`, filtered to the same
 * slug shape `document-store.ts` requires — cheap: one `readdirSync`, no
 * file content touched. `listCarousels` (document-store.ts) does the same
 * listing but returns only the display fields; the card also needs
 * `slides[0]`, so it walks the ids itself and reads each document through
 * the same `readCarouselHeader` — raw, no schema validation (which reloads
 * the brand and the asset index per carousel and made `GET /api/profiles`
 * take ~6s on a 69-carousel profile), and with the same skip rules, so the
 * card's carousel count always matches the listing.
 */
function listCarouselIds(store: ProfileStore): string[] {
  return store
    .list("carousels")
    .filter((entry) => entry.isDirectory() && CAROUSEL_ID.test(entry.name))
    .map((entry) => entry.name);
}

/** `readCarouselHeader` reduced to what the card uses; `undefined` for anything the listing would skip too. */
function readRawCarouselMeta(store: ProfileStore, id: string): RawCarouselMeta | undefined {
  const header = readCarouselHeader(store, id);
  if (!header) return undefined;
  return { id: header.id, updatedAt: header.updatedAt, firstSlide: header.slides[0] };
}

/** Every carousel's cheap metadata, newest-first — the same ordering `listCarousels` produces, at a fraction of the cost (see `listCarouselIds`). */
function listCarouselMetas(store: ProfileStore): RawCarouselMeta[] {
  const metas: RawCarouselMeta[] = [];
  for (const id of listCarouselIds(store)) {
    const meta = readRawCarouselMeta(store, id);
    if (meta) metas.push(meta);
  }
  return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * Picks the most recently updated carousel whose first slide actually has
 * content, walking `carousels` (already sorted newest-first) until one
 * qualifies. Returns `undefined` when none do (every carousel is still
 * empty, has only unrenderable asset references, or the list itself is
 * empty) — the caller falls back to an asset cover, then a gradient.
 */
function pickCoverCarouselId(store: ProfileStore, carousels: RawCarouselMeta[], index: AssetIndexFile): string | undefined {
  return carousels.find((c) => rawSlideHasContent(c.firstSlide, store, index))?.id;
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

  let carousels: RawCarouselMeta[] = [];
  try {
    carousels = listCarouselMetas(store);
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
