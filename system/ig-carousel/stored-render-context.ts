import { NotFoundError, type AssetRepository } from "@personal-brand/storage/contracts";
import type { BlobCache } from "@personal-brand/storage/blob";

import type { FontFace } from "./document.js";
import { RENDER_ORIGIN, type AssetResolve } from "./render-batch.js";
import type { FreeLayoutRenderContext } from "./templates/free-layout.js";

const assetUrl = (assetId: string): string => `${RENDER_ORIGIN}/assets/${assetId}`;

/** Serves a brand's assets from the blob cache: asset row -> sha256 -> local file. A hidden asset is not served; a storage failure propagates (the render fails, it does not drop the image). */
export function storedAssetResolver(assets: Pick<AssetRepository, "get">, cache: Pick<BlobCache, "read">, brandId: string): AssetResolve {
  return async (assetId) => {
    try {
      const asset = (await assets.get(brandId, assetId)).value;
      if (asset.status === "hidden") return undefined;
      return { path: await cache.read(asset.sha256), contentType: asset.mime };
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  };
}

/**
 * The `FreeLayoutRenderContext` of a stored brand: asset ids become `http://render.local/assets/<assetId>` (the
 * same URL for preview and export, served by `loadWithResolver`), and every font asset that is not hidden (today
 * `approved` or `candidate`, the only other statuses) becomes an `@font-face`. Assets are served as images and fonts only: a template must never embed one as a
 * document (`<iframe>`, `<object>`, `<embed>`), because an SVG asset opened that way runs its script on the render origin. No logo yet: picking a variant reads folder index entries (see design S9a2 notes).
 */
export async function buildStoredRenderContext(assets: Pick<AssetRepository, "list">, brandId: string): Promise<FreeLayoutRenderContext & { assetExists: (assetId: string) => boolean }> {
  const rows = await assets.list(brandId);
  // A hidden asset is not served (see `storedAssetResolver`), so the context does not know it either.
  const visible = rows.filter((row) => row.value.status !== "hidden");
  const known = new Set(visible.map((row) => row.value.assetId));
  const fontFaces: FontFace[] = visible
    .filter((row) => row.value.kind === "font")
    .map((row) => {
      // An id is not a family name: a font without one would be declared under a name no slide can use.
      if (!row.value.family) throw new Error(`Font asset ${row.value.assetId} has no family: set one before rendering with it.`);
      return { family: row.value.family, url: assetUrl(row.value.assetId) };
    });
  return {
    assetUrl: (assetId) => {
      if (!known.has(assetId)) throw new Error(`Unknown asset id "${assetId}": not in the brand's asset library.`);
      return assetUrl(assetId);
    },
    assetExists: (assetId) => known.has(assetId),
    fontFaces,
  };
}
