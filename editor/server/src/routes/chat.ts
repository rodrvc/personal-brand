import { Router } from "express";
import { z } from "zod";

import type { CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";

import { GenerationUnavailableError, type PieceGenerator } from "../ai/piece-generator.js";
import { readProfileCurrency } from "../../../../system/ig-carousel/profile.js";
import { detectImage, loadIndex } from "../../../../system/assets/index.js";
import { generateForSlot, storeImage } from "../compose/planner.js";
import { addFreeAssetObject } from "../../../../system/ig-carousel/free-objects.js";
import { applyAction, ChatActionError, isFreePlacement, visualSlot, type ChatAction, CHAT_ACTION_TYPES, modelActionSchema, resolveAction } from "../chat/chat-actions.js";
import { buildChatContext, chatInput, chatInstructions, type PosterRoute } from "../chat/chat-context.js";
import { appendChatRecord, newChatId, pendingProposal, readChatLog, type ChatProposal, type ChatRecord } from "../chat/chat-log.js";
import {
  anchorLines,
  classifyLines,
  completeTexts,
  keepTextsPrompt,
  letterbox,
  numberedLines,
  measureTexts,
  missingData,
  checkSources,
  placePoster,
  posterData,
  posterPrompt,
  refineTexts,
  register,
  settleTexts,
  toSlide,
  type Box,
  type LineKind,
  type PlacedText,
  withAbsentLabels,
} from "../chat/recreate-reference.js";
import { referenceBackground } from "../chat/reference-background.js";
import { colourReader, edgeColor, eraseBoxes, findPicture, ImageToolUnavailableError, inkReader, remap, toPng } from "../image-tools.js";
import { readTextLines, type TextLine } from "../text-boxes.js";
import { chromiumRasteriser, type Rasterise } from "../text-raster.js";
import { ChatReferenceError, loadReferenceImages, normalizeReference, readAssetFile, saveReference, type ChatReference } from "../chat/chat-references.js";
import { documentExists, readValidatedDocument, snapshotDocument, validateAgainstProfile, writeDocument } from "../document-store.js";
import { ProfileStore } from "../profile-store.js";
import { attachGeneratedAsset, readGeneratedAssetCostCents } from "./compose.js";
import { messages } from "../messages.js";
import { handleStoreError } from "./profiles.js";

const BASE = "/api/profiles/:slug/carousels/:id/chat";

function isPlaced(doc: CarouselDocument, slideId: string, assetIds: string[]): boolean {
  const slide = doc.slides.find((s) => s.id === slideId);
  if (!slide) return assetIds.length === 0;
  const held = new Set([slide.background.mode === "asset" ? slide.background.assetId : undefined, ...slide.objects.map((o) => (o.kind === "asset" ? o.assetId : undefined))]);
  return assetIds.every((id) => held.has(id));
}

interface LayoutRead {
  lines?: TextLine[];
  kinds?: LineKind[];
  aspect?: number;
  picture?: Box;
  ink?: ReturnType<typeof inkReader>;
}

/** What an image-tool read returns, or undefined where the tool is unavailable (off macOS): a reading that only refines a poster never fails the request. */
function whereImageToolRuns<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (error instanceof ImageToolUnavailableError) return undefined;
    throw error;
  }
}

/**
 * How a poster from a reference is made: one image by the image provider (default), or, with
 * `EDITOR_POSTER_ROUTE=editable`, a background with editable texts on top (see `posterBackground`).
 */
export function posterRoute(): PosterRoute {
  return process.env.EDITOR_POSTER_ROUTE?.trim() === "editable" ? "editable" : "image";
}

/**
 * The layout reference's proportion, read before the model is asked; for an editable poster also its measured text
 * lines and framed picture. A poster made as one image needs no OCR and no frame.
 */
