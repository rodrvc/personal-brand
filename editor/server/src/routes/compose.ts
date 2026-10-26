import { BrandArchivedError, NotFoundError, VersionConflictError } from "@personal-brand/storage/contracts";
import { Router } from "express";

import { loadBrand, type BrandTokens } from "../../../../system/ig-carousel/brand-schema.js";
import { loadLayoutTemplate, LayoutTemplateError } from "../../../../system/ig-carousel/layout-template.js";
import type { CarouselDocument, SlideObject } from "../../../../system/ig-carousel/carousel-document.js";
import { loadBrandStyle } from "../../../../system/ig-carousel/brand-style.js";

import {
  applyCompositionPlan,
  assignTextColorKeys,
  buildCompositionPlan,
  buildEmptyDocument,
  draftCopyBrandContext,
  folderPlannerSource,
  generateForSlot,
  generateImageBrandContext,
  suggestionForSlot,
  type CompositionPlan,
  type PlannerSource,
} from "../compose/planner.js";
import {
  assertValidCarouselId,
  documentExists,
  DocumentStoreError,
  readCarouselHeader,
  readValidatedDocument,
  readValidatedDocumentRevision,
  snapshotDocument,
  writeDocumentThroughRevision,
} from "../document-store.js";
import { GenerationUnavailableError, type PieceGenerator } from "../ai/piece-generator.js";
import { estimateImageCostCents, IMAGE_MODEL } from "../ai/pricing.js";
import { ProfileStore, ProfileStoreError } from "../profile-store.js";
import { handleStoreError } from "./store-errors.js";
import { createStoredCarousel } from "../stored-create.js";
import { messages } from "../messages.js";
import { persistStoredDocument, storedPlannerSource, type StoredToken } from "../stored-compose.js";
import { guardStorage, isStoredError, resolveStored, storedBrandTokens, storedCarousel, storedCarouselRaw, storedStyle, storedTemplate, type EditorStorage, type StoredBrand } from "../stored-read.js";
import type { SaveOutcome } from "../stored-write.js";

/**
 * Pending plans held in memory between a *preview* POST `/carousels`
 * (`?mode=plan`) and POST `/carousels/:id/plan/apply` (execute it) —
 * per-process state is fine here since the editor is single-user/local-first
 * (design.md D13); nothing about a pending, unexecuted plan needs to survive
 * a restart. This map (and `plan/apply` below) is API/script-only now: the
 * web UI always calls plain `POST /carousels`, which builds and returns a
 * real document immediately — see that handler's own comment.
 */
const pendingPlans = new Map<string, CompositionPlan>();

