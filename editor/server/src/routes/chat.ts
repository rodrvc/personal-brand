import { Router } from "express";

import { GenerationUnavailableError, type PieceGenerator } from "../ai/piece-generator.js";
import { applyActions, ChatActionError, type ChatAction, CHAT_ACTION_TYPES, modelActionSchema, resolveAction } from "../chat/chat-actions.js";
import { buildChatContext, chatInput, CHAT_INSTRUCTIONS } from "../chat/chat-context.js";
import { appendChatRecord, newChatId, pendingProposal, readChatLog } from "../chat/chat-log.js";
import { documentExists, snapshotDocument, validateAgainstProfile, writeDocument } from "../document-store.js";
import { ProfileStore } from "../profile-store.js";
import { handleStoreError } from "./profiles.js";

const BASE = "/api/profiles/:slug/carousels/:id/chat";

/** Turns the model's raw JSON into either a checked proposal or the reason it was refused. */
function toProposal(
  ctx: ReturnType<typeof buildChatContext>,
  raw: unknown,
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
    const actions = rawActions.map((a) => resolveAction(ctx, modelActionSchema.parse(a)));
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
      res.json({ records: log, pendingProposalId: pendingProposal(log)?.id ?? null });
    } catch (error) {
      handleStoreError(error, res);
    }
  });

  router.post(`${BASE}/messages`, async (req, res) => {
    try {
      const text = (req.body as { text?: unknown })?.text;
      if (typeof text !== "string" || text.trim() === "") {
        return void res.status(400).json({ error: 'Body must be { "text": string }' });
      }
      const store = open(req.params.slug, req.params.id);
      if (!store) return void res.status(404).json({ error: `No carousel "${req.params.id}"` });

      const ctx = buildChatContext(store, req.params.id);
      const history = readChatLog(store, req.params.id);
      const completion = await getGenerator(req.params.slug).completeJson({
        instructions: CHAT_INSTRUCTIONS,
        input: chatInput(ctx, history, text),
      });
      const user = appendChatRecord(store, req.params.id, { role: "user", text });
      const outcome = toProposal(ctx, completion.json);
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
      handleStoreError(error, res);
    }
  });

  router.post(`${BASE}/proposals/:proposalId/apply`, (req, res) => {
    try {
      const store = open(req.params.slug, req.params.id);
      if (!store) return void res.status(404).json({ error: `No carousel "${req.params.id}"` });
      const proposal = pendingProposal(readChatLog(store, req.params.id));
      if (proposal?.id !== req.params.proposalId) {
        return void res.status(409).json({ error: "Esa propuesta ya no está pendiente." });
      }

      const { document, results } = applyActions(buildChatContext(store, req.params.id), proposal.actions);
      const validation = validateAgainstProfile(store, document);
      if (!validation.valid) {
        return void res.status(422).json({ error: "The result failed validation", details: validation.errors });
      }
      const documentVersion = snapshotDocument(store, req.params.id);
      writeDocument(store, validation.document);
      const event = appendChatRecord(store, req.params.id, {
        role: "event",
        kind: "applied",
        proposalId: proposal.id,
        documentVersion,
        results,
      });
      res.json({ document: validation.document, records: [event] });
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