function readLayout(store: ProfileStore, references: ChatReference[], wordmark: string, route: PosterRoute): LayoutRead {
  const layout = references.find((r) => r.role === "layout");
  const file = layout ? readAssetFile(store, layout.id) : undefined;
  if (!file) return {};
  const size = detectImage(file.bytes, "reference");
  if (route === "image") return size.w && size.h ? { aspect: size.w / size.h } : {};
  const picture = whereImageToolRuns(() => findPicture(file.bytes));
  const lines = readTextLines(file.bytes);
  const ink = lines ? whereImageToolRuns(() => inkReader(toPng(file.bytes))) : undefined;
  return {
    ...(lines ? { lines, kinds: classifyLines(lines, picture, wordmark) } : {}),
    ...(size.w && size.h ? { aspect: size.w / size.h } : {}),
    ...(picture ? { picture } : {}),
    ...(ink ? { ink } : {}),
  };
}

function proposeRecreation(
  ctx: ReturnType<typeof buildChatContext>,
  action: Extract<ChatAction, { type: "compose_from_reference" }>,
  references: Array<ChatReference & { mime: string }>,
  accepts: PieceGenerator["acceptsReference"],
  activeSlideId: string | undefined,
  request: string,
  layoutRead: LayoutRead,
  route: PosterRoute,
): ChatAction {
  const layout = references.find((r) => r.role === "layout");
  if (!layout) throw new ChatActionError(messages.proposal.needsLayoutReference);
  if (route === "image") return proposePosterImage(ctx, action, references, accepts, activeSlideId, request, layoutRead, layout);
  const completed = layoutRead.lines && layoutRead.kinds ? completeTexts(action.texts, layoutRead.lines, layoutRead.kinds) : action.texts;
  const classified = withAbsentLabels(completed, layoutRead.lines);
  const texts = refineTexts(
    measureTexts(classified, layoutRead.lines),
    { locale: ctx.brand.locale },
    layoutRead.ink,
  );
  const content = references.find((r) => r.role === "content");
  const contentAsImage = content !== undefined && accepts("background", content.mime);
  const fallback = ctx.doc.slides.some((s) => s.id === activeSlideId) ? activeSlideId : ctx.doc.slides[0]?.id;
  const named = (p: ChatAction["provenance"][number]) => (p.source === "content_reference" && content ? { ...p, detail: `${content.name} · ${p.detail}` } : p);
  return {
    ...action,
    texts,
    slideId: action.slideId ?? fallback,
    referenceIds: [layout.id, ...(contentAsImage ? [content!.id] : [])],
    request,
    posterRoute: "editable",
    ...(layoutRead.aspect ? { layoutAspect: layoutRead.aspect } : {}),
    ...(layoutRead.picture ? { picture: layoutRead.picture } : {}),
    ...(layoutRead.lines ? { anchors: anchorLines(classified, layoutRead.lines, layoutRead.picture) } : {}),
    provenance: [
      { source: "layout_reference", detail: layout.name },
      ...(content ? [{ source: contentAsImage ? ("content_reference" as const) : ("reference_described" as const), detail: content.name }] : []),
      ...resolveAction(ctx, { ...action, texts }).provenance.map(named),
    ],
  };
}

/** A poster made as one image: only the event's data, each date with its weekday written from its day. */
function proposePosterImage(
  ctx: ReturnType<typeof buildChatContext>,
  action: Extract<ChatAction, { type: "compose_from_reference" }>,
  references: Array<ChatReference & { mime: string }>,
  accepts: PieceGenerator["acceptsReference"],
  activeSlideId: string | undefined,
  request: string,
  layoutRead: LayoutRead,
  layout: ChatReference,
): ChatAction {
  const texts = posterData(action.texts, ctx.brand.locale);
  const content = references.find((r) => r.role === "content");
  const contentAsImage = content !== undefined && accepts("background", content.mime);
  const fallback = ctx.doc.slides.some((s) => s.id === activeSlideId) ? activeSlideId : ctx.doc.slides[0]?.id;
  const named = (p: ChatAction["provenance"][number]) => (p.source === "content_reference" && content ? { ...p, detail: `${content.name} · ${p.detail}` } : p);
  return {
    ...action,
    texts,
    slideId: action.slideId ?? fallback,
    referenceIds: [layout.id, ...(contentAsImage ? [content!.id] : [])],
    request,
    posterRoute: "image",
    ...(layoutRead.aspect ? { layoutAspect: layoutRead.aspect } : {}),
    provenance: [
      { source: "layout_reference", detail: layout.name },
      ...(content ? [{ source: contentAsImage ? ("content_reference" as const) : ("reference_described" as const), detail: content.name }] : []),
      ...resolveAction(ctx, { ...action, texts }).provenance.map(named),
    ],
  };
}

