import { z } from "zod";

import type { BrandTokens } from "../../../../system/ig-carousel/brand-schema.js";
import type { CarouselDocument, Slide, SlideObject } from "../../../../system/ig-carousel/carousel-document.js";
import type { LayoutTemplate } from "../../../../system/ig-carousel/layout-template.js";
import type { AssetEntry } from "../../../../system/assets/index.js";
import { removeObject } from "../../../../system/ig-carousel/free-objects.js";
import { messages } from "../messages.js";
import { newChatId } from "./chat-log.js";
import { recreateActionFields } from "./recreate-reference.js";

export const CHAT_ACTION_TYPES = [
  "set_text",
  "set_visual_from_library",
  "generate_visual",
  "add_slide",
  "delete_slide",
  "delete_object",
  "compose_from_reference",
] as const;

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
  z.object({
    type: z.literal("generate_visual"),
    slideId: z.string(),
    slot: z.string().optional(),
    prompt: z.string().min(1),
    kind: z.enum(["background", "character", "photo", "decoration"]),
    why,
  }),
  z.object({ type: z.literal("add_slide"), afterIndex: z.number().int(), kind: z.enum(["cover", "step", "closing"]), why }),
  z.object({ type: z.literal("delete_slide"), slideId: z.string(), why }),
  z.object({ type: z.literal("delete_object"), slideId: z.string(), objectId: z.string().optional(), slot: z.string().optional(), why }),
  z.object({ type: z.literal("compose_from_reference"), ...recreateActionFields, why }),
]);
export type ModelAction = z.infer<typeof modelActionSchema>;

export interface Provenance {
  source:
    | "template"
    | "document"
    | "free"
    | "library"
    | "generation"
    | "reference"
    | "reference_described"
    | "layout_reference"
    | "content_reference"
    | "brand"
    | "request";
  detail: string;
}

export type ChatAction = ModelAction & {
  id: string;
  provenance: Provenance[];
  referenceIds?: string[];
  request?: string;
};

export type LibraryEntry = Pick<AssetEntry, "id" | "kind" | "tags" | "w" | "h"> & { name: string };

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
  if (index === -1) throw new ChatActionError(messages.action.noSuchSlide(slideId));
  return { slide: doc.slides[index]!, number: index + 1 };
}

function templateSlot(ctx: ActionContext, slide: Slide, name: string, type: "text" | "asset") {
  return ctx.template.slides[slide.kind]?.slots.find((s) => s.name === name && s.type === type);
}

function objectTarget(slide: Slide, action: Extract<ModelAction, { type: "delete_object" }>): SlideObject | undefined {
  return slide.objects.find((o) => (action.objectId ? o.id === action.objectId : action.slot !== undefined && o.slot === action.slot));
}

function textTarget(slide: Slide, action: Extract<ModelAction, { type: "set_text" }>): SlideObject | undefined {
  return slide.objects.find(
    (o) => o.kind === "text" && (action.objectId ? o.id === action.objectId : o.slot === action.slot),
  );
}

type VisualAction = Extract<ModelAction, { type: "set_visual_from_library" | "generate_visual" }>;

export function visualSlot(action: VisualAction): string | undefined {
  if (action.slot) return action.slot;
  return action.type === "generate_visual" && action.kind === "background" ? BACKGROUND_SLOT : undefined;
}

export function isFreePlacement(ctx: ActionContext, action: ModelAction): boolean {
  if (action.type !== "generate_visual") return false;
  const slot = visualSlot(action);
  if (slot === BACKGROUND_SLOT) return false;
  const slide = ctx.doc.slides.find((s) => s.id === action.slideId);
  if (!slot || !slide) return true;
  return !slide.objects.some((o) => o.kind === "asset" && o.slot === slot) && !templateSlot(ctx, slide, slot, "asset");
}