/** `storage` serves a brand cut over to storage, which so far can only create a blank carousel (S10b3); the rest stays on the folder. */
export function composeRouter(getGenerator: (slug: string) => PieceGenerator, storage?: EditorStorage): Router {
  const router = Router();

  /**
   * Not profile-scoped: the per-image cost estimate is the same flat number
   * regardless of brand (pricing.ts's `estimateImageCostCents` takes no
   * per-call inputs). Lets the UI show "~0,4¢" next to every "Generar
   * imagen…" field before the user commits to spending it (owner decision:
   * image generation is never automatic, so the user always sees the cost
   * up front).
   */
  router.get("/api/ai/pricing", (_req, res) => {
    res.json({ imageModel: IMAGE_MODEL, estimatedImageCostCents: estimateImageCostCents() });
  });

  /**
   * Creates a new carousel. This handler is INERT — it returns a document
   * with no AI provider call, no library lookup, no cost, and no job id.
   *
   * `?mode=plan` (or `{ preview: true }` in the body) is kept for
   * API/script callers that still want the OLD prompt-driven
   * plan/apply flow — building a plan from a prompt and applying it in a
   * second step. Nothing in editor/web calls either path; the web UI only
   * ever sends `{ title, blank: true }`.
   */
  router.post("/api/profiles/:slug/carousels", async (req, res) => {
    try {
      const found = await resolveStored(storage && guardStorage(storage), req.params.slug);
      if (found) {
        const outcome = req.query.mode === "plan" || req.body?.preview === true ? await previewStoredPlan(found, req.body ?? {}) : await createStoredCarousel(found, req.body ?? {});
        if (outcome.etag) res.setHeader("ETag", outcome.etag);
        res.status(outcome.status).json(outcome.body);
        return;
      }
      const store = new ProfileStore(req.params.slug);
      const body = req.body as {
        title?: string;
        prompt?: string;
        /** `null` means "no template": the document is created with no `template` key and renders free (carousel-document spec). Omitting the field keeps the historical default instead. Not allowed together with `blank` (400) — see below. */
        templateId?: string | null;
        id?: string;
        assetIds?: string[];
        /** API-client-only override — the web UI never sends this; slide count comes from the prompt or the template default instead (see planner.ts's `resolveStepCount`). */
        slideCount?: number;
        preview?: boolean;
        /**
         * The editor's own "Nuevo carrusel" entry point (owner feedback: a
         * brand-new carousel must not open already stamped with
         * `explicativo`'s footer/pagination on every slide). Forces the
         * free template (every zone inert, no footer — same one
         * `EditorRoute` already falls back to for a template-less
         * document) and seeds one blank slide. Sending `templateId` as
         * well is a 400, not a silent override. Omitted (or `false`)
         * keeps the historical default for any other caller.
         */
        blank?: boolean;
      };
      const blank = body.blank === true;
      if (blank && body.templateId !== undefined) {
        res.status(400).json({ error: `"blank" and "templateId" cannot be sent together` });
        return;
      }
      // `undefined` (field absent) -> the historical default; explicit
      // `null` -> no template at all. `??` cannot tell those apart, so the
      // check is on `undefined` specifically. `blank` means no template.
      const templateId = blank ? null : body.templateId === undefined ? "explicativo" : body.templateId;
      const carouselId = body.id ?? `carousel-${Date.now()}`;
      assertValidCarouselId(carouselId);
      if (documentExists(store, carouselId)) {
        res.status(409).json({ error: `Carousel "${carouselId}" already exists` });
        return;
      }

      const isPreview = req.query.mode === "plan" || body.preview === true;
      if (isPreview) {
        if (!body.prompt || typeof body.prompt !== "string") {
          res.status(400).json({ error: `"prompt" is required for a plan preview` });
          return;
        }
        // The plan/apply flow composes INTO named slots, so it has nothing
        // to plan against without a real template — 400 rather than
        // silently planning over the free template's empty slot lists.
        if (templateId === null) {
          res.status(400).json({ error: `"templateId" cannot be null for a plan preview — planning needs a template's slots` });
          return;
        }
        const template = loadLayoutTemplate(store.roots.profileDir, templateId, loadBrand(store.roots.profileDir));
        const plan = await buildCompositionPlan(folderPlannerSource(store), body.prompt, template, body.slideCount, body.assetIds);
        pendingPlans.set(`${req.params.slug}/${carouselId}`, plan);
        res.status(201).json(planPreviewBody(carouselId, templateId, plan));
        return;
      }

      if (typeof body.title !== "string" || !body.title.trim()) {
        res.status(400).json({ error: "title is required" });
        return;
      }

      // These two loads are the input validation: they reject a broken
      // `brand.json` or an unknown template id, so the result is discarded.
      const brand = loadBrand(store.roots.profileDir);
      if (templateId !== null) void loadLayoutTemplate(store.roots.profileDir, templateId, brand);
      const document = buildEmptyDocument(
        templateId ?? undefined,
        carouselId,
        body.title,
        blank ? { blank: true, brand } : undefined,
      );
      await writeDocumentThroughRevision(store, document, { create: true });

      res.status(201).json({ document });
    } catch (error) {
      handlePlanError(error, res);
    }
  });

  router.post("/api/profiles/:slug/carousels/:id/plan/apply", async (req, res) => {
    try {
      const found = await resolveStored(storage && guardStorage(storage), req.params.slug);
      const store = found ? undefined : new ProfileStore(req.params.slug);
      const key = `${req.params.slug}/${req.params.id}`;
      const plan = pendingPlans.get(key);
      if (!plan) {
        res.status(404).json({ error: `No pending plan for carousel "${req.params.id}" — create one via POST /carousels first.` });
        return;
      }
      // Same rule as the plan preview above: applying a plan fills named
      // slots, so "no template" is not a thing this path can do.
      const requestedTemplateId = (req.body as { templateId?: string | null })?.templateId;
      if (requestedTemplateId === null) {
        res.status(400).json({ error: `"templateId" cannot be null when applying a plan — planning needs a template's slots` });
        return;
      }
      const templateId = requestedTemplateId ?? "explicativo";
      const generator = getGenerator(req.params.slug);
      let outcome: PlanOutcome;
      if (found) {
        if ((await found.storage.brands.getBySlug(found.slug)).value.status === "archived") throw new BrandArchivedError(found.slug);
        outcome = await runPlanApply<StoredToken>({
          source: storedPlannerSource(found), brand: await storedBrandTokens(found), template: await storedTemplate(found, templateId), templateId, plan, carouselId: req.params.id, generator,
          persist: (doc, prev) => persistStoredDocument(found, doc, prev),
        });
      } else {
        const brand = loadBrand(store!.roots.profileDir);
        outcome = await runPlanApply<string>({
          source: folderPlannerSource(store!), brand, template: loadLayoutTemplate(store!.roots.profileDir, templateId, brand), templateId, plan, carouselId: req.params.id, generator,
          persist: (doc, prev) => writeDocumentThroughRevision(store!, doc, prev === undefined ? {} : { expectedRevision: prev }),
        });
      }
      if (outcome.status === 201) pendingPlans.delete(key);
      res.status(outcome.status).json(outcome.body);
    } catch (error) {
      handlePlanError(error, res);
    }
  });

  /**
   * Regenerates one piece (an object, or a slide's background) or every
   * unpinned piece on a slide — never a pinned piece, never another slide
   * (piece-generation spec's "Regeneration per piece"). A version snapshot
   * is written first (specs/carousel-document's "before any operation that
   * replaces several pieces at once").
   */
  router.post("/api/profiles/:slug/carousels/:id/regenerate", async (req, res) => {
    try {
      const found = await resolveStored(storage && guardStorage(storage), req.params.slug);
      if (found) {
        // Only the "Ver prompt final" preview is served from storage (it calls no model and writes nothing); the generating regenerate (a candidate asset plus a save at the version read) is S10b6.
        const body = (req.body ?? {}) as { target?: { slideId?: string; objectId?: string }; prompt?: unknown; preview?: boolean };
        if (body.prompt !== undefined && typeof body.prompt !== "string") return void res.status(400).json({ error: `"prompt" must be a string` });
        if (req.query.dryRun !== "true" && body.preview !== true) return void res.status(501).json({ error: messages.storedNotYet });
        const { result } = await storedCarousel(found, req.params.id);
        if (!result.valid) return void res.status(400).json({ error: "Invalid document", details: result.errors });
        const { slideId, objectId } = body.target ?? {};
        if (typeof slideId !== "string" || !slideId) return void res.status(400).json({ error: `"target.slideId" is required` });
        const slide = result.document.slides.find((s) => s.id === slideId);
        if (!slide) return void res.status(404).json({ error: `No slide "${slideId}"` });
        if (typeof objectId !== "string" || !objectId) return void res.status(400).json({ error: `Preview is only meaningful for an image target (objectId).` });
        res.json({ prompt: finalImagePrompt(result.document, slide, objectId, body.prompt, await storedStyle(found)) });
        return;
      }
      const store = new ProfileStore(req.params.slug);
      // Carries this read's revision into the final write below, instead of
      // that write re-reading "current" — the regeneration call in between
      // is an AI provider round-trip that can take a while.
      const { document: doc, revision } = await readValidatedDocumentRevision(store, req.params.id);
      const body = req.body as {
        target?: { slideId: string; objectId?: string; scope?: "unpinned" };
        /** Overrides the planner's `suggestion` for this one piece — the text the user edited into the "Generar imagen…"/"Regenerar" field. Only meaningful for a single-piece image target; ignored for text objects and for `scope: "unpinned"`. */
        prompt?: string;
        /** When true, composes and returns the prompt the provider would actually receive (planner suggestion, or the user's override, plus brand style) without calling the AI or writing anything — the "Ver prompt final" preview. */
        preview?: boolean;
      };
      const target = body?.target;
      if (!target?.slideId) {
        res.status(400).json({ error: `"target.slideId" is required` });
        return;
      }

      const slideIndex = doc.slides.findIndex((s) => s.id === target.slideId);
      if (slideIndex === -1) {
        res.status(404).json({ error: `No slide "${target.slideId}"` });
        return;
      }

      const isDryRun = req.query.dryRun === "true" || body.preview === true;
      if (isDryRun) {
        if (target.objectId) {
          res.json({ prompt: finalImagePrompt(doc, doc.slides[slideIndex]!, target.objectId, body.prompt, loadBrandStyle(store.roots.profileDir)) });
          return;
        }
        res.status(400).json({ error: `Preview is only meaningful for an image target (objectId).` });
        return;
      }

      snapshotDocument(store, req.params.id);

      const generator = getGenerator(req.params.slug);
      const brand = loadBrand(store.roots.profileDir);
      const source = folderPlannerSource(store);
      let nextDoc = doc;
      let costCents = 0;

      if (target.objectId === "background") {
        const result = await regenerateBackground(source, generator, nextDoc, slideIndex, req.params.id, brand, body.prompt);
        nextDoc = result.document;
        costCents = result.costCents;
      } else if (target.objectId) {
        const result = await regenerateObject(source, generator, nextDoc, slideIndex, target.objectId, req.params.id, brand, body.prompt);
        nextDoc = result.document;
        costCents = result.costCents;
      } else if (target.scope === "unpinned") {
        nextDoc = await regenerateUnpinned(source, generator, nextDoc, slideIndex, req.params.id, brand);
      } else {
        res.status(400).json({ error: `"target" must name an objectId or set scope: "unpinned"` });
        return;
      }

      await writeDocumentThroughRevision(store, nextDoc, { expectedRevision: revision });
      res.json({ document: nextDoc, costCents });
    } catch (error) {
      handlePlanError(error, res);
    }
  });

  router.get("/api/profiles/:slug/carousels/:id/stats", async (req, res) => {
    try {
      const found = await resolveStored(storage && guardStorage(storage), req.params.slug);
      if (found) {
        const { result } = await storedCarousel(found, req.params.id);
        if (!result.valid) return void res.status(400).json({ error: "Invalid document", details: result.errors });
        res.json({ carouselId: req.params.id, libraryRatio: libraryRatio(result.document), history: await storedLibraryHistory(found, req.params.id) });
        return;
      }
      const store = new ProfileStore(req.params.slug);
      const doc = readValidatedDocument(store, req.params.id);
      const ratio = libraryRatio(doc);
      const history = previousCarouselsLibraryRatio(store, req.params.id);
      res.json({ carouselId: req.params.id, libraryRatio: ratio, history });
    } catch (error) {
      handlePlanError(error, res);
    }
  });

  return router;
}

