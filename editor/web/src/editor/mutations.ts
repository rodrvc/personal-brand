import type {
  AssetObject,
  BrandTokens,
  CarouselDocument,
  Geometry,
  LayoutTemplate,
  Slide,
  SlideKind,
  SlideObject,
  TemplateRef,
  TextObject,
} from "../api/types";
import { t } from "../i18n";
import {
  changeTemplate,
  FREE_TEMPLATE_ID,
  resetObjectToSlot as engineResetObjectToSlot,
} from "../../../../system/ig-carousel/object-reset.js";

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

/** Vertical gap kept between a new free box and whatever it is placed next to. */
const PLACEMENT_GAP = 24;

/**
 * Inset used in place of the template's margins when it declares none.
 * The free template (`freeLayoutTemplate()`) has zero margins on purpose —
 * it imposes no structure — but `placeFreeGeometry` reads those margins as
 * the safe area, so a new text box would land flush at (0, 0) and span the
 * full canvas, touching every edge. A fixed inset keeps it visible and
 * grabbable without inventing a structure the template deliberately omits.
 */
const NO_MARGIN_INSET = 80;

/** Assumed height for a content-sized text rect with no `h` (no text slot in explicativo.json declares one) — a placement estimate, never `?? 0`, which would let a box sit flush on a heightless slot's baseline. */
const NOMINAL_TEXT_HEIGHT = 120;

/**
 * The template's margins, or `NO_MARGIN_INSET` on every side when it
 * declares none at all. Applied to placement only — nothing is written back
 * to the template, so a template that really means "no margins" still
 * renders its zones edge to edge.
 */
