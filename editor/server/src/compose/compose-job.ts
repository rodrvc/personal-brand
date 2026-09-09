import type { CarouselDocument, Slide, SlideObject } from "../../../../system/ig-carousel/carousel-document.js";
import { loadBrandStyle } from "../../../../system/ig-carousel/brand-style.js";
import { readProfilePrimaryLanguage } from "../../../../system/ig-carousel/profile.js";

import { readValidatedDocument, writeDocument } from "../document-store.js";
import { NonePieceGenerator } from "../ai/none.js";
import type { PieceGenerator } from "../ai/piece-generator.js";
import type { ProfileStore } from "../profile-store.js";
import { suggestionForSlot, draftCopyBrandContext } from "./planner.js";

/**
 * Background job that fills in every `pending: true` placeholder a
 * `buildImmediateDocument` call left behind, one piece at a time, so a
 * carousel appears fully built in the editor before any AI work has
 * actually run (editor-ui spec's "Composition from the prompt" — no
 * mandatory plan/approval screen; the document is real from the start,
 * pending pieces just shimmer until this job reaches them). Mirrors the
 * in-memory job-map pattern of `export/export-queue.ts`: per-process state
 * is fine here for the same reason (design.md D13, local-first/single-user).
 *
 * Owner decision: this job NEVER calls `generateImage`. Text is cheap
 * enough to draft automatically, but an image slot with no library
 * candidate is left as an `awaitingImage: true` placeholder carrying the
 * planner's `suggestion` — only an explicit, per-piece request from the UI
 * (with an editable, cost-shown prompt) triggers actual generation
 * (piece-generation spec, "Library first, generate later").
 */
export interface ComposeJob {
  id: string;
  slug: string;
  carouselId: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  message?: string;
  totalPieces: number;
  completedPieces: number;
  costCentsSoFar: number;
  counts: { fromLibrary: number; generated: number; drafted: number };
}

const jobs = new Map<string, ComposeJob>();

export function getComposeJob(id: string): ComposeJob | undefined {
  return jobs.get(id);
}

interface PendingTextRef {
  slideIndex: number;
  objectId: string;
}

interface PendingVisualRef {
  slideIndex: number;
  /** `undefined` means the slide's background itself (not an object). */
  objectId?: string;
  slot: string;
}

function collectPending(doc: CarouselDocument): { texts: PendingTextRef[]; visuals: PendingVisualRef[] } {
  const texts: PendingTextRef[] = [];
  const visuals: PendingVisualRef[] = [];
  doc.slides.forEach((slide, slideIndex) => {
    if (slide.background.pending) {
      visuals.push({ slideIndex, slot: "background" });
    }
    for (const object of slide.objects) {
      if (!object.pending) continue;
      if (object.kind === "text") {
        texts.push({ slideIndex, objectId: object.id });
      } else {
        visuals.push({ slideIndex, objectId: object.id, slot: object.slot ?? object.id });
      }
    }
  });
  return { texts, visuals };
}

function countFromLibrary(doc: CarouselDocument): number {
  const pieces = doc.slides.flatMap((s) => [s.background, ...s.objects]);
  return pieces.filter((p) => p.source === "library").length;
}

/**
 * Counts how many pieces this job will actually touch (pending text
 * objects + pending visual slots), used for `totalPieces` up front so the
 * UI's "N/M piezas" progress line has a stable denominator from the start.
 */
function countPending(doc: CarouselDocument): number {
  const { texts, visuals } = collectPending(doc);
  return texts.length + visuals.length;
}

/**
 * True when `ref` is still safe for the background job to write onto the
 * CURRENT on-disk document — i.e. neither of the two things a concurrent
 * PUT from the user could have done to it since the job last read it has
 * happened: the user edited the piece by hand (it's no longer `pending` on
 * disk), or the user pinned it while the job was working on it (a pinned
 * piece is "keep what is here", same rule `clearVisualPending` already
 * applied for a background/object that got pinned mid-flight). Returns
 * `false` (skip) rather than throwing so one user edit never aborts the
 * rest of the job's pieces.
 */
function isStillWritable(doc: CarouselDocument, ref: PendingTextRef | PendingVisualRef): boolean {
  const slide = doc.slides[ref.slideIndex];
  if (!slide) return false;
  if (!("objectId" in ref) || ref.objectId === undefined) {
    // The slide's background itself.
    return slide.background.pending === true && !slide.background.pinned;
  }
  const object = slide.objects.find((o) => o.id === ref.objectId);
  if (!object) return false;
  return object.pending === true && !object.pinned;
}

/** Clears `pending` on a text object, giving it fallback empty text if none was drafted (the "skip" path, or a drafting failure). */
function clearTextPending(doc: CarouselDocument, ref: PendingTextRef, text: string): CarouselDocument {
  const slides = doc.slides.map((slide, index) => {
    if (index !== ref.slideIndex) return slide;
    return {
      ...slide,
      objects: slide.objects.map((o) => (o.id === ref.objectId ? { ...o, text, pending: false } : o)),
    };
  });
  return { ...doc, slides, updatedAt: new Date().toISOString() };
}