function toProposal(
  ctx: ReturnType<typeof buildChatContext>,
  raw: unknown,
  references: Array<ChatReference & { mime: string }>,
  accepts: PieceGenerator["acceptsReference"],
  activeSlideId: string | undefined,
  request: string,
  layoutRead: LayoutRead,
  route: PosterRoute,
  ownerMessages: string[],
  answering: string[],
): { text: string; rejected: string } | { text: string; actions: ChatAction[] } | { text: string; asksFor: string[] } {
  const body = (raw ?? {}) as { text?: unknown; actions?: unknown };
  const text = typeof body.text === "string" ? body.text : "";
  const rawActions = Array.isArray(body.actions) ? body.actions : [];
  const unknownType = rawActions
    .map((a) => (a as { type?: unknown })?.type)
    .find((type) => !CHAT_ACTION_TYPES.includes(type as (typeof CHAT_ACTION_TYPES)[number]));
  if (unknownType !== undefined) {
    return { text, rejected: `${messages.proposal.unknownAction(String(unknownType))} ${messages.proposal.nothingProposed}` };
  }
  const composes = rawActions.some((a) => (a as { type?: unknown })?.type === "compose_from_reference");
  try {
    // compose_from_reference creates its own slide when needed, so an add_slide beside it would leave an empty one.
    const actions = rawActions.filter((a) => !(composes && (a as { type?: unknown })?.type === "add_slide")).map((a) => {
      const parsed = modelActionSchema.parse(a);
      if (parsed.type === "compose_from_reference" && !ctx.doc.slides.some((s) => s.id === parsed.slideId)) {
        delete parsed.slideId;
      }
      const action = resolveAction(ctx, parsed);
      if (action.type === "compose_from_reference") {
        // Where each text comes from is checked against what was said, not taken from the model's word.
        const checked = { ...action, texts: checkSources(action.texts, ownerMessages, answering) };
        return proposeRecreation(ctx, checked, references, accepts, activeSlideId, request, layoutRead, route);
      }
      if (action.type !== "generate_visual") return action;
      const asImage = references.filter((r) => accepts(action.kind, r.mime));
      const fromReferences = references.map((r) => ({
        source: asImage.includes(r) ? ("reference" as const) : ("reference_described" as const),
        detail: r.name,
      }));
      const referenceIds = asImage.map((r) => r.id);
      return { ...action, provenance: [...action.provenance, ...fromReferences], ...(referenceIds.length > 0 ? { referenceIds } : {}) };
    });
    // No event datum comes from the layout: a poster missing any is not proposed, the owner is asked for all at once.
    const compose = actions.find((a) => a.type === "compose_from_reference");
    const missing = compose ? missingData(compose.texts) : [];
    if (missing.length > 0) {
      const names = missing.map((m) => (m.replaces ? messages.proposal.insteadOf(m.replaces) : (messages.proposal.dataNames[m.zone] ?? m.zone)));
      return { text: messages.proposal.missingData(names), asksFor: missing.map((m) => m.replaces ?? m.zone) };
    }
    return { text, actions };
  } catch (error) {
    const issue = error instanceof z.ZodError ? error.issues[0] : undefined;
    const reason =
      error instanceof ChatActionError
        ? error.message
        : messages.proposal.malformed(issue ? `${issue.path.join(".")}: ${issue.message}` : undefined);
    return { text, rejected: `${reason} ${messages.proposal.nothingProposed}` };
  }
}

