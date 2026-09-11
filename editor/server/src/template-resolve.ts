import type { BrandTokens } from "../../../system/ig-carousel/brand-schema.js";
import type { CarouselDocument } from "../../../system/ig-carousel/carousel-document.js";
import { freeLayoutTemplate, loadLayoutTemplate, type LayoutTemplate } from "../../../system/ig-carousel/layout-template.js";

import type { ProfileStore } from "./profile-store.js";

/**
 * The one place a persisted document's optional `template` reference turns
 * into an actual `LayoutTemplate`. A document with no reference resolves to
 * the built-in free template (`freeLayoutTemplate()`), which touches no
 * disk and imposes no zones or slots — so every caller downstream (preview
 * HTML, PNG, contrast, export) keeps a single non-optional template to work
 * with and needs no "no template" branch of its own.
 *
 * Replaces C2a's placeholder `requireTemplateRef`, which threw for exactly
 * this case because the free render path did not exist yet.
 */
export function resolveDocumentTemplate(
  store: ProfileStore,
  brand: BrandTokens,
  doc: CarouselDocument,
): LayoutTemplate {
  if (!doc.template) return freeLayoutTemplate();
  return loadLayoutTemplate(store.roots.profileDir, doc.template.id, brand, doc.template.params);
}
