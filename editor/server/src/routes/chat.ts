import { Router } from "express";
import { z } from "zod";

import type { CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";

import { GenerationUnavailableError, type PieceGenerator } from "../ai/piece-generator.js";
import { readProfileCurrency } from "../../../../system/ig-carousel/profile.js";
import { loadIndex } from "../../../../system/assets/index.js";
import { generateForSlot } from "../compose/planner.js";
import { addFreeAssetObject } from "../../../../system/ig-carousel/free-objects.js";
import { applyAction, ChatActionError, isFreePlacement, visualSlot, type ChatAction, CHAT_ACTION_TYPES, modelActionSchema, resolveAction } from "../chat/chat-actions.js";
import { buildChatContext, chatInput, CHAT_INSTRUCTIONS } from "../chat/chat-context.js";
import { appendChatRecord, newChatId, pendingProposal, readChatLog, type ChatProposal, type ChatRecord } from "../chat/chat-log.js";
import { placeFullSlideImage, recreatePrompt } from "../chat/recreate-reference.js";
import { ChatReferenceError, loadReferenceImages, normalizeReference, saveReference, type ChatReference } from "../chat/chat-references.js";
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

function proposeRecreation(
  ctx: ReturnType<typeof buildChatContext>,
  action: Extract<ChatAction, { type: "compose_from_reference" }>,
  references: Array<ChatReference & { mime: string }>,
  accepts: PieceGenerator["acceptsReference"],
  activeSlideId: string | undefined,
  request: string,
): ChatAction {
  const layout = references.find((r) => r.role === "layout");
  if (!layout) throw new ChatActionError(messages.proposal.needsLayoutReference);
  const content = references.find((r) => r.role === "content");
  const contentAsImage = content !== undefined && accepts("background", content.mime);
  const fallback = ctx.doc.slides.some((s) => s.id === activeSlideId) ? activeSlideId : ctx.doc.slides[0]?.id;
  const named = (p: ChatAction["provenance"][number]) => (p.source === "content_reference" && content ? { ...p, detail: `${content.name} · ${p.detail}` } : p);
  return {
    ...action,
    slideId: action.slideId ?? fallback,
    referenceIds: [layout.id, ...(contentAsImage ? [content!.id] : [])],
    request,
    provenance: [
      { source: "layout_reference", detail: layout.name },
      ...(content ? [{ source: contentAsImage ? ("content_reference" as const) : ("reference_described" as const), detail: content.name }] : []),
      ...action.provenance.map(named),
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
): { text: string; rejected: string } | { text: string; actions: ChatAction[] } {
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
      if (action.type === "compose_from_reference") return proposeRecreation(ctx, action, references, accepts, activeSlideId, request);
      if (action.type !== "generate_visual") return action;
      const asImage = references.filter((r) => accepts(action.kind, r.mime));
      const fromReferences = references.map((r) => ({
        source: asImage.includes(r) ? ("reference" as const) : ("reference_described" as const),
        detail: r.name,
      }));
      const referenceIds = asImage.map((r) => r.id);
      return { ...action, provenance: [...action.provenance, ...fromReferences], ...(referenceIds.length > 0 ? { referenceIds } : {}) };
    });
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

function generationFor(action: ChatAction): GenerationRequest | undefined {
  if (action.type === "compose_from_reference") {
    return {
      prompt: recreatePrompt(action.request ?? "", action.replacements, (action.referenceIds?.length ?? 0) > 1),
      kind: "background",
      slot: "reference",
      referenceAssetIds: action.referenceIds,
      mode: "reproduce",
    };
  }
  if (action.type === "generate_visual") {
    return { prompt: action.prompt, kind: action.kind, slot: visualSlot(action) ?? "free", referenceAssetIds: action.referenceIds };
  }
  return undefined;
}

type EventResults = Extract<ChatRecord, { role: "event" }>["results"];

async function runProposal(
  store: ProfileStore,
  carouselId: string,
  proposal: ChatProposal,
  generator: PieceGenerator,
  references: ChatReference[],
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
    const canvas = readValidatedDocument(store, carouselId).canvas;
    for (const action of proposal.actions) {
      const spec = generationFor(action);
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
        const slide = placeFullSlideImage(existing, assetId, document.canvas, ctx.brand);
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

export function chatRouter(getGenerator: (slug: string) => PieceGenerator): Router {
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
      const { text, references = [], activeSlideId } = (req.body ?? {}) as {
        text?: unknown;
        references?: ChatReference[];
        activeSlideId?: string;
      };
      const wellFormed = (r: unknown) =>
        typeof (r as ChatReference)?.id === "string" && typeof (r as ChatReference)?.name === "string";
      if (typeof text !== "string" || text.trim() === "" || !Array.isArray(references) || !references.every(wellFormed)) {
        return void res.status(400).json({ error: 'Body must be { "text": string, "references"?: [{ id, name }] }' });
      }
      const store = open(req.params.slug, req.params.id);
      if (!store) return void res.status(404).json({ error: `No carousel "${req.params.id}"` });

      const ctx = withReferences(buildChatContext(store, req.params.id), references);
      const history = readChatLog(store, req.params.id);
      const generator = getGenerator(req.params.slug);
      const images = loadReferenceImages(store, references.map((r) => r.id));
      const completion = await generator.completeJson({
        instructions: CHAT_INSTRUCTIONS,
        input: chatInput(ctx, history, text, references.map((r) => ({ name: r.name, role: r.role ?? "content" }))),
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
        text,
      );
      const assistant = appendChatRecord(store, req.params.id, {
        role: "assistant",
        text: "rejected" in outcome ? [outcome.text, outcome.rejected].filter(Boolean).join("\n\n") : outcome.text,
        costCents: completion.costCents,
        ...("actions" in outcome && outcome.actions.length > 0
          ? { proposal: { id: newChatId("prop"), actions: outcome.actions } }
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
      runProposal(store, req.params.id, proposal, getGenerator(req.params.slug), references).catch((error: unknown) =>
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
