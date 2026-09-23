import { z } from "zod";

import type { BrandTokens } from "../../../../system/ig-carousel/brand-schema.js";
import type { CarouselDocument, Slide, SlideObject } from "../../../../system/ig-carousel/carousel-document.js";
import type { LayoutTemplate } from "../../../../system/ig-carousel/layout-template.js";
import type { AssetEntry } from "../../../../system/assets/index.js";
import { newChatId } from "./chat-log.js";

export const CHAT_ACTION_TYPES = ["set_text", "set_visual_from_library", "add_slide", "delete_slide"] as const;

const why = z.string().default("");
export const modelActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("set_text"),
    slideId: z.string(),
    objectId: z.string().optional(),
    slot: z.string().optional(),
    text: z.string(),
    why,
  }),
  z.object({ type: z.literal("set_visual_from_library"), slideId: z.string(), slot: z.string(), assetId: z.string(), why }),
  z.object({ type: z.literal("add_slide"), afterIndex: z.number().int(), kind: z.enum(["cover", "step", "closing"]), why }),
  z.object({ type: z.literal("delete_slide"), slideId: z.string(), why }),
]);
export type ModelAction = z.infer<typeof modelActionSchema>;

export interface Provenance {
  source: "template" | "document" | "library" | "brand" | "request";
  detail: string;
}

export type ChatAction = ModelAction & { id: string; provenance: Provenance[] };

export type LibraryEntry = Pick<AssetEntry, "id" | "kind" | "tags" | "w" | "h">;

export const BACKGROUND_SLOT = "background";

export interface ActionContext {
  doc: CarouselDocument;
  template: LayoutTemplate;
  library: LibraryEntry[];
  brand: BrandTokens;
}

export class ChatActionError extends Error {}

function slideOf(doc: CarouselDocument, slideId: string): { slide: Slide; number: number } {
  const index = doc.slides.findIndex((s) => s.id === slideId);
  if (index === -1) throw new ChatActionError(`La lámina "${slideId}" no existe en el carrusel.`);
  return { slide: doc.slides[index]!, number: index + 1 };
}

function templateSlot(ctx: ActionContext, slide: Slide, name: string, type: "text" | "asset") {
  return ctx.template.slides[slide.kind]?.slots.find((s) => s.name === name && s.type === type);
}

function textTarget(slide: Slide, action: Extract<ModelAction, { type: "set_text" }>): SlideObject | undefined {
  return slide.objects.find(
    (o) => o.kind === "text" && (action.objectId ? o.id === action.objectId : o.slot === action.slot),
  );
}

/** Checks one action against the current document and derives where each part of it comes from. */
export function resolveAction(ctx: ActionContext, action: ModelAction): ChatAction {
  const provenance: Provenance[] = [];
  switch (action.type) {
    case "set_text": {
      const { slide, number } = slideOf(ctx.doc, action.slideId);
      const target = textTarget(slide, action);
      if (target?.pinned) throw new ChatActionError(`El texto de la lámina ${number} está fijado.`);
      if (target) {
        provenance.push({ source: "document", detail: `${number} · ${target.slot ?? target.id}` });
      } else if (action.slot && templateSlot(ctx, slide, action.slot, "text")) {
        provenance.push({ source: "template", detail: `${ctx.template.id} · ${action.slot}` });
      } else {
        throw new ChatActionError(`La lámina ${number} no tiene ese espacio de texto.`);
      }
      provenance.push({ source: "request", detail: action.text });
      break;
    }
    case "set_visual_from_library": {
      const { slide, number } = slideOf(ctx.doc, action.slideId);
      const asset = ctx.library.find((a) => a.id === action.assetId);
      if (!asset) throw new ChatActionError(`La imagen "${action.assetId}" no está aprobada en la biblioteca.`);
      if (action.slot === BACKGROUND_SLOT) {
        if (slide.background.pinned) throw new ChatActionError(`El fondo de la lámina ${number} está fijado.`);
        provenance.push({ source: "document", detail: `${number} · ${BACKGROUND_SLOT}` });
      } else {
        const target = slide.objects.find((o) => o.kind === "asset" && o.slot === action.slot);
        if (target?.pinned) throw new ChatActionError(`La imagen de la lámina ${number} está fijada.`);
        if (target) provenance.push({ source: "document", detail: `${number} · ${action.slot}` });
        else if (templateSlot(ctx, slide, action.slot, "asset"))
          provenance.push({ source: "template", detail: `${ctx.template.id} · ${action.slot}` });
        else throw new ChatActionError(`La lámina ${number} no tiene el espacio de imagen "${action.slot}".`);
      }
      provenance.push({ source: "library", detail: [asset.id, asset.kind, ...asset.tags].join(" · ") });
      break;
    }
    case "add_slide": {
      if (action.afterIndex < -1 || action.afterIndex >= ctx.doc.slides.length) {
        throw new ChatActionError(`No hay una posición ${action.afterIndex + 2} donde insertar la lámina.`);
      }
      provenance.push(
        ctx.template.slides[action.kind]
          ? { source: "template", detail: `${ctx.template.id} · ${action.kind}` }
          : { source: "request", detail: action.kind },
      );
      provenance.push({ source: "brand", detail: `surface · ${ctx.brand.roles.surface}` });
      break;
    }
    case "delete_slide": {
      const { number } = slideOf(ctx.doc, action.slideId);
      provenance.push({ source: "document", detail: String(number) });
      break;
    }
  }
  return { ...action, id: newChatId("act"), provenance };
}

