import type { AssetEntry, AssetKind } from "../../api/types";
import { t } from "../../i18n";
import type { LocaleKey } from "../../i18n";

/**
 * Locale key per asset kind, shared by `BucketPane` (the in-document
 * library, ACU-?) and `AssetsPane` (the brand-wide listing before any
 * document is open, ACU-230) so the two never drift apart on naming.
 * `unclassified` is listed here too — most real assets land there before a
 * human sorts them, so it must render like any other group, never be
 * filtered out. Kept as a key map (not resolved strings) so `t()` runs
 * lazily, in `assetKindLabel()`, never at module load.
 */
export const ASSET_KIND_LABEL_KEY: Record<AssetKind, LocaleKey> = {
  background: "bucketPane.assetKind.background",
  character: "bucketPane.assetKind.character",
  photo: "bucketPane.assetKind.photo",
  logo: "bucketPane.assetKind.logo",
  decoration: "bucketPane.assetKind.decoration",
  font: "bucketPane.assetKind.font",
  unclassified: "bucketPane.assetKind.unclassified",
};

export function assetKindLabel(kind: AssetKind): string {
  return t(ASSET_KIND_LABEL_KEY[kind]);
}

/**
 * Groups non-hidden assets by kind, preserving each entry's position within
 * its group. `hidden` assets are dropped for both callers: a hidden asset
 * was explicitly taken out of the working set, so neither the in-document
 * bucket nor the brand-wide listing should surface it.
 */
export function groupAssetsByKind(entries: AssetEntry[]): Map<AssetKind, AssetEntry[]> {
  const grouped = new Map<AssetKind, AssetEntry[]>();
  for (const entry of entries) {
    if (entry.status === "hidden") continue;
    if (!grouped.has(entry.kind)) grouped.set(entry.kind, []);
    grouped.get(entry.kind)!.push(entry);
  }
  return grouped;
}

/**
 * Extensions the server (`editor/server/src/routes/assets.ts`'s
 * `mimeFromPath`) serves with an `image/*` content type, so a tile can point
 * a `background-image: url(...)` at them safely. Fonts are excluded not
 * because of `application/octet-stream` — they get their own `font/*` types
 * — but because a font file isn't paintable as an image. `AssetEntry`
 * carries no mime/kind field to read instead, so this decides by extension,
 * mirroring the server's own table.
 */
const RENDERABLE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "svg"]);

/** Whether an asset's file can be shown as an image tile (`background-image`), vs. a neutral file tile. */
export function isRenderableImage(entry: Pick<AssetEntry, "path">): boolean {
  const ext = entry.path.toLowerCase().split(".").pop() ?? "";
  return RENDERABLE_IMAGE_EXTENSIONS.has(ext);
}