/** True when the slide's background (slot `"background"`) or an asset object at `slot` already carries an `assetId` — i.e. a previous, partially-failed `plan/apply` run already generated and persisted this slot. */
function isSlotGenerated(doc: CarouselDocument, slideIndex: number, slot: string): boolean {
  const slide = doc.slides[slideIndex];
  if (!slide) return false;
  if (slot === "background") {
    return slide.background.mode === "asset";
  }
  return slide.objects.some((o) => o.slot === slot && o.kind === "asset" && Boolean(o.assetId));
}

export function attachGeneratedAsset(
  brand: BrandTokens,
  doc: CarouselDocument,
  slideIndex: number,
  slot: string,
  assetId: string,
): CarouselDocument {
  const slides = doc.slides.map((slide, index) => {
    if (index !== slideIndex) return slide;
    if (slot === "background") {
      const next = { ...slide, background: { mode: "asset" as const, assetId, pinned: false, source: "ai" as const } };
      // The background wasn't known when `applyCompositionPlan` first ran
      // `assignTextColorKeys` on this slide (a `generate`-sourced background
      // is filled in here, one step later) — re-run it now so text objects
      // still missing a colorKey pick their contrast against the real
      // generated background instead of the generic surface fallback.
      return assignTextColorKeys(brand, next);
    }
    const objects = slide.objects.map((object) =>
      object.slot === slot && object.kind === "asset" ? { ...object, assetId, source: "ai" as const } : object,
    );
    const hasSlotObject = objects.some((o) => o.slot === slot);
    if (!hasSlotObject) {
      objects.push({
        id: `obj-${slide.id}-${slot}`,
        kind: "asset",
        slot,
        pinned: false,
        locked: false,
        source: "ai",
        assetId,
        fit: "cover",
      });
    }
    return { ...slide, objects };
  });
  return { ...doc, slides, updatedAt: new Date().toISOString() };
}

