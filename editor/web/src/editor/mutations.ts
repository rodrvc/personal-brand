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
import { resetObjectToSlot as engineResetObjectToSlot } from "../../../../system/ig-carousel/carousel-document-resolve.js";

/**
 * Keeps an object's box fully inside the canvas (QA: a text object was
 * dragged to `geometry.y: -203` with no clamp). Clamps the whole box, not
 * just the origin: the far edge (`x + w`, `y + h`) must also stay on-canvas.
 * An object larger than the canvas is pinned at 0 rather than shrunk —
 * resizing is a separate, explicit user action. `rotation` is ignored: this
 * is an axis-aligned clamp, and a rotated box's true bounding rect isn't
 * representable in this geometry shape.
 */
export function clampGeometryToCanvas(geometry: Geometry, canvas: { w: number; h: number }): Geometry {
  const x = geometry.w >= canvas.w ? 0 : Math.min(Math.max(geometry.x, 0), canvas.w - geometry.w);
  const result: Geometry = { ...geometry, x };
  if (geometry.h !== undefined) {
    const y = geometry.h >= canvas.h ? 0 : Math.min(Math.max(geometry.y, 0), canvas.h - geometry.h);
    result.y = y;
  } else {
    result.y = Math.min(Math.max(geometry.y, 0), canvas.h);
  }
  return result;
}

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
  const clamped = clampGeometryToCanvas(geometry, doc.canvas);
  return mapSlide(doc, slideId, (slide) => mapObject(slide, objectId, (o) => ({ ...o, geometry: clamped })));
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
  const clamped = clampGeometryToCanvas(geometry, doc.canvas);
  return mapSlide(doc, slideId, (slide) =>
    mapObject(slide, objectId, (o) => {
      const next = { ...o, geometry: clamped };
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

/**
 * Restores a slotted object to whatever the template slot defines. The
 * field-dropping rule (geometry, plus a text object's typographic
 * overrides — never `colorKey`, a document-level pin) lives once in the
 * engine (`resetObjectToSlot`, carousel-document-resolve.ts) so callers
 * can't drift into a different reset rule. This wrapper just locates the
 * object and no-ops on a free (unslotted) one — the engine function throws
 * for that, a caller bug here since "Restablecer" only renders when
 * `selectedObject.slot` is set.
 */
export function resetObjectToSlot(doc: CarouselDocument, slideId: string, objectId: string): CarouselDocument {
  return mapSlide(doc, slideId, (slide) =>
    mapObject(slide, objectId, (o) => (o.slot ? engineResetObjectToSlot(o) : o)),
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
