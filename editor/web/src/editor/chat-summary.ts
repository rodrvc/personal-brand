import type { CarouselDocument, ChatAction, ChatRecord, Currency, Provenance } from "../api/types";
import { t } from "../i18n";

const BACKGROUND_SLOT = "background";

function slideNumber(doc: CarouselDocument, slideId: string): number {
  return doc.slides.findIndex((s) => s.id === slideId) + 1;
}

function isLoose(action: ChatAction): boolean {
  return action.provenance.some((p) => p.source === "free");
}

function objectName(doc: CarouselDocument, action: Extract<ChatAction, { type: "delete_object" }>): string {
  const object = doc.slides
    .find((s) => s.id === action.slideId)
    ?.objects.find((o) => (action.objectId ? o.id === action.objectId : o.slot === action.slot));
  if (object?.kind === "text") return t("chat.piece.textQuoted", { text: object.text });
  return object?.slot ? t("chat.piece.imageInSlot", { slot: object.slot }) : t("chat.piece.image");
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
    case "generate_visual":
      return isLoose(action)
        ? t("chat.action.generateLoose", { n: slideNumber(doc, action.slideId) })
        : t("chat.action.generateVisual", { n: slideNumber(doc, action.slideId), piece: pieceName(action.slot) });
    case "add_slide":
      return action.afterIndex < 0
        ? t("chat.action.addSlideFirst", { kind: t(`chat.kind.${action.kind}`) })
        : t("chat.action.addSlide", { kind: t(`chat.kind.${action.kind}`), n: action.afterIndex + 1 });
    case "delete_slide":
      return t("chat.action.deleteSlide", { n: slideNumber(doc, action.slideId) });
    case "delete_object":
      return t("chat.action.deleteObject", { n: slideNumber(doc, action.slideId), piece: objectName(doc, action) });
    case "compose_from_reference":
      return action.slideId
        ? t("chat.action.composeOn", { n: slideNumber(doc, action.slideId) })
        : t("chat.action.composeNew");
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
    if (action.type === "delete_object") {
      changedPieces.set(action.slideId, [...(changedPieces.get(action.slideId) ?? []), objectName(doc, action)]);
    }
    if (action.type === "set_text" || action.type === "set_visual_from_library" || action.type === "generate_visual") {
      const pieces = changedPieces.get(action.slideId) ?? [];
      changedPieces.set(action.slideId, isLoose(action) ? pieces : [...pieces, pieceName(action.slot)]);
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
    const n = slideNumber(doc, slideId);
    lines.push(pieces.length > 0 ? t("chat.intact.onlyPieces", { n, pieces: pieces.join(", ") }) : t("chat.intact.onlyAdds", { n }));
  }
  return lines;
}

export function formatCost(cents: number, currency: Currency): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.code }).format((cents / 100) * currency.rate);
}

/** Every paid operation recorded by an `applied` event, so the total survives a reload. */
export function chatSpend(records: ChatRecord[]): { totalCents: number; items: Array<{ at: string; costCents: number }> } {
  const items = records.flatMap((record) =>
    record.role === "event"
      ? record.results.filter((r) => (r.costCents ?? 0) > 0).map((r) => ({ at: record.at, costCents: r.costCents! }))
      : [],
  );
  return { totalCents: items.reduce((sum, item) => sum + item.costCents, 0), items };
}
