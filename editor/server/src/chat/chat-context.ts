import { basename } from "node:path";

import { loadBrand, type BrandTokens } from "../../../../system/ig-carousel/brand-schema.js";
import type { CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";
import type { LayoutTemplate } from "../../../../system/ig-carousel/layout-template.js";
import { loadIndex } from "../../../../system/assets/index.js";

import { readValidatedDocument } from "../document-store.js";
import type { ProfileStore } from "../profile-store.js";
import { resolveDocumentTemplate } from "../template-resolve.js";
import { CHAT_ACTION_TYPES, type LibraryEntry } from "./chat-actions.js";
import { TEXT_ZONES, type NumberedLine } from "./recreate-reference.js";
import type { ChatRecord } from "./chat-log.js";

export interface ChatContext {
  doc: CarouselDocument;
  template: LayoutTemplate;
  brand: BrandTokens;
  library: LibraryEntry[];
  assetKinds: Map<string, string>;
}

export function buildChatContext(store: ProfileStore, carouselId: string): ChatContext {
  const brand = loadBrand(store.roots.profileDir);
  const doc = readValidatedDocument(store, carouselId);
  const entries = loadIndex(store.roots.profileDir).entries;
  const assetKinds = new Map(entries.map((entry) => [entry.id, entry.kind]));
  const library = entries
    .filter((entry) => entry.status === "approved" && entry.origin !== "reference" && entry.mime.startsWith("image/"))
    .map(({ id, kind, tags, w, h, path }) => ({ id, name: basename(path), kind, tags, w, h }));
  return { doc, template: resolveDocumentTemplate(store, brand, doc), brand, library, assetKinds };
}

export const CHAT_INSTRUCTIONS = [
  "You edit an existing carousel for its owner, one correction at a time.",
  "The owner approves most of what exists and corrects parts. Change ONLY what the latest message asks for; never touch other slides or other pieces of the named slide.",
  "If the message queues several corrections, propose only the first one and say in `text` which one comes next.",
  `Allowed action types, and no others: ${CHAT_ACTION_TYPES.join(", ")}.`,
  'Shapes: {"type":"set_text","slideId","objectId"?,"slot"?,"text","why"} | {"type":"set_visual_from_library","slideId","slot","assetId","why"} | {"type":"generate_visual","slideId","slot"?,"prompt","kind":"background"|"character"|"photo"|"decoration","why"} | {"type":"add_slide","afterIndex","kind":"cover"|"step"|"closing","why"} (afterIndex -1 inserts first) | {"type":"delete_slide","slideId","why"} | {"type":"delete_object","slideId","objectId"?,"slot"?,"why"} (removes one object; say which in why). Visual slot "background" is the slide background.',
  "For an image: reuse a library asset only when its file name or tags clearly match what was asked. If none clearly matches, use generate_visual; never pick an unrelated asset. A generate_visual prompt describes the picture concretely (subject, composition, light, palette) and never asks for text, letters or logos.",
  "An object the owner wants on the slide (a chair, a person, a plant) is a generate_visual with no slot and kind character, photo or decoration: it is generated without background and placed loose on the slide, so its prompt describes only the subject itself: no room, scene, floor or shadow. Use slot \"background\" only when the owner asks for the slide background.",
  `References come with a role, in the same order as the attached images. A "layout" reference IS the poster the owner wants reproduced; a "content" reference brings the new event (its picture and data). When the owner asks to make the poster with the new event, answer with exactly one compose_from_reference action and nothing else: {"type":"compose_from_reference","texts":[{"line"?,"zone","text","from","original"?,"box"?}],"why"}. The image provider repaints the poster without its texts; every text you list is then placed on top as an editable text.`,
  `layoutLines, when present, are the layout reference's text lines as measured by OCR outside its framed picture, each with its line number. Give exactly one entry for EVERY line in layoutLines, in order, with line its number: texts has as many entries as layoutLines. zone "logo" is the brand logo and zone "picture" is a text printed inside the framed picture: both stay as they are, with text empty. Every other line gets a zone among ${TEXT_ZONES.join(", ")}, by what that line says on the layout reference: a field label (a short word naming the value below or beside it) is zone "label" and keeps its text with from "layout"; a value takes the same kind of data from the content reference (the place line gets the new place, the time line the new time) with from "content", or keeps its current text with from "layout" when the content reference does not carry that data. Never move data between lines and never merge several data into one line. The chip is the category word, the title is the event's name, never the venue or the organiser. Without layoutLines, give box (fractions of the layout reference, from its top-left) and original (the text it replaces) for each text. Never invent data that is not legible in the content reference, and omit slideId.`,
  "Without a layout reference, a content reference can be placed with set_visual_from_library using its id from the library and its texts applied with set_text.",
  "Reference images attached to the message are what the owner wants the picture to look like: describe what matters in them inside the generate_visual prompt.",
  "Use only slide ids, object ids and slots present in the document or template, and only asset ids from the library. Pinned pieces must not be changed or replaced (they are kept from regeneration), but the owner may delete them with delete_object. Locked pieces cannot be deleted either.",
  "An image object whose assetKind is missing or is not a picture (e.g. font) shows as a broken image.",
  "If the request needs something outside the allowed actions (e.g. moving or restyling a piece), return no actions and say so plainly in `text`.",
  "Slides are numbered from 1 in the order given. Write `text` and `why` in the owner's language, briefly, addressing the owner directly (second person).",
  'Respond ONLY with JSON: {"text":string,"actions":[...]}.',
].join("\n");

export function chatInput(
  ctx: ChatContext,
  history: ChatRecord[],
  text: string,
  references: Array<{ name: string; role: string }>,
  layoutLines?: NumberedLine[],
): string {
  const slides = ctx.doc.slides.map((slide, index) => ({
    number: index + 1,
    id: slide.id,
    kind: slide.kind,
    background: slide.background,
    objects: slide.objects.map(({ id, slot, kind, pinned, locked, ...rest }) => ({
      id,
      slot,
      kind,
      pinned,
      locked,
      ...("text" in rest
        ? { text: rest.text }
        : { assetId: rest.assetId, assetKind: rest.assetId ? (ctx.assetKinds.get(rest.assetId) ?? "missing") : undefined }),
    })),
  }));
  const template = {
    id: ctx.template.id,
    slots: Object.fromEntries(
      Object.entries(ctx.template.slides).map(([kind, def]) => [kind, def.slots.map((s) => ({ name: s.name, type: s.type }))]),
    ),
  };
  const recent = history.slice(-12).map((r) =>
    r.role === "event" ? { role: "event", applied: r.proposalId } : { role: r.role, text: r.text },
  );
  return JSON.stringify({ document: { title: ctx.doc.title, slides }, template, library: ctx.library, history: recent, message: text, references,
    ...(layoutLines ? { layoutLines } : {}) });
}