/** A content reference is placeable only in answer to the message it came with, at proposal and at apply time. */
function withReferences(ctx: ReturnType<typeof buildChatContext>, references: ChatReference[]): ReturnType<typeof buildChatContext> {
  const placeable = references.filter((r) => r.role === "content").map((r) => ({ id: r.id, name: r.name, kind: "photo" as const, tags: [] }));
  return { ...ctx, library: [...ctx.library, ...placeable] };
}

function proposalReferences(log: ChatRecord[], proposalId: string): ChatReference[] {
  const answer = log.findIndex((r) => r.role === "assistant" && r.proposal?.id === proposalId);
  const message = log.slice(0, answer).reverse().find((r) => r.role === "user" && r.text !== "");
  return message?.role === "user" ? (message.references ?? []) : [];
}

function notPlaced(store: ProfileStore, doc: CarouselDocument, results: EventResults): { slide?: number; image: string } | undefined {
  for (const r of results) {
    for (const slideId of r.slideIds) {
      const absent = (r.assetIds ?? []).find((id) => !isPlaced(doc, slideId, [id]));
      if (absent) {
        const n = doc.slides.findIndex((s) => s.id === slideId) + 1;
        return { slide: n || undefined, image: assetName(store, absent) };
      }
    }
  }
  return undefined;
}

function assetName(store: ProfileStore, assetId: string): string {
  const entry = loadIndex(store.roots.profileDir).entries.find((e) => e.id === assetId);
  return entry?.path.split("/").pop() ?? assetId;
}

type GenerationRequest = Omit<Parameters<typeof generateForSlot>[2], "canvas" | "carouselId">;

type PlacedTexts = Map<string, PlacedText[]>;

function generationFor(store: ProfileStore, action: ChatAction, canvas: CarouselDocument["canvas"], placed: PlacedTexts): GenerationRequest | undefined {
  if (action.type === "compose_from_reference") {
    const layout = action.referenceIds?.[0] ? readAssetFile(store, action.referenceIds[0]) : undefined;
    const pad = layout ? whereImageToolRuns(() => edgeColor(layout.bytes)) : undefined;
    const aspect = action.layoutAspect ?? canvas.w / canvas.h;
    const texts = measureTexts(action.texts, undefined).map((t) => ({ ...t, box: toSlide(t.box, aspect, canvas) }));
    const anchors = (action.anchors ?? []).map((line) => ({ ...line, box: toSlide(line.box, aspect, canvas) }));
    return {
      prompt: keepTextsPrompt((action.referenceIds?.length ?? 0) > 1),
      kind: "background",
      slot: "reference",
      referenceAssetIds: action.referenceIds,
      mode: "reproduce",
      ...(pad ? { padColor: pad } : {}),
      postProcess: (image) => {
        const drawn = readTextLines(image);
        const size = detectImage(image, "generated");
        const expected = size.w && size.h ? letterbox(size.w / size.h, canvas.w / canvas.h) : undefined;
        const registration = register(anchors, drawn, expected);
        const settled = settleTexts(texts, drawn, registration);
        placed.set(action.id, settled.texts);
        return eraseBoxes(remap(image, registration, canvas.w, canvas.h, pad), settled.erase);
      },
    };
  }
  if (action.type === "generate_visual") {
    return { prompt: action.prompt, kind: action.kind, slot: visualSlot(action) ?? "free", referenceAssetIds: action.referenceIds };
  }
  return undefined;
}

/**
 * A poster made as one image: the layout reference (first, letterboxed to the slide) and the event (second) go to the
 * image provider with every event datum stated. The result is cut back to the slide's proportion, never stretched.
 */
