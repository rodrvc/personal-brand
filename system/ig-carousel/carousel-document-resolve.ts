import type { LayoutSlot, LayoutTemplate } from "./layout-template.js";
import type { AssetObject, CarouselDocument, Geometry, Slide, SlideKind, SlideObject, TextObject } from "./carousel-document.js";

/**
 * Pure helpers that implement template → carousel → slide inheritance
 * (design.md D4): an object that names a `slot` and carries no `geometry`
 * of its own is positioned and styled by the template at resolve time, not
 * by a copy baked into the document. This is what makes "move the footer
 * margin" affect every slide that never overrode it (layout-template spec,
 * "Herencia hacia las láminas").
 *
 * Nothing here touches disk or a document in place — every function returns
 * a new value, so callers (API handlers, the editor, tests) control when a
 * result actually gets persisted.
 */

/** A resolved object: template defaults merged with any document override, ready to render. */
export interface ResolvedObject {
  id: string;
  slot?: string;
  geometry: Geometry;
  pinned: boolean;
  locked: boolean;
  source: SlideObject["source"];
  content:
    | {
        kind: "text";
        text: string;
        // Optional: a free object (no slot) with no own style has nothing
        // to resolve these from. A slotted object always ends up with
        // these filled, either from itself or from the slot.
        fontKey?: string;
        fontSize?: number;
        lineHeight?: number;
        align?: TextObject["align"];
        colorRole?: string;
        colorKey?: string;
      }
    // `assetId` is optional here for the same reason it's optional on
    // `AssetObject` (carousel-document.ts): a `pending: true` placeholder
    // created by the immediate-build compose flow has no image yet. The
    // renderer (templates/free-layout.ts) treats a missing `assetId` as an
    // empty placeholder box rather than throwing.
    | { kind: "asset"; assetId?: string; fit: AssetObject["fit"] };
}

export interface ResolvedSlide {
  id: string;
  kind: SlideKind;
  background: Slide["background"];
  objects: ResolvedObject[];
}

function findSlot(template: LayoutTemplate, kind: SlideKind, name: string): LayoutSlot | undefined {
  return template.slides[kind]?.slots.find((slot) => slot.name === name);
}

/**
 * Resolves one slide's objects against the template's slots for its kind.
 * An object with `slot` and no `geometry` inherits the slot's geometry; an
 * object with its own `geometry` keeps it (an explicit override always
 * wins). Text style (`fontKey`, `fontSize`, `lineHeight`, `align`) is
 * resolved field by field: whatever the object states itself wins,
 * whatever it omits is taken from the slot — this is what makes changing a
 * slot's `fontSize` in the template move every untouched object, exactly
 * like a geometry change does. `colorRole` always comes from the slot (a
 * slot names a brand *role*, never a document object); `colorKey` is kept
 * only when the object itself declares one, since that's a document-level
 * pin of a specific `brand.colors` key, distinct from the slot's role. A
 * free object (no `slot`) is used exactly as authored, with no fallback to
 * pull style from.
 */
export function resolveSlide(_doc: CarouselDocument, slide: Slide, template: LayoutTemplate): ResolvedSlide {
  const objects: ResolvedObject[] = slide.objects.map((object) => {
    const slot = object.slot ? findSlot(template, slide.kind, object.slot) : undefined;
    const geometry = object.geometry ?? slot?.geometry;
    if (!geometry) {
      throw new Error(
        `Object "${object.id}" has no geometry and its slot "${object.slot ?? "(none)"}" ` +
          `does not exist on kind "${slide.kind}" — nothing to resolve it against.`,
      );
    }

    const base = { id: object.id, slot: object.slot, geometry, pinned: object.pinned, locked: object.locked, source: object.source };

    if (object.kind === "text") {
      const textSlot = slot?.type === "text" ? slot : undefined;
      return {
        ...base,
        content: {
          kind: "text",
          text: object.text,
          fontKey: object.fontKey ?? textSlot?.fontKey,
          fontSize: object.fontSize ?? textSlot?.fontSize,
          lineHeight: object.lineHeight ?? textSlot?.lineHeight,
          align: object.align ?? textSlot?.align,
          colorRole: textSlot?.colorRole,
          colorKey: object.colorKey,
        },
      };
    }
    return {
      ...base,
      content: { kind: "asset", assetId: object.assetId, fit: object.fit },
    };
  });

  return { id: slide.id, kind: slide.kind, background: slide.background, objects };
}

/**
 * "Reset to template": drops an object's own `geometry`, restoring
 * inheritance from its slot. Throws if the object has no `slot` — a free
 * object has nothing to reset to, and that's a caller error rather than
 * something this function should guess at silently.
 */
export function resetObjectToSlot<T extends SlideObject>(object: T): T {
  if (!object.slot) {
    throw new Error(`Object "${object.id}" has no slot — nothing to reset it to.`);
  }
  const { geometry: _geometry, ...rest } = object;
  return rest as T;
}

/**
 * Changes a slide's `kind`, carrying over text for slots that exist under
 * both the old and new kind (keeping their text, taking the new kind's
 * geometry — i.e. dropping any per-object override so the slot's new
 * geometry applies), and turning objects whose slot doesn't exist under the
 * new kind into free objects (slot cleared, but their last-known geometry
 * is preserved as an explicit override so they don't collapse to the
 * origin).
 */
export function changeSlideKind(slide: Slide, newKind: SlideKind, template: LayoutTemplate): Slide {
  if (newKind === slide.kind) {
    return slide;
  }

  const objects: SlideObject[] = slide.objects.map((object) => {
    if (!object.slot) {
      return object;
    }

    const stillExists = findSlot(template, newKind, object.slot) !== undefined;
    if (stillExists) {
      // Keep the text/asset content and the slot reference; drop any own
      // geometry override so the new kind's slot geometry takes over.
      const { geometry: _geometry, ...rest } = object;
      return rest as SlideObject;
    }

    // Slot doesn't exist in the new kind: become a free object, freezing
    // the geometry it had (own override, or the old kind's slot geometry)
    // so it doesn't disappear to (0,0).
    const oldSlot = findSlot(template, slide.kind, object.slot);
    const geometry = object.geometry ?? oldSlot?.geometry;
    if (!geometry) {
      throw new Error(`Object "${object.id}" has no resolvable geometry to freeze when leaving slot "${object.slot}".`);
    }
    const { slot: _slot, ...rest } = object;
    return { ...rest, geometry } as SlideObject;
  });

  return { ...slide, kind: newKind, objects };
}