/**
 * Clears `pending` on a visual slot (background or asset object). This job
 * never generates an image (owner decision — see this file's top comment),
 * so when the slot has no library candidate it becomes an
 * `awaitingImage: true` placeholder carrying `suggestion` for the UI's
 * per-piece "Generar imagen…" field, instead of ever getting an `assetId`
 * here.
 */
function clearVisualPending(
  doc: CarouselDocument,
  ref: PendingVisualRef,
  suggestion: string,
): CarouselDocument {
  const slides = doc.slides.map((slide, index) => {
    if (index !== ref.slideIndex) return slide;
    if (!ref.objectId) {
      // The slide's background itself.
      const nextBackground: Slide["background"] = {
        ...slide.background,
        pending: false,
        awaitingImage: true,
        suggestion,
      };
      return { ...slide, background: nextBackground };
    }
    const objects: SlideObject[] = slide.objects.map((o) =>
      o.id === ref.objectId ? { ...o, pending: false, awaitingImage: true, suggestion } : o,
    );
    return { ...slide, objects };
  });
  return { ...doc, slides, updatedAt: new Date().toISOString() };
}

/** Same as `clearVisualPending` but with no suggestion — the "skipped" (no AI key) path, where there is no planner call to derive one from either. */
function clearVisualPendingNoSuggestion(doc: CarouselDocument, ref: PendingVisualRef): CarouselDocument {
  const slides = doc.slides.map((slide, index) => {
    if (index !== ref.slideIndex) return slide;
    if (!ref.objectId) {
      return { ...slide, background: { ...slide.background, pending: false } };
    }
    const objects: SlideObject[] = slide.objects.map((o) => (o.id === ref.objectId ? { ...o, pending: false } : o));
    return { ...slide, objects };
  });
  return { ...doc, slides, updatedAt: new Date().toISOString() };
}

/**
 * Starts the background compose job for a just-created, immediately-built
 * document. Returns the job id right away (per routes/compose.ts's "the
 * route returns before any AI work runs") — the actual work happens on a
 * detached async IIFE below, persisting the document via `writeDocument`
 * after every single piece so a crash or a later failure never loses
 * earlier, already-paid-for work (same reasoning as the old plan/apply
 * flow's per-slot `writeDocument` calls in routes/compose.ts).
 */
export function enqueueComposeJob(
  store: ProfileStore,
  carouselId: string,
  initialDocument: CarouselDocument,
  generator: PieceGenerator,
  promptText: string,
): string {
  const jobId = `${store.slug}-${carouselId}-compose-${Date.now()}`;
  const job: ComposeJob = {
    id: jobId,
    slug: store.slug,
    carouselId,
    status: "queued",
    totalPieces: countPending(initialDocument),
    completedPieces: 0,
    costCentsSoFar: 0,
    counts: { fromLibrary: countFromLibrary(initialDocument), generated: 0, drafted: 0 },
  };
  jobs.set(jobId, job);

  // No key configured at all: skip immediately, without ever calling the
  // generator (which would just throw once per pending piece) — same
  // "unavailable" detection routes already use elsewhere (checking for
  // `NonePieceGenerator` is cheaper and clearer than catching N identical
  // `GenerationUnavailableError`s from the first N calls).
  if (generator instanceof NonePieceGenerator) {
    job.status = "skipped";
    job.message =
      "IA no configurada: falta la variable OPENAI_API_KEY. Se generó con piezas de biblioteca y textos vacíos.";
    const cleared = skipAllPending(initialDocument);
    writeDocument(store, cleared);
    job.completedPieces = job.totalPieces;
    return jobId;
  }

  void runComposeJob(store, job, initialDocument, generator, promptText);
  return jobId;
}

/**
 * Flips every pending placeholder's `pending` to `false` with no AI call —
 * the "skipped" (no API key) path. Visual slots get no `suggestion` here
 * either (deriving one is the planner's job, and the planner is never
 * invoked on this path): they simply stop being `pending`, exactly like
 * the compose job's own "generator threw" fallback for an image slot.
 */
function skipAllPending(doc: CarouselDocument): CarouselDocument {
  const { texts, visuals } = collectPending(doc);
  let next = doc;
  for (const ref of texts) next = clearTextPending(next, ref, "");
  for (const ref of visuals) next = clearVisualPendingNoSuggestion(next, ref);
  return next;
}