export function resolveAction(ctx: ActionContext, action: ModelAction): ChatAction {
  const provenance: Provenance[] = [];
  switch (action.type) {
    case "set_text": {
      const { slide, number } = slideOf(ctx.doc, action.slideId);
      const target = textTarget(slide, action);
      if (target?.pinned) throw new ChatActionError(messages.action.textPinned(number));
      if (target) {
        provenance.push({ source: "document", detail: `${number} · ${target.slot ?? target.id}` });
      } else if (action.slot && templateSlot(ctx, slide, action.slot, "text")) {
        provenance.push({ source: "template", detail: `${ctx.template.id} · ${action.slot}` });
      } else {
        throw new ChatActionError(messages.action.noTextSlot(number));
      }
      provenance.push({ source: "request", detail: action.text });
      break;
    }
    case "set_visual_from_library":
    case "generate_visual": {
      const { slide, number } = slideOf(ctx.doc, action.slideId);
      const slot = visualSlot(action) ?? "";
      if (isFreePlacement(ctx, action)) {
        provenance.push({ source: "free", detail: String(number) });
      } else if (slot === BACKGROUND_SLOT) {
        if (slide.background.pinned) throw new ChatActionError(messages.action.backgroundPinned(number));
        provenance.push({ source: "document", detail: `${number} · ${BACKGROUND_SLOT}` });
      } else {
        const target = slide.objects.find((o) => o.kind === "asset" && o.slot === slot);
        if (target?.pinned) throw new ChatActionError(messages.action.imagePinned(number));
        if (target) provenance.push({ source: "document", detail: `${number} · ${slot}` });
        else if (templateSlot(ctx, slide, slot, "asset"))
          provenance.push({ source: "template", detail: `${ctx.template.id} · ${slot}` });
        else throw new ChatActionError(messages.action.noImageSlot(number, slot));
      }
      if (action.type === "generate_visual") {
        provenance.push({ source: "generation", detail: action.prompt });
        break;
      }
      const asset = ctx.library.find((a) => a.id === action.assetId);
      if (!asset) throw new ChatActionError(messages.action.notInLibrary(action.assetId));
      provenance.push({ source: "library", detail: [asset.name, ...asset.tags].join(" · ") });
      break;
    }
    case "add_slide": {
      if (action.afterIndex < -1 || action.afterIndex >= ctx.doc.slides.length) {
        throw new ChatActionError(messages.action.noInsertPosition(action.afterIndex + 2));
      }
      provenance.push(
        ctx.template.slides[action.kind]
          ? { source: "template", detail: `${ctx.template.id} · ${action.kind}` }
          : { source: "request", detail: action.kind },
      );
      provenance.push({ source: "brand", detail: `surface · ${ctx.brand.roles.surface}` });
      break;
    }
    case "delete_object": {
      const { slide, number } = slideOf(ctx.doc, action.slideId);
      const target = objectTarget(slide, action);
      if (!target) throw new ChatActionError(messages.action.noSuchObject(number));
      if (target.locked) {
        throw new ChatActionError(messages.action.objectLocked(number));
      }
      provenance.push({ source: "document", detail: `${number} · ${target.slot ?? target.id} · ${target.kind}` });
      break;
    }
    case "compose_from_reference": {
      if (action.slideId) slideOf(ctx.doc, action.slideId);
      for (const r of action.replacements) provenance.push({ source: "content_reference", detail: `${r.what}: ${r.text}` });
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

export function applyAction(ctx: ActionContext, action: ChatAction): { document: CarouselDocument; slideIds: string[] } {
  resolveAction(ctx, action);
  let doc = ctx.doc;
  let slideIds = "slideId" in action && action.slideId ? [action.slideId] : [];
  switch (action.type) {
    case "generate_visual":
      throw new ChatActionError("generate_visual must be applied through image generation.");
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
    case "compose_from_reference":
      throw new ChatActionError("compose_from_reference must be applied through image generation.");
    case "delete_object": {
      const slide = doc.slides.find((s) => s.id === action.slideId)!;
      doc = removeObject(doc, action.slideId, objectTarget(slide, action)!.id);
      break;
    }
  }
  return { document: { ...doc, updatedAt: new Date().toISOString() }, slideIds };
}