function posterImageFor(store: ProfileStore, action: Extract<ChatAction, { type: "compose_from_reference" }>, canvas: CarouselDocument["canvas"], locale: string): GenerationRequest {
  const layout = action.referenceIds?.[0] ? readAssetFile(store, action.referenceIds[0]) : undefined;
  const pad = layout ? whereImageToolRuns(() => edgeColor(layout.bytes)) : undefined;
  return {
    prompt: posterPrompt({ texts: action.texts, request: action.request ?? "", contentAttached: (action.referenceIds?.length ?? 0) > 1, locale }),
    kind: "background",
    slot: "reference",
    referenceAssetIds: action.referenceIds,
    mode: "reproduce",
    ...(pad ? { padColor: pad } : {}),
    postProcess: (image) => fitToSlide(image, canvas, pad),
  };
}

/**
 * The generated poster at the slide's proportion: as it is when it already has it, else the slide's letterboxed
 * region resampled to the canvas, so nothing is stretched.
 */
export function fitToSlide(image: Buffer, canvas: CarouselDocument["canvas"], pad?: string): Buffer {
  const size = detectImage(image, "generated");
  if (!size.w || !size.h) return image;
  const imageAspect = size.w / size.h;
  const slideAspect = canvas.w / canvas.h;
  if (Math.abs(imageAspect / slideAspect - 1) < 0.005) return image;
  return remap(image, letterbox(imageAspect, slideAspect), canvas.w, canvas.h, pad);
}

/** Where the poster's background comes from: the layout reference itself (default) or the image provider. */
function posterBackground(): "reference" | "provider" {
  return process.env.EDITOR_POSTER_BACKGROUND === "provider" ? "provider" : "reference";
}

interface Composition {
  backgroundId: string;
  texts: PlacedText[];
  picture?: { assetId: string; box: Box };
  behind: (box: Box) => string;
}

/**
 * The poster built locally, at no cost: the layout reference with its texts erased and its pills redrawn with their
 * new texts, and the event's picture framed.
 */
async function composeFromLayout(
  store: ProfileStore,
  action: Extract<ChatAction, { type: "compose_from_reference" }>,
  canvas: CarouselDocument["canvas"],
  brand: ReturnType<typeof buildChatContext>["brand"],
  carouselId: string,
  rasterise: Rasterise,
): Promise<Composition> {
  const [layoutId, contentId] = action.referenceIds ?? [];
  const layout = layoutId ? readAssetFile(store, layoutId) : undefined;
  if (!layout) throw new ChatActionError(messages.proposal.needsLayoutReference);
  const aspect = action.layoutAspect ?? canvas.w / canvas.h;
  const onSlide = measureTexts(action.texts, undefined).map((t) => ({ ...t, box: toSlide(t.box, aspect, canvas) }));
  const built = await referenceBackground(layout.bytes, onSlide, aspect, canvas, brand, rasterise);
  const entry = storeImage(
    store,
    { buffer: built.image, mime: "image/png", model: "layout-reference", costCents: 0, usedReferenceIds: [layoutId!] },
    { prompt: "Layout reference with its texts erased", kind: "background", carouselId, slot: "reference" },
  );
  return {
    backgroundId: entry.id,
    texts: built.texts,
    ...(action.picture && contentId ? { picture: { assetId: contentId, box: toSlide(action.picture, aspect, canvas) } } : {}),
    behind: colourReader(built.image),
  };
}

type EventResults = Extract<ChatRecord, { role: "event" }>["results"];

