import type { AssetObject, CarouselDocument, Geometry, Slide, SlideKind, SlideObject, TextObject } from "../api/types";

function mapSlide(doc: CarouselDocument, slideId: string, fn: (slide: Slide) => Slide): CarouselDocument {
  return {
    ...doc,
    slides: doc.slides.map((s) => (s.id === slideId ? fn(s) : s)),
    updatedAt: new Date().toISOString(),
  };
}

function mapObject(slide: Slide, objectId: string, fn: (object: SlideObject) => SlideObject): Slide {
  return { ...slide, objects: slide.objects.map((o) => (o.id === objectId ? fn(o) : o)) };
}

export function setObjectPinned(doc: CarouselDocument, slideId: string, objectId: string, pinned: boolean): CarouselDocument {
  return mapSlide(doc, slideId, (slide) => mapObject(slide, objectId, (o) => ({ ...o, pinned })));
}

export function setBackgroundPinned(doc: CarouselDocument, slideId: string, pinned: boolean): CarouselDocument {
  return mapSlide(doc, slideId, (slide) => ({ ...slide, background: { ...slide.background, pinned } }));
}

export function setObjectGeometry(doc: CarouselDocument, slideId: string, objectId: string, geometry: Geometry): CarouselDocument {
  return mapSlide(doc, slideId, (slide) => mapObject(slide, objectId, (o) => ({ ...o, geometry })));
}

export function setTextFontSize(doc: CarouselDocument, slideId: string, objectId: string, fontSize: number): CarouselDocument {
  return mapSlide(doc, slideId, (slide) =>
    mapObject(slide, objectId, (o) => (o.kind === "text" ? { ...o, fontSize } : o)),
  );
}

export function setObjectGeometryAndFontSize(
  doc: CarouselDocument,
  slideId: string,
  objectId: string,
  geometry: Geometry,
  fontSize: number | undefined,
): CarouselDocument {
  return mapSlide(doc, slideId, (slide) =>
    mapObject(slide, objectId, (o) => {
      const next = { ...o, geometry };
      if (fontSize !== undefined && next.kind === "text") (next as TextObject).fontSize = fontSize;
      return next;
    }),
  );
}

export function setTextContent(doc: CarouselDocument, slideId: string, objectId: string, text: string): CarouselDocument {
  return mapSlide(doc, slideId, (slide) =>
    mapObject(slide, objectId, (o) => (o.kind === "text" ? { ...o, text } : o)),
  );
}

export function setTextStyle(
  doc: CarouselDocument,
  slideId: string,
  objectId: string,
  patch: Partial<Pick<TextObject, "fontSize" | "lineHeight" | "align" | "colorKey">>,
): CarouselDocument {
  return mapSlide(doc, slideId, (slide) =>
    mapObject(slide, objectId, (o) => (o.kind === "text" ? { ...o, ...patch } : o)),
  );
}

export function resetObjectToSlot(doc: CarouselDocument, slideId: string, objectId: string): CarouselDocument {
  return mapSlide(doc, slideId, (slide) =>
    mapObject(slide, objectId, (o) => {
      if (!o.slot) return o;
      const { geometry: _geometry, ...rest } = o;
      void _geometry;
      return rest as SlideObject;
    }),
  );
}

export function setBackgroundColor(doc: CarouselDocument, slideId: string, colorKey: string): CarouselDocument {
  return mapSlide(doc, slideId, (slide) => ({
    ...slide,
    background: { mode: "color", colorKey, pinned: slide.background.pinned, source: "manual" },
  }));
}

export function setBackgroundAsset(doc: CarouselDocument, slideId: string, assetId: string): CarouselDocument {
  return mapSlide(doc, slideId, (slide) => ({
    ...slide,
    background: { mode: "asset", assetId, pinned: slide.background.pinned, source: "library" },
  }));
}

export function addLibraryAssetObject(doc: CarouselDocument, slideId: string, assetId: string): CarouselDocument {
  return mapSlide(doc, slideId, (slide) => {
    const object: AssetObject = {
      id: `obj-${slideId}-lib-${Date.now()}`,
      pinned: true,
      locked: false,
      source: "library",
      kind: "asset",
      assetId,
      fit: "cover",
      geometry: { x: 100, y: 100, w: 400, h: 400, rotation: 0 },
    };
    return { ...slide, objects: [...slide.objects, object] };
  });
}

/** Adds a slide after `afterIndex` with a plain color background — a slide is never created with no background (schema requires one), so the caller passes a `brand.colors` key. */
export function addSlideWithColor(doc: CarouselDocument, afterIndex: number, colorKey: string, kind: SlideKind = "step"): CarouselDocument {
  const newSlide: Slide = {
    id: `slide-${Date.now()}`,
    kind,
    background: { mode: "color", colorKey, pinned: false, source: "manual" },
    objects: [],
  };
  const slides = [...doc.slides];
  slides.splice(afterIndex + 1, 0, newSlide);
  return { ...doc, slides, updatedAt: new Date().toISOString() };
}

export function setSlideKind(doc: CarouselDocument, slideId: string, kind: SlideKind): CarouselDocument {
  return mapSlide(doc, slideId, (slide) => ({ ...slide, kind }));
}
