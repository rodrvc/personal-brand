import { Router } from "express";

import type { CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";

import { GenerationUnavailableError, type PieceGenerator } from "../ai/piece-generator.js";
import { readProfileCurrency } from "../../../../system/ig-carousel/profile.js";
import { generateForSlot } from "../compose/planner.js";
import { addFreeAssetObject } from "../../../../system/ig-carousel/free-objects.js";
import { applyAction, ChatActionError, isFreePlacement, visualSlot, type ChatAction, CHAT_ACTION_TYPES, modelActionSchema, resolveAction } from "../chat/chat-actions.js";
import { buildChatContext, chatInput, CHAT_INSTRUCTIONS } from "../chat/chat-context.js";
import { appendChatRecord, newChatId, pendingProposal, readChatLog, type ChatRecord } from "../chat/chat-log.js";
import { ChatReferenceError, loadReferenceImages, saveReference, type ChatReference } from "../chat/chat-references.js";
import { documentExists, readValidatedDocument, snapshotDocument, validateAgainstProfile, writeDocument } from "../document-store.js";
import { ProfileStore } from "../profile-store.js";
import { attachGeneratedAsset, readGeneratedAssetCostCents } from "./compose.js";
import { handleStoreError } from "./profiles.js";

const BASE = "/api/profiles/:slug/carousels/:id/chat";

/** Deleted slides have nothing to hold; every other named slide must carry each asset the action produced. */
function isPlaced(doc: CarouselDocument, slideId: string, assetIds: string[]): boolean {
  const slide = doc.slides.find((s) => s.id === slideId);
  if (!slide) return assetIds.length === 0;
  const held = new Set([slide.background.mode === "asset" ? slide.background.assetId : undefined, ...slide.objects.map((o) => (o.kind === "asset" ? o.assetId : undefined))]);
  return assetIds.every((id) => held.has(id));
}

/** Turns the model's raw JSON into either a checked proposal or the reason it was refused. */
function toProposal(
  ctx: ReturnType<typeof buildChatContext>,
  raw: unknown,
  references: Array<ChatReference & { mime: string }>,
  accepts: PieceGenerator["acceptsReference"],
): { text: string; rejected: string } | { text: string; actions: ChatAction[] } {
  const body = (raw ?? {}) as { text?: unknown; actions?: unknown };
  const text = typeof body.text === "string" ? body.text : "";
  const rawActions = Array.isArray(body.actions) ? body.actions : [];
  const unknownType = rawActions
    .map((a) => (a as { type?: unknown })?.type)
    .find((type) => !CHAT_ACTION_TYPES.includes(type as (typeof CHAT_ACTION_TYPES)[number]));
  if (unknownType !== undefined) {
    return { text, rejected: `La propuesta pedía «${String(unknownType)}», que este chat todavía no puede hacer. No se propone nada.` };
  }
  try {
    const actions = rawActions.map((a) => {
      const action = resolveAction(ctx, modelActionSchema.parse(a));
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
    const reason = error instanceof ChatActionError ? error.message : "La propuesta vino mal formada.";
    return { text, rejected: `${reason} No se propone nada.` };
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
      const { text, references = [] } = (req.body ?? {}) as { text?: unknown; references?: ChatReference[] };
      const wellFormed = (r: unknown) =>
        typeof (r as ChatReference)?.id === "string" && typeof (r as ChatReference)?.name === "string";
      if (typeof text !== "string" || text.trim() === "" || !Array.isArray(references) || !references.every(wellFormed)) {
        return void res.status(400).json({ error: 'Body must be { "text": string, "references"?: [{ id, name }] }' });
      }
      const store = open(req.params.slug, req.params.id);
      if (!store) return void res.status(404).json({ error: `No carousel "${req.params.id}"` });

      const ctx = buildChatContext(store, req.params.id);
      const history = readChatLog(store, req.params.id);
      const generator = getGenerator(req.params.slug);
      const images = loadReferenceImages(store, references.map((r) => r.id));
      const completion = await generator.completeJson({
        instructions: CHAT_INSTRUCTIONS,
        input: chatInput(ctx, history, text, references.map((r) => r.name)),
        images,
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
      const id = saveReference(store, mime, Buffer.from(dataBase64, "base64"));
      res.json({ reference: { id, name } });
    } catch (error) {
      if (error instanceof ChatReferenceError) return void res.status(400).json({ error: error.message });
      handleStoreError(error, res);
    }
  });

  router.post(`${BASE}/proposals/:proposalId/apply`, async (req, res) => {
    try {
      const store = open(req.params.slug, req.params.id);
      if (!store) return void res.status(404).json({ error: `No carousel "${req.params.id}"` });
      const proposal = pendingProposal(readChatLog(store, req.params.id));
      if (proposal?.id !== req.params.proposalId) {
        return void res.status(409).json({ error: "Esa propuesta ya no está pendiente." });
      }

      const ctx = buildChatContext(store, req.params.id);
      proposal.actions.forEach((action) => resolveAction(ctx, action));
      let document = ctx.doc;
      const results: Extract<ChatRecord, { role: "event" }>["results"] = [];
      const spent = () => results.reduce((sum, r) => sum + (r.costCents ?? 0), 0);
      try {
        for (const action of proposal.actions) {
          if (action.type === "generate_visual") {
            resolveAction({ ...ctx, doc: document }, action);
            const free = isFreePlacement({ ...ctx, doc: document }, action);
            const slot = visualSlot(action);
            const entry = await generateForSlot(store, getGenerator(req.params.slug), {
              prompt: action.prompt,
              kind: action.kind,
              canvas: document.canvas,
              carouselId: req.params.id,
              slot: free || !slot ? "free" : slot,
              referenceAssetIds: action.referenceIds,
            });
            const slideIndex = document.slides.findIndex((s) => s.id === action.slideId);
            document =
              free || !slot
                ? addFreeAssetObject(document, action.slideId, {
                    id: newChatId(`obj-${action.slideId}-ai`),
                    assetId: entry.id,
                    source: "ai",
                    fit: "contain",
                  })
                : attachGeneratedAsset(ctx.brand, document, slideIndex, slot, entry.id);
            const costCents = readGeneratedAssetCostCents(store, entry.id);
            results.push({ actionId: action.id, slideIds: [action.slideId], assetIds: [entry.id], costCents });
          } else {
            const applied = applyAction({ ...ctx, doc: document }, action);
            document = applied.document;
            results.push({ actionId: action.id, slideIds: applied.slideIds });
          }
        }
        const validation = validateAgainstProfile(store, document);
        if (validation.valid) {
          document = validation.document;
        } else {
          const [first] = validation.errors;
          throw new ChatActionError(`El resultado no es válido en "${first!.path}": ${first!.message}`);
        }
      } catch (error) {
        appendChatRecord(store, req.params.id, {
          role: "event",
          kind: "failed",
          proposalId: proposal.id,
          error: (error as Error)?.message ?? String(error),
          costCents: spent(),
          results,
        });
        throw error;
      }
      const documentVersion = snapshotDocument(store, req.params.id);
      writeDocument(store, document);
      const written = readValidatedDocument(store, req.params.id);
      const missing = results.find((r) => !r.slideIds.every((id) => isPlaced(written, id, r.assetIds ?? [])));
      if (missing) {
        const error = `La acción ${missing.actionId} no quedó en el documento guardado.`;
        const failure = appendChatRecord(store, req.params.id, {
          role: "event",
          kind: "failed",
          proposalId: proposal.id,
          error,
          costCents: spent(),
          results,
        });
        return void res.status(500).json({ error, records: [failure] });
      }
      const event = appendChatRecord(store, req.params.id, {
        role: "event",
        kind: "applied",
        proposalId: proposal.id,
        documentVersion,
        costCents: spent(),
        results,
      });
      res.json({ document: written, records: [event] });
    } catch (error) {
      if (error instanceof ChatActionError) return void res.status(409).json({ error: error.message });
      if (error instanceof GenerationUnavailableError) return void res.status(503).json({ error: error.message });
      handleStoreError(error, res);
    }
  });

  router.post(`${BASE}/proposals/:proposalId/discard`, (req, res) => {
    try {
      const store = open(req.params.slug, req.params.id);
      if (!store) return void res.status(404).json({ error: `No carousel "${req.params.id}"` });
      if (pendingProposal(readChatLog(store, req.params.id))?.id !== req.params.proposalId) {
        return void res.status(409).json({ error: "Esa propuesta ya no está pendiente." });
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