async function runProposal(
  store: ProfileStore,
  carouselId: string,
  proposal: ChatProposal,
  generator: PieceGenerator,
  references: ChatReference[],
  rasterise: Rasterise,
): Promise<void> {
  const results: EventResults = [];
  const spent = () => results.reduce((sum, r) => sum + (r.costCents ?? 0), 0);
  const fail = (error: unknown) =>
    appendChatRecord(store, carouselId, {
      role: "event",
      kind: "failed",
      proposalId: proposal.id,
      error: (error as Error)?.message ?? String(error),
      costCents: spent(),
      results,
    });
  try {
    const generated = new Map<string, string>();
    const placed: PlacedTexts = new Map();
    const composed = new Map<string, Composition>();
    const canvas = readValidatedDocument(store, carouselId).canvas;
    const brand = buildChatContext(store, carouselId).brand;
    for (const action of proposal.actions) {
      if (action.type === "compose_from_reference" && (action.posterRoute ?? posterRoute()) === "image") {
        const entry = await generateForSlot(store, generator, { ...posterImageFor(store, action, canvas, brand.locale), canvas, carouselId });
        generated.set(action.id, entry.id);
        placed.set(action.id, []);
        results.push({ actionId: action.id, slideIds: [], assetIds: [entry.id], costCents: readGeneratedAssetCostCents(store, entry.id) });
        continue;
      }
      if (action.type === "compose_from_reference" && posterBackground() === "reference") {
        const composition = await composeFromLayout(store, action, canvas, brand, carouselId, rasterise);
        composed.set(action.id, composition);
        generated.set(action.id, composition.backgroundId);
        placed.set(action.id, composition.texts);
        results.push({ actionId: action.id, slideIds: [], assetIds: [composition.backgroundId], costCents: 0 });
        continue;
      }
      const spec = generationFor(store, action, canvas, placed);
      if (!spec) continue;
      const entry = await generateForSlot(store, generator, { ...spec, canvas, carouselId });
      generated.set(action.id, entry.id);
      const slideIds = "slideId" in action && action.slideId ? [action.slideId] : [];
      results.push({ actionId: action.id, slideIds, assetIds: [entry.id], costCents: readGeneratedAssetCostCents(store, entry.id) });
    }

    const ctx = withReferences(buildChatContext(store, carouselId), references);
    let document = ctx.doc;
    for (const action of proposal.actions) {
      if (action.type === "generate_visual") {
        const assetId = generated.get(action.id)!;
        resolveAction({ ...ctx, doc: document }, action);
        const slot = visualSlot(action);
        document =
          isFreePlacement({ ...ctx, doc: document }, action) || !slot
            ? addFreeAssetObject(document, action.slideId, { id: newChatId(`obj-${action.slideId}-ai`), assetId, source: "ai", fit: "contain" })
            : attachGeneratedAsset(ctx.brand, document, document.slides.findIndex((s) => s.id === action.slideId), slot, assetId);
        continue;
      }
      if (action.type === "compose_from_reference") {
        const assetId = generated.get(action.id)!;
        resolveAction({ ...ctx, doc: document }, action);
        const existing = action.slideId ? document.slides.find((s) => s.id === action.slideId) : undefined;
        const composition = composed.get(action.id);
        const slide = placePoster(existing, assetId, placed.get(action.id) ?? [], document.canvas, ctx.brand, {
          ...(composition?.picture ? { picture: composition.picture } : {}),
          ...(composition ? { behind: composition.behind } : {}),
        });
        document = {
          ...document,
          slides: existing ? document.slides.map((s) => (s.id === existing.id ? slide : s)) : [...document.slides, slide],
          updatedAt: new Date().toISOString(),
        };
        results.find((r) => r.actionId === action.id)!.slideIds = [slide.id];
        continue;
      }
      const applied = applyAction({ ...ctx, doc: document }, action);
      document = applied.document;
      results.push({ actionId: action.id, slideIds: applied.slideIds });
    }
    const validation = validateAgainstProfile(store, document);
    if (!validation.valid) {
      const [first] = validation.errors;
      throw new ChatActionError(messages.proposal.invalidResult(first!.path, first!.message));
    }
    const before = notPlaced(store, validation.document, results);
    if (before) throw new Error(messages.proposal.imageNotPlaced(before.slide, before.image));
    const documentVersion = snapshotDocument(store, carouselId);
    writeDocument(store, validation.document);
    const after = notPlaced(store, readValidatedDocument(store, carouselId), results);
    if (after) throw new Error(messages.proposal.imageRemovedMeanwhile(after.slide, after.image));
    appendChatRecord(store, carouselId, {
      role: "event",
      kind: "done",
      proposalId: proposal.id,
      documentVersion,
      costCents: spent(),
      results,
    });
  } catch (error) {
    fail(error);
  }
}

