import { AlreadyExistsError, BrandArchivedError } from "@personal-brand/storage/contracts";

import { assertValidCarouselId } from "./document-store.js";
import { buildEmptyDocument } from "./compose/planner.js";
import { messages } from "./messages.js";
import { etagOf, storedBrandTokens, storedTemplate, validateStored, type StoredBrand } from "./stored-read.js";
import type { SaveOutcome } from "./stored-write.js";

interface CreateBody {
  title?: string;
  prompt?: string;
  templateId?: string | null;
  id?: string;
  blank?: boolean;
}

/**
 * `POST /carousels` for a stored brand: creates the carousel row (create-on-save, `expectedVersion: null`) with an empty
 * document, the one shape the editor's "Nuevo carrusel" sends (`blank`, or a template id). The prompt-driven plan/apply
 * flow needs the AI pipeline and is not served from storage yet: `?mode=plan`, `preview: true` and a `prompt` are all 501
 * (unlike the folder, a prompt is never silently ignored, because the caller expects a composed carousel). The answer carries the row's `ETag`, so the
 * client's first save has its `If-Match`.
 */
export async function createStoredCarousel(s: StoredBrand, body: CreateBody, preview: boolean): Promise<SaveOutcome> {
  if (preview || body.prompt !== undefined) return { status: 501, body: { error: messages.storedNotYet } };
  const blank = body.blank === true;
  if (blank && body.templateId !== undefined) return { status: 400, body: { error: `"blank" and "templateId" cannot be sent together` } };
  if (!body.title || !body.title.trim()) return { status: 400, body: { error: "title is required" } };
  const id = body.id ?? `carousel-${Date.now()}`;
  assertValidCarouselId(id);
  if ((await s.storage.brands.getBySlug(s.slug)).value.status === "archived") throw new BrandArchivedError(s.slug);

  const templateId = blank ? null : body.templateId === undefined ? "explicativo" : body.templateId;
  // Loading the template is the input validation: an unknown id is refused before anything is written.
  if (templateId !== null) await storedTemplate(s, templateId);
  const brand = await storedBrandTokens(s);
  const created = buildEmptyDocument(templateId ?? undefined, id, body.title, blank ? { blank: true, brand } : undefined);
  const result = await validateStored(s, created);
  if (!result.valid) return { status: 400, body: { error: "Invalid document", details: result.errors } };

  // The column owns `status` (new rows are drafts): the stored document never carries it.
  const { status: _status, ...document } = result.document;
  try {
    const row = await s.storage.carousels.create(s.brandId, { slug: id, title: result.document.title, document: { json: document, schemaVersion: 1 } }, { expectedVersion: null, author: "editor", source: "editor", reason: "save" });
    return { status: 201, etag: etagOf(row.version), body: { document: result.document } };
  } catch (error) {
    if (error instanceof AlreadyExistsError) return { status: 409, body: { error: messages.carouselExists(id) } };
    throw error;
  }
}