/** The document plus the cost (if any) the regeneration call just spent — surfaced to the client so the UI can show what it actually paid, not just the estimate it showed before the click. */
interface RegenerateResult {
  document: CarouselDocument;
  costCents: number;
}

async function regenerateBackground(
  source: PlannerSource,
  generator: PieceGenerator,
  doc: CarouselDocument,
  slideIndex: number,
  carouselId: string,
  brand: BrandTokens,
  /** Overrides the planner's own `suggestionForSlot` idea — the text the user typed into the "Generar imagen…" field, per the owner's decision that every generation is an explicit, editable-prompt request. */
  promptOverride?: string,
): Promise<RegenerateResult> {
  const slide = doc.slides[slideIndex]!;
  if (slide.background.pinned) {
    throw new RegenerateBlockedError(`Slide "${slide.id}"'s background is pinned — regenerate refused.`);
  }
  const prompt =
    promptOverride?.trim() ||
    suggestionForSlot(doc.prompt.text, `background for ${slide.kind}`, await source.style(), doc.title);
  const entry = await generateForSlot(source, generator, {
    prompt,
    kind: "background",
    canvas: doc.canvas,
    carouselId,
    slot: "background",
  });
  const costCents = await source.costCents(entry.id);
  const slides = doc.slides.map((s, i) => {
    if (i !== slideIndex) return s;
    const withNewBackground = {
      ...s,
      background: { mode: "asset" as const, assetId: entry.id, pinned: false, source: "ai" as const },
    };
    // Same reasoning as `attachGeneratedAsset`: any text object still
    // missing an explicit colorKey should pick its contrast against this
    // new background rather than being left on whatever the old
    // background's assignment was.
    return assignTextColorKeys(brand, withNewBackground);
  });
  return { document: { ...doc, slides, updatedAt: new Date().toISOString() }, costCents };
}