/**
 * The message a message without references answers: the one whose answer asked the owner for missing data, so the
 * reply to that question composes the same poster, from its references and with its request.
 */
function awaitedMessage(history: ChatRecord[]): { text: string; references: ChatReference[]; asksFor: string[] } | undefined {
  const asked = history.map((r) => r.role).lastIndexOf("assistant");
  const answer = history[asked];
  if (answer?.role !== "assistant" || !answer.asksFor) return undefined;
  const message = history.slice(0, asked).reverse().find((r) => r.role === "user" && r.text !== "");
  return message?.role === "user" && message.references?.length ? { text: message.text, references: message.references, asksFor: answer.asksFor } : undefined;
}

export function chatRouter(
  getGenerator: (slug: string) => PieceGenerator,
  rasteriserFor: (store: ProfileStore, brand: ReturnType<typeof buildChatContext>["brand"]) => Rasterise = chromiumRasteriser,
): Router {
  const router = Router();

  function open(slug: string, id: string): ProfileStore | undefined {
    const store = new ProfileStore(slug);
    return documentExists(store, id) ? store : undefined;
  }

  router.get(BASE, (req, res) => {
    try {
      const store = open(req.params.slug, req.params.id);
      if (!store) return void res.status(404).json({ error: `No carousel "${req.params.id}"` });
      const log = readChatLog(store, req.params.id);
      res.json({
        records: log,
        pendingProposalId: pendingProposal(log)?.id ?? null,
        currency: readProfileCurrency(store.roots.profileDir) ?? { code: "USD", rate: 1 },
      });
    } catch (error) {
      handleStoreError(error, res);
    }
  });

  router.post(`${BASE}/messages`, async (req, res) => {
    try {
      const { text, references: attached = [], activeSlideId } = (req.body ?? {}) as {
        text?: unknown;
        references?: ChatReference[];
        activeSlideId?: string;
      };
      const wellFormed = (r: unknown) =>
        typeof (r as ChatReference)?.id === "string" && typeof (r as ChatReference)?.name === "string";
      if (typeof text !== "string" || text.trim() === "" || !Array.isArray(attached) || !attached.every(wellFormed)) {
        return void res.status(400).json({ error: 'Body must be { "text": string, "references"?: [{ id, name }] }' });
      }
      const store = open(req.params.slug, req.params.id);
      if (!store) return void res.status(404).json({ error: `No carousel "${req.params.id}"` });

      const history = readChatLog(store, req.params.id);
      const awaited = attached.length > 0 ? undefined : awaitedMessage(history);
      const references = attached.length > 0 ? attached : (awaited?.references ?? []);
      // The answer to a question completes the message that asked for the poster: the provider hears both.
      const request = awaited ? `${awaited.text}\n${text}` : text;
      const route = posterRoute();
      const ctx = withReferences(buildChatContext(store, req.params.id), references);
      const generator = getGenerator(req.params.slug);
      const images = loadReferenceImages(store, references.map((r) => r.id));
      const layoutRead = readLayout(store, references, ctx.brand.copy.wordmark, route);
      const completion = await generator.completeJson({
        instructions: chatInstructions(route),
        input: chatInput(ctx, history, text, references.map((r) => ({ name: r.name, role: r.role ?? "content" })), numberedLines(layoutRead.lines, layoutRead.kinds)),
        images,
        tier: references.some((r) => r.role === "layout") ? "vision" : "fast",
      });
      const user = appendChatRecord(store, req.params.id, {
        role: "user",
        text,
        ...(references.length > 0 ? { references } : {}),
      });
      const outcome = toProposal(
        ctx,
        completion.json,
        references.map((r, i) => ({ ...r, mime: images[i]!.mime })),
        (kind, mime) => generator.acceptsReference(kind, mime),
        typeof activeSlideId === "string" ? activeSlideId : undefined,
        request,
        layoutRead,
        route,
        [...history.flatMap((r) => (r.role === "user" && r.text !== "" ? [r.text] : [])), text],
        awaited?.asksFor ?? [],
      );
      const assistant = appendChatRecord(store, req.params.id, {
        role: "assistant",
        text: "rejected" in outcome ? [outcome.text, outcome.rejected].filter(Boolean).join("\n\n") : outcome.text,
        costCents: completion.costCents,
        ...("actions" in outcome && outcome.actions.length > 0
          ? { proposal: { id: newChatId("prop"), actions: outcome.actions } }
          : {}),
        // A layout with no poster proposed means the model asked something back: the answer keeps the references.
        ...("asksFor" in outcome
          ? { asksFor: outcome.asksFor }
          : "actions" in outcome && outcome.actions.length === 0 && references.some((r) => r.role === "layout")
            ? { asksFor: [] }
            : {}),
      });
      res.json({ records: [user, assistant] });
    } catch (error) {
      if (error instanceof GenerationUnavailableError) return void res.status(503).json({ error: error.message });
      if (error instanceof ChatReferenceError) return void res.status(400).json({ error: error.message });
      handleStoreError(error, res);
    }
  });

  router.post(`${BASE}/references`, (req, res) => {
    try {
      const { name, mime, dataBase64 } = (req.body ?? {}) as { name?: unknown; mime?: unknown; dataBase64?: unknown };
      if (typeof name !== "string" || typeof mime !== "string" || typeof dataBase64 !== "string") {
        return void res.status(400).json({ error: 'Body must be { "name", "mime", "dataBase64" }' });
      }
      const store = open(req.params.slug, req.params.id);
      if (!store) return void res.status(404).json({ error: `No carousel "${req.params.id}"` });
      const normalized = normalizeReference(Buffer.from(dataBase64, "base64"), mime);
      const id = saveReference(store, normalized.mime, normalized.bytes);
      const entry = loadIndex(store.roots.profileDir).entries.find((e) => e.id === id);
      res.json({ reference: { id, name, mime: normalized.mime, w: entry?.w, h: entry?.h } });
    } catch (error) {
      if (error instanceof ChatReferenceError) return void res.status(400).json({ error: error.message });
      handleStoreError(error, res);
    }
  });

  router.post(`${BASE}/proposals/:proposalId/apply`, (req, res) => {
    try {
      const store = open(req.params.slug, req.params.id);
      if (!store) return void res.status(404).json({ error: `No carousel "${req.params.id}"` });
      const log = readChatLog(store, req.params.id);
      const proposal = pendingProposal(log);
      if (proposal?.id !== req.params.proposalId) {
        return void res.status(409).json({ error: messages.proposal.notPending });
      }
      const references = proposalReferences(log, proposal.id);
      const ctx = withReferences(buildChatContext(store, req.params.id), references);
      proposal.actions.forEach((action) => resolveAction(ctx, action));
      const started = appendChatRecord(store, req.params.id, {
        role: "event",
        kind: "started",
        proposalId: proposal.id,
        costCents: 0,
        results: [],
      });
      res.status(202).json({ records: [started] });
      runProposal(store, req.params.id, proposal, getGenerator(req.params.slug), references, rasteriserFor(store, ctx.brand)).catch((error: unknown) =>
        console.error(`Chat proposal ${proposal.id} could not record its outcome:`, error),
      );
    } catch (error) {
      if (error instanceof ChatActionError) return void res.status(409).json({ error: error.message });
      handleStoreError(error, res);
    }
  });

  router.post(`${BASE}/proposals/:proposalId/discard`, (req, res) => {
    try {
      const store = open(req.params.slug, req.params.id);
      if (!store) return void res.status(404).json({ error: `No carousel "${req.params.id}"` });
      if (pendingProposal(readChatLog(store, req.params.id))?.id !== req.params.proposalId) {
        return void res.status(409).json({ error: messages.proposal.notPending });
      }
      const record = appendChatRecord(store, req.params.id, {
        role: "user",
        text: "",
        resolves: { proposalId: req.params.proposalId, decision: "discard" },
      });
      res.json({ records: [record] });
    } catch (error) {
      handleStoreError(error, res);
    }
  });

  return router;
}
