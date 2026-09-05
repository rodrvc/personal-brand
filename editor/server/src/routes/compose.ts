import { Router } from "express";

import { loadBrand, type BrandTokens } from "../../../../system/ig-carousel/brand-schema.js";
import { loadLayoutTemplate, LayoutTemplateError } from "../../../../system/ig-carousel/layout-template.js";
import type { CarouselDocument, SlideObject } from "../../../../system/ig-carousel/carousel-document.js";
import { loadIndex, type AssetEntry } from "../../../../system/assets/index.js";

import {
  applyCompositionPlan,
  assignTextColorKeys,
  buildCompositionPlan,
  buildImmediateDocument,
  generateForSlot,
} from "../compose/planner.js";
import { enqueueComposeJob, getComposeJob } from "../compose/compose-job.js";
import {
  assertValidCarouselId,
  documentExists,
  DocumentStoreError,
  readValidatedDocument,
  snapshotDocument,
  writeDocument,
} from "../document-store.js";
import { GenerationUnavailableError, type PieceGenerator } from "../ai/piece-generator.js";
import { ProfileStore, ProfileStoreError } from "../profile-store.js";

/**
 * Pending plans held in memory between a *preview* POST `/carousels`
 * (`?mode=plan`) and POST `/carousels/:id/plan/apply` (execute it) —
 * per-process state is fine here since the editor is single-user/local-first
 * (design.md D13); nothing about a pending, unexecuted plan needs to survive
 * a restart. This map (and `plan/apply` below) is API/script-only now: the
 * web UI always calls plain `POST /carousels`, which builds and returns a
 * real document immediately — see that handler's own comment.
 */
const pendingPlans = new Map<string, ReturnType<typeof buildCompositionPlan>>();