/**
 * Re-reads the document fresh off disk, applies `apply` to it if (and only
 * if) `ref` is still writable on THAT fresh copy (see `isStillWritable`),
 * and writes the result back — the read-modify-write unit that keeps this
 * job from clobbering a concurrent PUT. Never touches an in-memory `doc`
 * across pieces: every single piece gets its own fresh read, because the
 * previous piece's write (or an unrelated PUT from the user) may have
 * changed the on-disk document in the meantime. Returns whether the piece
 * was actually applied, so the caller can decide how to count it.
 */
function persistPiece(
  store: ProfileStore,
  carouselId: string,
  ref: PendingTextRef | PendingVisualRef,
  apply: (fresh: CarouselDocument) => CarouselDocument,
): boolean {
  const fresh = readValidatedDocument(store, carouselId);
  if (!isStillWritable(fresh, ref)) {
    // The user edited this piece's text/geometry (no longer pending) or
    // pinned it while the job was working — either way, "keep what the
    // user has now" wins over whatever this job just produced. Nothing is
    // written; the piece is simply skipped.
    return false;
  }
  writeDocument(store, apply(fresh));
  return true;
}

async function runComposeJob(
  store: ProfileStore,
  job: ComposeJob,
  initialDocument: CarouselDocument,
  generator: PieceGenerator,
  promptText: string,
): Promise<void> {
  job.status = "running";

  const brandStyle = loadBrandStyle(store.roots.profileDir);
  const language = readProfilePrimaryLanguage(store.roots.profileDir);
  const brandContext = draftCopyBrandContext(brandStyle, language);

  // The set of pieces this job will attempt is fixed from the document as
  // it looked the moment the job was created — `slideIndex`/`objectId` are
  // structural references, stable even if the user edits other pieces
  // concurrently. What's no longer fixed is the CONTENT each write lands
  // on: every actual persistence below re-reads the current on-disk
  // document first (`persistPiece`), so a concurrent PUT to some other
  // piece (or to this same piece, which then makes it ineligible) is never
  // overwritten by this job's stale in-memory copy.
  const doc = initialDocument;

  // Text pieces: batched per slide (mirrors applyCompositionPlan's
  // batching) rather than one `draftCopy` call per text object — a slide's
  // headline and body are drafted together since the provider returns both
  // per slideId.
  const { texts } = collectPending(doc);
  const bySlide = new Map<number, PendingTextRef[]>();
  for (const ref of texts) {
    const list = bySlide.get(ref.slideIndex) ?? [];
    list.push(ref);
    bySlide.set(ref.slideIndex, list);
  }

  for (const [slideIndex, refs] of bySlide) {
    const slide = doc.slides[slideIndex];
    if (!slide) continue;
    try {
      const draft = await generator.draftCopy({
        carouselPrompt: promptText,
        slides: [{ slideId: slide.id, kind: slide.kind, brief: promptText, limits: { headline: 200 } }],
        brand: brandContext,
      });
      job.costCentsSoFar += draft.costCents;
      const drafted = draft.slides[0];
      for (const ref of refs) {
        const object = slide.objects.find((o) => o.id === ref.objectId);
        const text =
          object?.slot === "body"
            ? drafted?.body ?? drafted?.headline ?? ""
            : drafted?.headline ?? drafted?.body ?? "";
        persistPiece(store, job.carouselId, ref, (fresh) => clearTextPending(fresh, ref, text));
        job.completedPieces += 1;
        job.counts.drafted += 1;
      }
    } catch (error) {
      // A drafting failure for one slide's text must not crash the whole
      // job (same partial-failure reasoning as the old plan/apply flow in
      // routes/compose.ts): the affected placeholders fall back to empty
      // text, still counted as "completed" (no longer pending, nothing
      // left spinning), and the job continues to the next slide/piece. The
      // job itself is marked "error" so the header shows the message —
      // but only after every piece has been attempted, not on the first
      // failure, so a single flaky call doesn't abandon everything else.
      for (const ref of refs) {
        persistPiece(store, job.carouselId, ref, (fresh) => clearTextPending(fresh, ref, ""));
        job.completedPieces += 1;
      }
      job.message = `Fallo redactando texto: ${(error as Error).message}`;
    }
  }

  // Visual pieces: this job never generates an image (owner decision — see
  // this file's top comment). Every pending visual slot with no library
  // candidate simply becomes an `awaitingImage: true` placeholder carrying
  // the planner's `suggestion`, with no AI call and no cost. Read fresh off
  // the job's original `doc` (not off disk again here): the text loop
  // above never mutates this in-memory `doc`, and a slide's background
  // pending flag is untouched by that loop, so this still finds every
  // visual placeholder this job is responsible for — the actual current
  // state is only consulted per-piece, inside `persistPiece`.
  const { visuals } = collectPending(doc);
  for (const ref of visuals) {
    const suggestion = suggestionForSlot(promptText, ref.slot, brandStyle);
    persistPiece(store, job.carouselId, ref, (fresh) => clearVisualPending(fresh, ref, suggestion));
    job.completedPieces += 1;
  }

  job.status = job.message ? "error" : "done";
}