function replaceSlide(doc: CarouselDocument, slideId: string, fn: (slide: Slide) => Slide): CarouselDocument {
  return { ...doc, slides: doc.slides.map((s) => (s.id === slideId ? fn(s) : s)) };
}

/** Pure: returns a new document with only the named pieces changed, plus the slide ids each action touched. */
export function applyActions(
  ctx: ActionContext,
  actions: ChatAction[],
): { document: CarouselDocument; results: Array<{ actionId: string; slideIds: string[] }> } {
  let doc = ctx.doc;
  const results: Array<{ actionId: string; slideIds: string[] }> = [];
  for (const action of actions) {
    resolveAction({ ...ctx, doc }, action);
    let slideIds = "slideId" in action ? [action.slideId] : [];
    switch (action.type) {
      case "set_text":
        doc = replaceSlide(doc, action.slideId, (slide) => {
          const target = textTarget(slide, action);
          if (target) {
            return { ...slide, objects: slide.objects.map((o) => (o === target ? { ...o, text: action.text } : o)) };
          }
          const added: SlideObject = {
            id: newChatId(`obj-${slide.id}-text`),
            slot: action.slot!,
            kind: "text",
            text: action.text,
            pinned: false,
            locked: false,
            source: "ai",
          };
          return { ...slide, objects: [...slide.objects, added] };
        });
        break;
      case "set_visual_from_library":
        doc = replaceSlide(doc, action.slideId, (slide) => {
          if (action.slot === BACKGROUND_SLOT) {
            const background = { mode: "asset" as const, assetId: action.assetId, pinned: false, source: "library" as const };
            return { ...slide, background };
          }
          const target = slide.objects.find((o) => o.kind === "asset" && o.slot === action.slot);
          if (target) {
            const { pending: _p, awaitingImage: _a, suggestion: _s, ...rest } = target;
            const next = { ...rest, assetId: action.assetId, source: "library" as const };
            return { ...slide, objects: slide.objects.map((o) => (o === target ? next : o)) };
          }
          const slot = templateSlot(ctx, slide, action.slot, "asset");
          const added: SlideObject = {
            id: newChatId(`obj-${slide.id}-lib`),
            slot: action.slot,
            kind: "asset",
            assetId: action.assetId,
            fit: (slot && "fit" in slot && slot.fit) || "cover",
            pinned: false,
            locked: false,
            source: "library",
          };
          return { ...slide, objects: [...slide.objects, added] };
        });
        break;
      case "add_slide": {
        const slide: Slide = {
          id: newChatId("slide"),
          kind: action.kind,
          background: { mode: "color", colorKey: ctx.brand.roles.surface, pinned: false, source: "manual" },
          objects: [],
        };
        const slides = [...doc.slides];
        slides.splice(action.afterIndex + 1, 0, slide);
        doc = { ...doc, slides };
        slideIds = [slide.id];
        break;
      }
      case "delete_slide":
        doc = { ...doc, slides: doc.slides.filter((s) => s.id !== action.slideId) };
        break;
    }
    results.push({ actionId: action.id, slideIds });
  }
  return { document: { ...doc, updatedAt: new Date().toISOString() }, results };
}
