import type { SlideObject } from "./carousel-document.js";

/**
 * Pure object rules the editor's web bundle imports at runtime.
 *
 * This module must stay importable from the browser: no value imports.
 * The resolver next door (`carousel-document-resolve.ts`) sits beside
 * Node-reaching modules (`layout-template.ts` imports `node:fs`, the
 * schemas import `zod`), and the moment it acquires a value import from
 * one of them (#36 does, for the free template's sentinel) anything in
 * `editor/web` that imports the resolver pulls Node into the bundle and
 * the app renders a blank page. The resolver re-exports this rule so
 * engine callers keep one import path; `pnpm check` builds the bundle
 * to catch a regression.
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
