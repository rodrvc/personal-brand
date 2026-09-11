import type { SlideObject } from "./carousel-document.js";

/**
 * Pure object rules the editor's web bundle may import at runtime.
 *
 * This module must stay free of value imports: the browser bundle reaches
 * it through `editor/web/src/editor/mutations.ts`, and anything it pulls in
 * (`node:fs` via layout-template, `zod` via the schemas) would break the
 * app at load with no visible error. `carousel-document-resolve.ts`
 * re-exports it so engine callers keep one import path.
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