async function regenerateObject(
  source: PlannerSource,
  generator: PieceGenerator,
  doc: CarouselDocument,
  slideIndex: number,
  objectId: string,
  carouselId: string,
  brand: BrandTokens,
  promptOverride?: string,
): Promise<RegenerateResult> {
  const slide = doc.slides[slideIndex]!;
  const object = slide.objects.find((o) => o.id === objectId);
  if (!object) {
    throw new RegenerateBlockedError(`No object "${objectId}" on slide "${slide.id}"`);
  }
  if (object.pinned) {
    throw new RegenerateBlockedError(`Object "${objectId}" is pinned — regenerate refused.`);
  }

  if (object.kind === "text") {
    const draft = await generator.draftCopy({
      carouselPrompt: doc.prompt.text,
      slides: [{ slideId: slide.id, kind: slide.kind, brief: doc.prompt.text, limits: { headline: 200 } }],
      brand: draftCopyBrandContext(await source.style(), await source.language()),
    });
    const newText = draft.slides[0]?.headline ?? object.text;
    const slides = doc.slides.map((s, i) => {
      if (i !== slideIndex) return s;
      const withNewText = {
        ...s,
        objects: s.objects.map((o) => (o.id === objectId ? { ...o, text: newText, source: "ai" as const } : o)),
      };
      // Fills a colorKey only if this text object (or another on the slide)
      // still has none — a regenerated headline keeps its own existing
      // colorKey untouched (piece-generation's color rule only assigns
      // when there is no explicit one yet).
      return assignTextColorKeys(brand, withNewText);
    });
    return { document: { ...doc, slides, updatedAt: new Date().toISOString() }, costCents: draft.costCents };
  }

  const prompt =
    promptOverride?.trim() ||
    suggestionForSlot(doc.prompt.text, object.slot ?? objectId, await source.style(), doc.title);
  const entry = await generateForSlot(source, generator, {
    prompt,
    kind: "photo",
    canvas: doc.canvas,
    carouselId,
    slot: object.slot ?? objectId,
  });
  const costCents = await source.costCents(entry.id);
  const slides = doc.slides.map((s, i) =>
    i === slideIndex
      ? {
          ...s,
          objects: s.objects.map((o) =>
            o.id === objectId && o.kind === "asset"
              ? { ...o, assetId: entry.id, source: "ai" as const, awaitingImage: false, suggestion: undefined }
              : o,
          ),
        }
      : s,
  );
  return { document: { ...doc, slides, updatedAt: new Date().toISOString() }, costCents };
}

