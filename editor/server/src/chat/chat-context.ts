import { basename } from "node:path";

import { loadBrand, type BrandTokens } from "../../../../system/ig-carousel/brand-schema.js";
import type { CarouselDocument } from "../../../../system/ig-carousel/carousel-document.js";
import type { LayoutTemplate } from "../../../../system/ig-carousel/layout-template.js";
import { loadIndex } from "../../../../system/assets/index.js";

import { readValidatedDocument } from "../document-store.js";
import type { ProfileStore } from "../profile-store.js";
import { resolveDocumentTemplate } from "../template-resolve.js";
import { CHAT_ACTION_TYPES, type LibraryEntry } from "./chat-actions.js";
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
    .filter((entry) => entry.status === "approved" && entry.kind !== "font")
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
  "Reference images attached to the message are what the owner wants the picture to look like: describe what matters in them inside the generate_visual prompt.",
  "Use only slide ids, object ids and slots present in the document or template, and only asset ids from the library. Pinned pieces must not be changed or replaced (they are kept from regeneration), but the owner may delete them with delete_object. Locked pieces cannot be deleted either.",
  "An image object whose assetKind is missing or is not a picture (e.g. font) shows as a broken image.",
  "If the request needs something outside the allowed actions (e.g. moving or restyling a piece), return no actions and say so plainly in `text`.",
  "Slides are numbered from 1 in the order given. Write `text` and `why` in the owner's language, briefly, addressing the owner directly (second person).",
  'Respond ONLY with JSON: {"text":string,"actions":[...]}.',
].join("\n");

export function chatInput(ctx: ChatContext, history: ChatRecord[], text: string, referenceNames: string[]): string {
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
  return JSON.stringify({ document: { title: ctx.doc.title, slides }, template, library: ctx.library, history: recent, message: text, references: referenceNames });
}