export function composeRouter(getGenerator: (slug: string) => PieceGenerator): Router {
  const router = Router();

  /**
   * Creates a new carousel from a prompt.
   *
   * Default behavior (what the web UI always calls): IMMEDIATE BUILD, no
   * approval step (editor-ui spec's "Composition from the prompt", design.md
   * D6/D7's updated description) — every library-sourced piece is placed
   * synchronously and every piece that needs AI becomes a `pending: true`
   * placeholder; the resulting document is written to disk and returned
   * together with a `jobId` for a background compose job that fills the
   * placeholders in (`GET .../compose/:jobId` polls its status). This
   * synchronous part never calls the AI provider, so it's fast with or
   * without an API key configured.
   *
   * `?mode=plan` (or `{ preview: true }` in the body) reproduces the OLD
   * two-phase behavior byte-for-byte: builds a plan and returns it without
   * writing any document, for a caller that wants to preview cost/origin
   * before anything is created. Chosen name: a query param (`mode=plan`)
   * reads cleanly against the default's implicit "mode=build", and keeps
   * the body shape identical between both modes (no extra field to filter
   * out of `body` before it's used). This mode, and `plan/apply` below, are
   * kept for API/script use only — nothing in editor/web calls either.
   */
  router.post("/api/profiles/:slug/carousels", (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      const body = req.body as {
        prompt?: string;
        templateId?: string;
        id?: string;
        assetIds?: string[];
        /** API-client-only override — the web UI never sends this; slide count comes from the prompt or the template default instead (see planner.ts's `resolveStepCount`). */
        slideCount?: number;
        preview?: boolean;
      };
      if (!body.prompt || typeof body.prompt !== "string") {
        res.status(400).json({ error: `"prompt" is required` });
        return;
      }
      const templateId = body.templateId ?? "explicativo";
      const carouselId = body.id ?? `carousel-${Date.now()}`;
      assertValidCarouselId(carouselId);
      if (documentExists(store, carouselId)) {
        res.status(409).json({ error: `Carousel "${carouselId}" already exists` });
        return;
      }

      const template = loadLayoutTemplate(store.roots.profileDir, templateId);
      const plan = buildCompositionPlan(store, body.prompt, template, body.slideCount, body.assetIds);

      const isPreview = req.query.mode === "plan" || body.preview === true;
      if (isPreview) {
        pendingPlans.set(`${req.params.slug}/${carouselId}`, plan);

        const estimatedCostCents = plan.visualSlots
          .filter((v) => v.source === "generate")
          .reduce((sum, v) => sum + (v.estimatedCostCents ?? 0), 0);

        res.status(201).json({
          carouselId,
          templateId,
          plan,
          estimatedCostCents,
          libraryPieces: plan.visualSlots.filter((v) => v.source === "library").length,
          generatedPieces: plan.visualSlots.filter((v) => v.source === "generate").length,
        });
        return;
      }

      // Immediate build: pure library composition + placeholders, no AI
      // call — see `buildImmediateDocument`'s own comment. Written to disk
      // right away so the document exists the moment this responds, and
      // the background job (started below) only ever mutates and re-writes
      // it, never creates it.
      const brand = loadBrand(store.roots.profileDir);
      const document = buildImmediateDocument(brand, templateId, plan, carouselId);
      writeDocument(store, document);

      const generator = getGenerator(req.params.slug);
      const jobId = enqueueComposeJob(store, brand, carouselId, document, generator, body.prompt);

      res.status(201).json({ document, jobId });
    } catch (error) {
      handlePlanError(error, res);
    }
  });

  /** Polls a background compose job started by the immediate-build path above. Mirrors `GET .../export/:jobId`'s 404-if-mismatched behavior. */
  router.get("/api/profiles/:slug/carousels/:id/compose/:jobId", (req, res) => {
    const job = getComposeJob(req.params.jobId);
    if (!job || job.slug !== req.params.slug || job.carouselId !== req.params.id) {
      res.status(404).json({ error: `No compose job "${req.params.jobId}"` });
      return;
    }
    res.json(job);
  });

  router.post("/api/profiles/:slug/carousels/:id/plan/apply", async (req, res) => {
    try {
      const store = new ProfileStore(req.params.slug);
      const key = `${req.params.slug}/${req.params.id}`;
      const plan = pendingPlans.get(key);
      if (!plan) {
        res.status(404).json({ error: `No pending plan for carousel "${req.params.id}" — create one via POST /carousels first.` });
        return;
      }
      const templateId = (req.body as { templateId?: string })?.templateId ?? "explicativo";
      const brand = loadBrand(store.roots.profileDir);
      const template = loadLayoutTemplate(store.roots.profileDir, templateId);
      const generator = getGenerator(req.params.slug);

      let document = await applyCompositionPlan(store, brand, template, templateId, plan, req.params.id, generator);
      // Persisted immediately: `applyCompositionPlan` already drafted and
      // wrote copy plus every `library`-sourced visual, so a failure in the
      // generation loop below must not lose that work on retry either.
      writeDocument(store, document);

      // Generate every visual slot the plan marked "generate" — done here,
      // after the client confirmed the cost the POST /carousels response
      // showed, rather than inside buildCompositionPlan/applyCompositionPlan
      // themselves, which must stay free to call for a cost preview.
      //
      // Non-transactional by nature (each `generateForSlot` call pays for
      // and writes an image asset that can't be un-paid-for on a later
      // failure), so the document is written to disk after every successful
      // slot instead of once at the end: if `generateForSlot` throws mid-loop
      // (rate limit, network error), the slots generated so far are not
      // orphaned — they're already attached to the persisted document, and a
      // retried `plan/apply` only needs to cover the remaining slots rather
      // than regenerating (and re-paying for) everything from slot zero.
      try {
        for (const visual of plan.visualSlots) {
          if (visual.source !== "generate") continue;
          // A retried `plan/apply` call replays the same `plan.visualSlots`
          // list; slots a previous, partially-failed run already generated
          // and persisted (see the `writeDocument` inside this loop) must be
          // skipped rather than generated — and paid for — a second time.
          if (isSlotGenerated(document, visual.slideIndex, visual.slot)) continue;
          const entry: AssetEntry = await generateForSlot(store, generator, {
            prompt: `${plan.promptText} — ${visual.slot}`,
            kind: visual.kind,
            canvas: { w: 1080, h: 1350 },
            carouselId: req.params.id,
            slot: visual.slot,
          });
          document = attachGeneratedAsset(brand, document, visual.slideIndex, visual.slot, entry.id);
          writeDocument(store, document);
        }
      } catch (error) {
        // Whatever slots succeeded before the failure are already on disk
        // (written above, inside the loop); only the pending plan is left
        // in place so the client can retry `plan/apply` and pick up where
        // it left off, instead of re-running `buildCompositionPlan` and
        // losing the "which slots are already generated" information.
        res.status(202).json({
          error: (error as Error).message,
          partial: true,
          document,
        });
        return;
      }

      pendingPlans.delete(key);
      res.status(201).json(document);
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
      const store = new ProfileStore(req.params.slug);
      const doc = readValidatedDocument(store, req.params.id);
      const target = (req.body as {
        target?: { slideId: string; objectId?: string; scope?: "unpinned" };
      })?.target;
      if (!target?.slideId) {
        res.status(400).json({ error: `"target.slideId" is required` });
        return;
      }

      const slideIndex = doc.slides.findIndex((s) => s.id === target.slideId);
      if (slideIndex === -1) {
        res.status(404).json({ error: `No slide "${target.slideId}"` });
        return;
      }

      snapshotDocument(store, req.params.id);

      const generator = getGenerator(req.params.slug);
      const brand = loadBrand(store.roots.profileDir);
      let nextDoc = doc;

      if (target.objectId === "background") {
        nextDoc = await regenerateBackground(store, generator, nextDoc, slideIndex, req.params.id, brand);
      } else if (target.objectId) {
        nextDoc = await regenerateObject(store, generator, nextDoc, slideIndex, target.objectId, req.params.id, brand);
      } else if (target.scope === "unpinned") {
        nextDoc = await regenerateUnpinned(store, generator, nextDoc, slideIndex, req.params.id, brand);
      } else {
        res.status(400).json({ error: `"target" must name an objectId or set scope: "unpinned"` });
        return;
      }

      writeDocument(store, nextDoc);
      res.json(nextDoc);
    } catch (error) {
      handlePlanError(error, res);
    }
  });

  router.get("/api/profiles/:slug/carousels/:id/stats", (req, res) => {
    try {
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

function attachGeneratedAsset(
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

async function regenerateBackground(
  store: ProfileStore,
  generator: PieceGenerator,
  doc: CarouselDocument,
  slideIndex: number,
  carouselId: string,
  brand: BrandTokens,
): Promise<CarouselDocument> {
  const slide = doc.slides[slideIndex]!;
  if (slide.background.pinned) {
    throw new RegenerateBlockedError(`Slide "${slide.id}"'s background is pinned — regenerate refused.`);
  }
  const entry = await generateForSlot(store, generator, {
    prompt: `${doc.prompt.text} — background for ${slide.kind}`,
    kind: "background",
    canvas: doc.canvas,
    carouselId,
    slot: "background",
  });
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
  return { ...doc, slides, updatedAt: new Date().toISOString() };
}

async function regenerateObject(
  store: ProfileStore,
  generator: PieceGenerator,
  doc: CarouselDocument,
  slideIndex: number,
  objectId: string,
  carouselId: string,
  brand: BrandTokens,
): Promise<CarouselDocument> {
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
    return { ...doc, slides, updatedAt: new Date().toISOString() };
  }

  const entry = await generateForSlot(store, generator, {
    prompt: `${doc.prompt.text} — ${object.slot ?? objectId}`,
    kind: "photo",
    canvas: doc.canvas,
    carouselId,
    slot: object.slot ?? objectId,
  });
  const slides = doc.slides.map((s, i) =>
    i === slideIndex
      ? {
          ...s,
          objects: s.objects.map((o) =>
            o.id === objectId && o.kind === "asset" ? { ...o, assetId: entry.id, source: "ai" as const } : o,
          ),
        }
      : s,
  );
  return { ...doc, slides, updatedAt: new Date().toISOString() };
}

async function regenerateUnpinned(
  store: ProfileStore,
  generator: PieceGenerator,
  doc: CarouselDocument,
  slideIndex: number,
  carouselId: string,
  brand: BrandTokens,
): Promise<CarouselDocument> {
  let next = doc;
  const slide = next.slides[slideIndex]!;
  if (!slide.background.pinned) {
    next = await regenerateBackground(store, generator, next, slideIndex, carouselId, brand);
  }
  for (const object of slide.objects) {
    if (object.pinned) continue;
    next = await regenerateObject(store, generator, next, slideIndex, object.id, carouselId, brand);
  }
  return next;
}

function isVisualObject(object: SlideObject): object is Extract<SlideObject, { kind: "asset" }> {
  return object.kind === "asset";
}

/** Percentage of the carousel's visual pieces (backgrounds + asset objects) whose `source` is `"library"` (piece-generation spec's "Library ratio with history"). */
function libraryRatio(doc: CarouselDocument): number {
  const visualPieces = doc.slides.flatMap((s) => [s.background, ...s.objects.filter(isVisualObject)]);
  if (visualPieces.length === 0) return 0;
  const fromLibrary = visualPieces.filter((p) => p.source === "library").length;
  return Math.round((fromLibrary / visualPieces.length) * 100);
}

/** Every carousel of the same profile, excluding the current one, most recently updated first — used for the reuse-trend comparison (piece-generation spec's "Library ratio with history"). */
function previousCarouselsLibraryRatio(
  store: ProfileStore,
  currentCarouselId: string,
): Array<{ carouselId: string; updatedAt: string; libraryRatio: number }> {
  const entries = store.list("carousels");
  const out: Array<{ carouselId: string; updatedAt: string; libraryRatio: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === currentCarouselId) continue;
    if (!documentExists(store, entry.name)) continue;
    try {
      const doc = readValidatedDocument(store, entry.name);
      out.push({ carouselId: doc.id, updatedAt: doc.updatedAt, libraryRatio: libraryRatio(doc) });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

class RegenerateBlockedError extends Error {}

function handlePlanError(error: unknown, res: import("express").Response): void {
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