/**
 * Owner decision: image generation is NEVER automatic, so "Regenerar lo no
 * fijado" — a bulk, no-per-piece-prompt action — only redrafts unpinned
 * TEXT objects. An unpinned background or asset object with no image
 * (`awaitingImage`) stays exactly as it is; the user regenerates each of
 * those individually via the per-piece "Generar imagen…" field, which is
 * the only place a prompt (and its cost) is ever confirmed.
 */
async function regenerateUnpinned(
  source: PlannerSource,
  generator: PieceGenerator,
  doc: CarouselDocument,
  slideIndex: number,
  carouselId: string,
  brand: BrandTokens,
): Promise<CarouselDocument> {
  let next = doc;
  const slide = next.slides[slideIndex]!;
  for (const object of slide.objects) {
    if (object.pinned || object.kind !== "text") continue;
    next = (await regenerateObject(source, generator, next, slideIndex, object.id, carouselId, brand)).document;
  }
  return next;
}

function isVisualObject(object: SlideObject): object is Extract<SlideObject, { kind: "asset" }> {
  return object.kind === "asset";
}

/** Percentage of the carousel's visual pieces (backgrounds + asset objects) whose `source` is `"library"` (piece-generation spec's "Library ratio with history"). */
export function libraryRatio(doc: CarouselDocument): number {
  const visualPieces = doc.slides.flatMap((s) => [s.background, ...s.objects.filter(isVisualObject)]);
  if (visualPieces.length === 0) return 0;
  const fromLibrary = visualPieces.filter((p) => p.source === "library").length;
  return Math.round((fromLibrary / visualPieces.length) * 100);
}

/**
 * `libraryRatio`, but over an unvalidated raw document — same idea as
 * `listCarousels` in document-store.ts: this stat only ever reads each
 * piece's `source` field, so there's no reason to pay for
 * `readValidatedDocument`'s brand reload + full asset-index rescan on
 * every one of the profile's other carousels just to compute it. Counts
 * the same visual pieces `libraryRatio` does (every background, plus only
 * `kind: "asset"` objects — text never counts). A document that doesn't
 * shape-check the way this expects contributes 0 rather than throwing.
 */
export function libraryRatioRaw(raw: unknown): number {
  const slides = (raw as { slides?: unknown })?.slides;
  if (!Array.isArray(slides)) return 0;
  const sources: unknown[] = [];
  for (const slide of slides) {
    const s = slide as { background?: { source?: unknown }; objects?: unknown };
    if (s?.background && "source" in s.background) sources.push(s.background.source);
    if (Array.isArray(s?.objects)) {
      for (const object of s.objects) {
        const o = object as { kind?: unknown; source?: unknown } | null;
        if (o?.kind === "asset") sources.push(o.source);
      }
    }
  }
  if (sources.length === 0) return 0;
  const fromLibrary = sources.filter((s) => s === "library").length;
  return Math.round((fromLibrary / sources.length) * 100);
}

