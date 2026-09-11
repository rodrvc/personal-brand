import { FREE_TEMPLATE_ID, type LayoutSlot, type LayoutTemplate } from "./layout-template.js";
import type { AssetObject, CarouselDocument, Geometry, Slide, SlideKind, SlideObject, TextObject } from "./carousel-document.js";
import type { TemplateRef } from "./carousel-document.js";

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
    // empty placeholder box rather than throwing. `awaitingImage` carries
    // through so the renderer can tell "still working" (`pending`) apart
    // from "no library candidate, waiting on an explicit generate request"
    // (`awaitingImage`) — the two render as the same empty box shape but
    // the latter also gets a `data-awaiting="true"` marker and label.
    | { kind: "asset"; assetId?: string; fit: AssetObject["fit"]; awaitingImage?: boolean };
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
      content: { kind: "asset", assetId: object.assetId, fit: object.fit, awaitingImage: object.awaitingImage },
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
 * Shared core of `changeSlideKind` and `changeTemplate` — per object: no
 * `slot` (free) is untouched; `slot` exists under `toKind` in `toTemplate`
 * keeps content and slot, drops own `geometry` so the destination slot's
 * applies; `slot` absent there demotes to free (slot cleared, geometry
 * frozen from its own override or else the *origin* slot's). Kind change
 * varies `toKind`/holds template fixed; template change varies the
 * template/holds kind fixed — one rule, two callers, provably in sync.
 */
function remapObjects(
  objects: SlideObject[],
  fromTemplate: LayoutTemplate,
  fromKind: SlideKind,
  toTemplate: LayoutTemplate,
  toKind: SlideKind,
): SlideObject[] {
  return objects.map((object) => {
    if (!object.slot) {
      return object;
    }

    const stillExists = findSlot(toTemplate, toKind, object.slot) !== undefined;
    if (stillExists) {
      // Keep the text/asset content and the slot reference; drop any own
      // geometry override so the destination slot's geometry takes over.
      const { geometry: _geometry, ...rest } = object;
      return rest as SlideObject;
    }

    // Slot doesn't exist at the destination: become a free object, freezing
    // the geometry it had (own override, or the origin slot's geometry) so
    // it doesn't disappear to (0,0).
    const originSlot = findSlot(fromTemplate, fromKind, object.slot);
    const geometry = object.geometry ?? originSlot?.geometry;
    if (!geometry) {
      throw new Error(`Object "${object.id}" has no resolvable geometry to freeze when leaving slot "${object.slot}".`);
    }
    const { slot: _slot, ...rest } = object;
    return { ...rest, geometry } as SlideObject;
  });
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

  const objects = remapObjects(slide.objects, template, slide.kind, template, newKind);
  return { ...slide, kind: newKind, objects };
}

/**
 * Changes a document's template reference (layout-template spec's
 * "Changing the reference"): `remapObjects`'s rule, per slide, template
 * varying and kind fixed. `template.params` are dropped on the swap — keyed
 * to the old template's shape, they'd silently misapply or fail validation
 * for a reason unrelated to the swap. `doc.template` becomes `{ id: to.id }`
 * with no `params`, or is omitted when `to` is the free template's
 * sentinel (`FREE_TEMPLATE_ID`) — "no template" is the field's absence,
 * never a reference to the free template's own id.
 */
export function changeTemplate(doc: CarouselDocument, from: LayoutTemplate, to: LayoutTemplate): CarouselDocument {
  const slides = doc.slides.map((slide) => ({
    ...slide,
    objects: remapObjects(slide.objects, from, slide.kind, to, slide.kind),
  }));

  const template: TemplateRef | undefined = to.id === FREE_TEMPLATE_ID ? undefined : { id: to.id };

  return {
    ...doc,
    template,
    slides,
    updatedAt: new Date().toISOString(),
  };
}
