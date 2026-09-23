import type { CarouselDocument, ChatAction, Provenance } from "../api/types";
import { t } from "../i18n";

const BACKGROUND_SLOT = "background";

function slideNumber(doc: CarouselDocument, slideId: string): number {
  return doc.slides.findIndex((s) => s.id === slideId) + 1;
}

function pieceName(slot: string | undefined): string {
  return slot === BACKGROUND_SLOT ? t("chat.piece.background") : (slot ?? t("chat.piece.text"));
}

export function describeAction(doc: CarouselDocument, action: ChatAction): string {
  switch (action.type) {
    case "set_text":
      return t("chat.action.setText", { n: slideNumber(doc, action.slideId), piece: pieceName(action.slot), text: action.text });
    case "set_visual_from_library":
      return t("chat.action.setVisual", { n: slideNumber(doc, action.slideId), piece: pieceName(action.slot) });
    case "add_slide":
      return action.afterIndex < 0
        ? t("chat.action.addSlideFirst", { kind: t(`chat.kind.${action.kind}`) })
        : t("chat.action.addSlide", { kind: t(`chat.kind.${action.kind}`), n: action.afterIndex + 1 });
    case "delete_slide":
      return t("chat.action.deleteSlide", { n: slideNumber(doc, action.slideId) });
  }
}

export function describeProvenance(p: Provenance): string {
  return t(`chat.provenance.${p.source}`, { detail: p.detail });
}

/** What the proposal leaves alone: every slide it never names, and every piece of a named slide except the one it changes. */
export function describeIntact(doc: CarouselDocument, actions: ChatAction[]): string[] {
  const changedPieces = new Map<string, string[]>();
  const deleted = new Set<string>();
  for (const action of actions) {
    if (action.type === "delete_slide") deleted.add(action.slideId);
    if (action.type === "set_text" || action.type === "set_visual_from_library") {
      const pieces = changedPieces.get(action.slideId) ?? [];
      changedPieces.set(action.slideId, [...pieces, pieceName(action.slot)]);
    }
  }
  const untouched = doc.slides
    .map((slide, index) => ({ slide, n: index + 1 }))
    .filter(({ slide }) => !changedPieces.has(slide.id) && !deleted.has(slide.id))
    .map(({ n }) => n);
  const lines = [
    untouched.length > 0 ? t("chat.intact.slides", { list: untouched.join(", ") }) : t("chat.intact.none"),
  ];
  for (const [slideId, pieces] of changedPieces) {
    lines.push(t("chat.intact.onlyPieces", { n: slideNumber(doc, slideId), pieces: pieces.join(", ") }));
  }
  return lines;
}