/** Every carousel of the same profile, excluding the current one, most recently updated first — used for the reuse-trend comparison (piece-generation spec's "Library ratio with history"). */
function previousCarouselsLibraryRatio(
  store: ProfileStore,
  currentCarouselId: string,
): Array<{ carouselId: string; updatedAt: string; libraryRatio: number }> {
  const out: Array<{ carouselId: string; updatedAt: string; libraryRatio: number }> = [];
  for (const entry of store.list("carousels")) {
    if (!entry.isDirectory() || entry.name === currentCarouselId) continue;
    // Same raw reader and skip rules as the carousel listing, so the
    // history covers exactly the carousels the listing shows.
    const header = readCarouselHeader(store, entry.name);
    if (!header) continue;
    out.push({ carouselId: header.id, updatedAt: header.updatedAt, libraryRatio: libraryRatioRaw(header) });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The prompt the provider would receive for one image piece: the planner's suggestion (or the user's override) plus the brand's image direction. Shared by the folder and stored previews. */
function finalImagePrompt(doc: CarouselDocument, slide: CarouselDocument["slides"][number], objectId: string, override: string | undefined, style: NonNullable<Parameters<typeof suggestionForSlot>[2]>): string {
  const slotName = objectId === "background" ? `background for ${slide.kind}` : slide.objects.find((o) => o.id === objectId)?.slot ?? objectId;
  const brand = generateImageBrandContext(style);
  return [
    override?.trim() || suggestionForSlot(doc.prompt.text, slotName, style, doc.title),
    brand.imageDirection,
    brand.styleKeywords.length > 0 ? `Style: ${brand.styleKeywords.join(", ")}.` : undefined,
    brand.paletteWords ? `Use ${brand.paletteWords}.` : undefined,
    brand.logoRules,
  ].filter(Boolean).join("\n\n");
}

/** `previousCarouselsLibraryRatio` for a stored brand: the other carousels' ratio from their raw documents, newest first (one that vanished meanwhile is skipped). */
async function storedLibraryHistory(s: StoredBrand, currentCarouselId: string): Promise<Array<{ carouselId: string; updatedAt: string; libraryRatio: number }>> {
  const out: Array<{ carouselId: string; updatedAt: string; libraryRatio: number }> = [];
  for (const head of await s.storage.carousels.list(s.brandId)) {
    if (head.value.slug === currentCarouselId) continue;
    try {
      const { document, updatedAt } = await storedCarouselRaw(s, head.value.slug);
      out.push({ carouselId: head.value.slug, updatedAt: typeof document.updatedAt === "string" ? document.updatedAt : updatedAt, libraryRatio: libraryRatioRaw(document) });
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** The body of a plan preview, whichever kind of brand built the plan. */
function planPreviewBody(carouselId: string, templateId: string, plan: CompositionPlan) {
  return {
    carouselId,
    templateId,
    plan,
    estimatedCostCents: plan.visualSlots.filter((v) => v.source === "generate").reduce((sum, v) => sum + (v.estimatedCostCents ?? 0), 0),
    libraryPieces: plan.visualSlots.filter((v) => v.source === "library").length,
    generatedPieces: plan.visualSlots.filter((v) => v.source === "generate").length,
  };
}

/** `POST /carousels?mode=plan` for a stored brand: the same checks and answer as the folder's, over the stored library and templates. Writes nothing; the plan waits in memory for `plan/apply`. */
async function previewStoredPlan(s: StoredBrand, body: Record<string, unknown>): Promise<SaveOutcome> {
  const bad = (error: string): SaveOutcome => ({ status: 400, body: { error } });
  if (body.id !== undefined && typeof body.id !== "string") return bad(`"id" must be a string`);
  const carouselId = (body.id as string | undefined) ?? `carousel-${Date.now()}`;
  assertValidCarouselId(carouselId);
  const exists = await s.storage.carousels.get(s.brandId, carouselId, (b) => b).then(() => true, (error: unknown) => { if (error instanceof NotFoundError) return false; throw error; });
  if (exists) return { status: 409, body: { error: messages.carouselExists(carouselId) } };
  if (typeof body.prompt !== "string" || !body.prompt) return bad(`"prompt" is required for a plan preview`);
  if (body.blank === true && body.templateId !== undefined) return bad(`"blank" and "templateId" cannot be sent together`);
  const templateId = body.blank === true ? null : body.templateId === undefined ? "explicativo" : body.templateId;
  if (templateId === null) return bad(`"templateId" cannot be null for a plan preview — planning needs a template's slots`);
  if (typeof templateId !== "string") return bad(`"templateId" must be a string or null`);
  if (body.assetIds !== undefined && !(Array.isArray(body.assetIds) && body.assetIds.every((id) => typeof id === "string"))) return bad(`"assetIds" must be a list of strings`);
  const template = await storedTemplate(s, templateId);
  const plan = await buildCompositionPlan(storedPlannerSource(s), body.prompt, template, typeof body.slideCount === "number" ? body.slideCount : undefined, body.assetIds as string[] | undefined);
  pendingPlans.set(`${s.slug}/${carouselId}`, plan);
  return { status: 201, body: planPreviewBody(carouselId, templateId, plan) };
}

type PlanOutcome = { status: 201 | 202; body: unknown };

/**
 * Executes a pending plan and persists it, for either kind of brand. `persist` writes a document and returns the token
 * (folder: revision; stored: row version) the next write must carry. It runs after the copy and library visuals, then
 * after every generated slot (an image cannot be un-paid, so a throw must not orphan the slots done), each time with the
 * previous token instead of a re-read, so a write that landed during generation is a conflict, not swallowed. A provider
 * failure or conflict is a 202 with the partial document and the plan stays pending. A retry (S10b6 limitation) persists
 * without a token, overwriting saves made since, and regenerates every slot.
 */
async function runPlanApply<T>(p: {
  source: PlannerSource;
  brand: BrandTokens;
  template: Parameters<typeof applyCompositionPlan>[2];
  templateId: string;
  plan: CompositionPlan;
  carouselId: string;
  generator: PieceGenerator;
  persist: (doc: CarouselDocument, prev?: T) => Promise<T>;
}): Promise<PlanOutcome> {
  let document = await applyCompositionPlan(p.source, p.brand, p.template, p.templateId, p.plan, p.carouselId, p.generator);
  let token = await p.persist(document);
  try {
    for (const visual of p.plan.visualSlots) {
      if (visual.source !== "generate") continue;
      if (isSlotGenerated(document, visual.slideIndex, visual.slot)) continue;
      const entry = await generateForSlot(p.source, p.generator, { prompt: `${p.plan.promptText} — ${visual.slot}`, kind: visual.kind, canvas: { w: 1080, h: 1350 }, carouselId: p.carouselId, slot: visual.slot });
      document = attachGeneratedAsset(p.brand, document, visual.slideIndex, visual.slot, entry.id);
      token = await p.persist(document, token);
    }
  } catch (error) {
    // Only provider failures and version conflicts are partial results; a storage outage or an archived brand is the route's error.
    if (isStoredError(error) && !(error instanceof VersionConflictError)) throw error;
    return { status: 202, body: { error: (error as Error).message, partial: true, document } };
  }
  return { status: 201, body: document };
}

class RegenerateBlockedError extends Error {}

/**
 * `RevisionConflictError` (thrown when a `writeDocumentThroughRevision`
 * call's carried revision no longer matches — routes/compose.ts) is a
 * `ProfileStoreError`, so it falls into the first branch below and surfaces
 * as 400: a stale base here means retry the whole operation (re-plan, or
 * re-request the regeneration) rather than silently overwriting, since
 * `plan/apply`'s per-slot loop and `/regenerate` don't have a client-visible
 * "reload and diff" flow the way the editor PUT route's 409 does.
 */
function handlePlanError(error: unknown, res: import("express").Response): void {
  // Storage errors (a stored brand's create) share the profile routes' mapping: 404, 403, 400, 503.
  if (isStoredError(error)) return handleStoreError(error, res);
  if (
    error instanceof ProfileStoreError ||
    error instanceof DocumentStoreError ||
    error instanceof LayoutTemplateError ||
    error instanceof RegenerateBlockedError
  ) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof GenerationUnavailableError) {
    res.status(503).json({ error: error.message });
    return;
  }
  res.status(500).json({ error: (error as Error).message });
}