function effectiveMargins(template: LayoutTemplate): LayoutTemplate["zones"]["margins"] {
  const { top, right, bottom, left } = template.zones.margins;
  if (top === 0 && right === 0 && bottom === 0 && left === 0) {
    return { top: NO_MARGIN_INSET, right: NO_MARGIN_INSET, bottom: NO_MARGIN_INSET, left: NO_MARGIN_INSET };
  }
  return template.zones.margins;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Every rect already on the slide, resolved like `resolveSlide` does: an object's own `geometry` wins if present (a free object, or a slotted one the user dragged — `setObjectGeometryAndFontSize` sets `geometry` without clearing `slot`); otherwise a slotted object falls back to its slot's template rect. */
function occupiedRects(objects: SlideObject[], template: LayoutTemplate, kind: SlideKind): Rect[] {
  return objects
    .map((o): Rect | undefined => {
      const geometry = o.geometry ?? template.slides[kind]?.slots.find((s) => s.name === o.slot)?.geometry;
      if (!geometry) return undefined;
      return { x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h ?? NOMINAL_TEXT_HEIGHT };
    })
    .filter((r): r is Rect => r !== undefined);
}

/**
 * Placement for a new full-width free text box of height `h` avoiding
 * everything already on the slide. Pass 1 searches only `y` (free boxes
 * always span the full content width): walk the occupied spans top to
 * bottom and return the first `y` from the top margin whose `[y, y+h]`,
 * padded by `PLACEMENT_GAP`, clears every span and fits above the bottom
 * margin. Pass 2, when no gap fits, cascades both axes together
 * (`margin + k*GAP`, clamped) like a desktop editor's paste-in-place —
 * moving both axes keeps origins distinct across many boxes, unlike a
 * y-only cascade that repeats itself once it clamps. Once both axes
 * saturate, further boxes share that clamped origin: the honest limit of a
 * full slide, not a bug in the search.
 */
function placeFreeGeometry(
  objects: SlideObject[],
  template: LayoutTemplate,
  kind: SlideKind,
  h: number,
): { x: number; y: number } {
  const margins = effectiveMargins(template);
  const { left, top } = margins;
  const bottom = template.canvas.h - margins.bottom;

  const rects = occupiedRects(objects, template, kind);
  const spans = rects.map((r) => [r.y - PLACEMENT_GAP, r.y + r.h + PLACEMENT_GAP] as const).sort((a, b) => a[0] - b[0]);

  let candidate = top;
  for (const [spanStart, spanEnd] of spans) {
    if (candidate + h <= spanStart) break; // gap found before this span
    if (candidate < spanEnd) candidate = spanEnd; // push past an overlapping span
  }
  if (candidate + h <= bottom) return { x: left, y: candidate };

  // Pass 2: diagonal cascade. `x` has no template ceiling (a free box's `w`
  // stays fixed by the caller), so clamp its drift to a few gaps; `y` clamps
  // to the bottom margin like pass 1.
  const maxDriftSteps = 6;
  const origins = new Set(rects.map((r) => `${r.x},${r.y}`));
  const bottomY = Math.max(top, bottom - h);
  for (let k = 0; ; k++) {
    const x = left + PLACEMENT_GAP * Math.min(k, maxDriftSteps);
    const y = Math.min(top + PLACEMENT_GAP * k, bottomY);
    if (!origins.has(`${x},${y}`)) return { x, y };
    if (y >= bottomY && k >= maxDriftSteps) return { x, y }; // saturated: honest overlap
  }
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
 * (unslotted) object: `placeFreeGeometry` (see `occupiedRects`) finds a spot
 * inside the template's safe margins clear of everything already on the
 * slide, slotted or free, template-positioned or dragged. With the free
 * template, whose margins are all zero, `effectiveMargins` substitutes
 * `NO_MARGIN_INSET` so the box does not land flush at (0, 0). Styles with
 * `brand.fonts.body` and the `onSurface` role's color key (a `brand.colors`
 * key, never a hex literal). That path always sets an explicit `h`, so it
 * stays visible even with empty text.
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
      const object: TextObject = { ...base, text: t("common.newTextPlaceholder"), slot: freeTextSlot.name };
      return { ...slide, objects: [...slide.objects, object] };
    }

    const margins = effectiveMargins(template);
    const h = NOMINAL_TEXT_HEIGHT;
    const { x, y } = placeFreeGeometry(slide.objects, template, slide.kind, h);
    const object: TextObject = {
      ...base,
      geometry: { x, y, w: template.canvas.w - margins.left - margins.right, h, rotation: 0 },
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

/**
 * Points the document at a different template (or at none), applying the
 * engine's swap rule (`changeTemplate`, object-reset.ts) to every slide:
 * an object whose slot exists in both templates keeps its text and takes
 * the new template's geometry; one whose slot the new template lacks stays
 * where it is but loses its slot; a free object is untouched. Per-carousel
 * `template.params` are dropped — they are keyed to the old template's
 * shape.
 *
 * `ref` is the caller's intent and `to` is the template actually fetched;
 * the two must describe the same choice. They come from different places —
 * the panel knows which row the user clicked, the network knows what came
 * back — so a mismatch is a real possibility (a stale row, a redirected
 * fetch) and it is exactly the kind that would silently persist a document
 * pointing at a template it was never remapped onto. Rather than letting
 * either side win, disagreement throws: `ref` must be `undefined` for the
 * free template and `{ id: to.id }` for any other.
 */
export function setTemplateRef(
  doc: CarouselDocument,
  ref: TemplateRef | undefined,
  from: LayoutTemplate,
  to: LayoutTemplate,
): CarouselDocument {
  const wantsFree = ref === undefined;
  const isFree = to.id === FREE_TEMPLATE_ID;
  if (wantsFree !== isFree || (ref !== undefined && ref.id !== to.id)) {
    throw new Error(
      `Template reference ${ref ? `"${ref.id}"` : "(none)"} does not match the resolved template "${to.id}" — ` +
        `the document would point at a template its slides were not remapped onto.`,
    );
  }

  const swapped = changeTemplate(doc, from, to);
  if (ref === undefined) {
    const { template: _template, ...rest } = swapped;
    return rest as CarouselDocument;
  }
  return { ...swapped, template: ref };
}
