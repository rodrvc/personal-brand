import type {
  AssetObject,
  BrandTokens,
  CarouselDocument,
  Geometry,
  LayoutTemplate,
  Slide,
  SlideKind,
  SlideObject,
  TextObject,
} from "../api/types";

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

/**
 * Ids for objects and slides created in the editor. `Date.now()` alone
 * collided when two additions landed in the same millisecond (fast clicks,
 * batch inserts), which gave React duplicate keys. A per-session counter
 * keeps ids distinct within a session; a random suffix covers two sessions
 * minting in the same millisecond, which the timestamp alone would not.
 */
let idCounter = 0;
export function newEditorId(prefix: string): string {
  idCounter += 1;
  const nonce = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${nonce}`;
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
      id: newEditorId(`obj-${slideId}-lib`),
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

/**
 * Adds a free-standing text object to a slide — the only path in the editor
 * that can put text on a slide at all (mutations.ts had none before; the
 * "T" tool button called nothing). Mirrors `addLibraryAssetObject`'s shape.
 *
 * Seeds from the active template: if the slide's kind declares a `text`
 * slot not already used by another object, the new object references that
 * `slot` and carries no geometry/style of its own — it inherits the slot's
 * geometry, fontKey, fontSize, lineHeight, align and colorRole at resolve
 * time (`resolveSlide`, carousel-document-resolve.ts), exactly like a
 * template-authored object would. This is what makes new text land where
 * the template expects instead of at an arbitrary spot.
 *
 * Template text slots never declare an `h` (see explicativo.json) — the
 * renderer (`free-layout.ts`'s `renderTextObject`) leaves `height` off the
 * style entirely and lets it come from content. With `text: ""` that lays
 * out at zero height: invisible, and nothing for `SelectionOverlay` to
 * measure or click. So the slotted path seeds a visible non-empty
 * placeholder instead of "" — obviously a placeholder, not real copy, and
 * the owner overwrites it the moment they start typing.
 *
 * When no free text slot exists for this slide kind, falls back to a free
 * (unslotted) object: a default position inside the template's safe
 * margins, `brand.fonts.body` and the `onSurface` role's color key (a
 * `brand.colors` key, never a hex literal — carousel-document.ts's
 * `findHexLiterals` check would reject one). That path already sets an
 * explicit `h`, so it stays visible even with empty text.
 *
 * Takes `objectId` from the caller rather than generating one internally
 * (unlike `addLibraryAssetObject`) so the caller can select the new object
 * right after this returns, without having to re-derive or diff for it.
 */
export function addTextObject(
  doc: CarouselDocument,
  slideId: string,
  objectId: string,
  template: LayoutTemplate,
  brand: BrandTokens,
): CarouselDocument {
  return mapSlide(doc, slideId, (slide) => {
    const usedSlots = new Set(slide.objects.map((o) => o.slot).filter((s): s is string => Boolean(s)));
    const freeTextSlot = template.slides[slide.kind]?.slots.find((s) => s.type === "text" && !usedSlots.has(s.name));

    const base = {
      id: objectId,
      pinned: false,
      locked: false,
      source: "manual" as const,
      kind: "text" as const,
      text: "",
    };

    if (freeTextSlot) {
      const object: TextObject = { ...base, text: "Texto", slot: freeTextSlot.name };
      return { ...slide, objects: [...slide.objects, object] };
    }

    const margins = template.zones.margins;
    const object: TextObject = {
      ...base,
      geometry: { x: margins.left, y: margins.top, w: template.canvas.w - margins.left - margins.right, h: 120, rotation: 0 },
      fontKey: "body",
      fontSize: 48,
      lineHeight: 1.2,
      align: "left",
      colorKey: brand.roles.onSurface,
    };
    return { ...slide, objects: [...slide.objects, object] };
  });
}

/** Adds a slide after `afterIndex` with a plain color background — a slide is never created with no background (schema requires one), so the caller passes a `brand.colors` key. */
export function addSlideWithColor(doc: CarouselDocument, afterIndex: number, colorKey: string, kind: SlideKind = "step"): CarouselDocument {
  const newSlide: Slide = {
    id: newEditorId("slide"),
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
