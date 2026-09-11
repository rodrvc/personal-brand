import type { CarouselDocument, Slide, SlideKind, SlideObject, TemplateRef } from "./carousel-document.js";
import type { LayoutSlot, LayoutTemplate } from "./layout-template.js";

/**
 * Pure object rules the editor's web bundle imports at runtime.
 *
 * This module must stay importable from the browser: no value imports.
 * The resolver next door (`carousel-document-resolve.ts`) sits beside
 * Node-reaching modules (`layout-template.ts` imports `node:fs`, the
 * schemas import `zod`), and the moment it acquires a value import from
 * one of them (#36 does, for the free template's sentinel) anything in
 * `editor/web` that imports the resolver pulls Node into the bundle and
 * the app renders a blank page. The resolver re-exports these rules so
 * engine callers keep one import path; `pnpm check` builds the bundle
 * to catch a regression.
 *
 * It holds every pure rule about objects and slots — the reset-to-slot
 * rule, the slot remap shared by `changeSlideKind`/`changeTemplate`, and
 * `FREE_TEMPLATE_ID` — because the properties panel's template swap needs
 * all three in the browser.
 */
/**
 * "Reset to template": drops `geometry` and, for a text object, its
 * typographic overrides (`fontKey`/`fontSize`/`lineHeight`/`align`) too —
 * dropping only `geometry` left a font-size reset a no-op. `colorKey` stays
 * out: it's a document-level `brand.colors` pin, not slot-defined (a slot
 * only names a `colorRole`), and the editor exposes it separately. Throws
 * if the object has no `slot` — a caller error.
 */
export function resetObjectToSlot<T extends SlideObject>(object: T): T {
  if (!object.slot) {
    throw new Error(`Object "${object.id}" has no slot — nothing to reset it to.`);
  }
  if (object.kind === "text") {
    const { geometry: _geometry, fontKey: _fontKey, fontSize: _fontSize, lineHeight: _lineHeight, align: _align, ...rest } = object;
    return rest as T;
  }
  const { geometry: _geometry, ...rest } = object;
  return rest as T;
}

/**
 * Sentinel id for "no template". Never a file on disk — `loadLayoutTemplate`
 * never receives it and `listLayoutTemplates` never returns it — so a
 * caller can use it as an explicit "free" choice in a picker without it
 * colliding with a real template id (`idsFromJsonDir` only ever returns ids
 * backed by an actual `.json` file).
 *
 * Lives here rather than in `layout-template.ts` (which re-exports it) only
 * because that module imports `node:fs`: the web bundle needs the constant
 * and must not pull Node in to get it.
 */
export const FREE_TEMPLATE_ID = "__free__";

/**
 * "free-layout" -> "Free layout"; the id's only real content is its slug,
 * so this is a mechanical humanization, not a translation. Templates carry
 * no display name of their own (no brand copy under `system/`), so this is
 * the one place a template id becomes something to show a user — shared
 * with the editor's web bundle so a picker and a properties panel cannot
 * name the same template two different ways.
 */
export function humanizeId(id: string): string {
  const spaced = id.replace(/[-_]+/g, " ").trim();
  return spaced.length > 0 ? spaced[0]!.toUpperCase() + spaced.slice(1) : id;
}

/** The slot a kind declares under `name`, or `undefined` — the single lookup both the resolver and the remap rule ask, so "does this slot exist here?" cannot be answered two different ways. */
export function findSlot(template: LayoutTemplate, kind: SlideKind, name: string): LayoutSlot | undefined {
  return template.slides[kind]?.slots.find((slot) => slot.name === name);
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
