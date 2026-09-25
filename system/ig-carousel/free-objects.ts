import type { AssetObject, CarouselDocument } from "./carousel-document.js";

const FREE_ASSET_GEOMETRY = { x: 100, y: 100, w: 400, h: 400, rotation: 0 };

/** Adds an unslotted asset object with its own geometry, which the owner then moves and scales by hand. */
export function addFreeAssetObject(
  doc: CarouselDocument,
  slideId: string,
  object: Pick<AssetObject, "id" | "assetId" | "source"> & { fit?: AssetObject["fit"] },
): CarouselDocument {
  const added: AssetObject = {
    id: object.id,
    pinned: true,
    locked: false,
    source: object.source,
    kind: "asset",
    assetId: object.assetId,
    fit: object.fit ?? "cover",
    geometry: FREE_ASSET_GEOMETRY,
  };
  return {
    ...doc,
    slides: doc.slides.map((slide) => (slide.id === slideId ? { ...slide, objects: [...slide.objects, added] } : slide)),
    updatedAt: new Date().toISOString(),
  };
}

/** Returns `doc` itself when nothing matches, so callers can tell a no-op by identity. */
export function removeObject(doc: CarouselDocument, slideId: string, objectId: string): CarouselDocument {
  const slide = doc.slides.find((s) => s.id === slideId);
  if (!slide?.objects.some((o) => o.id === objectId)) return doc;
  return {
    ...doc,
    slides: doc.slides.map((s) => (s.id === slideId ? { ...s, objects: s.objects.filter((o) => o.id !== objectId) } : s)),
    updatedAt: new Date().toISOString(),
  };
}
