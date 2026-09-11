import type { CarouselDocument, StatsResponse } from "../api/types";
import { t } from "../i18n";
import "./PromptHeader.css";

interface PromptHeaderProps {
  doc: CarouselDocument;
  stats: StatsResponse | null;
  onRegenerateUnpinned: () => void;
  regenerateUnpinnedError: string | null;
}

function summarize(doc: CarouselDocument) {
  const slideCount = doc.slides.length;
  let libraryPieces = 0;
  let generatedBackgrounds = 0;
  let draftedTexts = 0;
  // Owner decision: image generation is never automatic, so every visual
  // slot with no library candidate sits at `awaitingImage: true` until the
  // user submits a per-piece "Generar imagen…" request.
  let awaitingImages = 0;
  const pieces = doc.slides.flatMap((s) => [s.background, ...s.objects]);
  for (const piece of pieces) {
    if (piece.source === "library") libraryPieces += 1;
    if ("awaitingImage" in piece && piece.awaitingImage) awaitingImages += 1;
  }
  for (const object of doc.slides.flatMap((s) => s.objects)) {
    if (object.kind === "text" && object.source === "ai" && !object.pending && object.text) draftedTexts += 1;
  }
  for (const s of doc.slides) {
    if (s.background.mode === "asset" && s.background.source === "ai") generatedBackgrounds += 1;
  }
  return { slideCount, libraryPieces, generatedBackgrounds, draftedTexts, awaitingImages };
}

/** "hace N min/h/d" from an ISO timestamp — no date library needed for a granularity this coarse. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return t("promptHeader.relativeTime.justNow");
  if (minutes < 60) return t("promptHeader.relativeTime.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("promptHeader.relativeTime.hours", { count: hours });
  const days = Math.floor(hours / 24);
  return t("promptHeader.relativeTime.days", { count: days });
}

export function PromptHeader({ doc, stats, onRegenerateUnpinned, regenerateUnpinnedError }: PromptHeaderProps) {
  const { slideCount, libraryPieces, generatedBackgrounds, draftedTexts, awaitingImages } = summarize(doc);

  return (
    <div className="prompt-header">
      <span className="prompt-icon">✦</span>
      <div className="prompt-body">
        <p className="prompt-text">{doc.title}</p>
        <div className="prompt-meta">
          <span>
            <i className="prompt-check">✓</i> {t("promptHeader.slideCount", { count: slideCount })}
          </span>
          <span>
            <i className="prompt-check">✓</i> {t("promptHeader.draftedTexts", { count: draftedTexts })}
          </span>
          <span>
            <i className="prompt-check">✓</i> {t("promptHeader.libraryPieces", { count: libraryPieces })}
          </span>
          <span>
            <i className="prompt-check">✓</i> {t("promptHeader.generatedBackgrounds", { count: generatedBackgrounds })}
          </span>
          {awaitingImages > 0 && (
            <span className="prompt-awaiting-images">
              {awaitingImages === 1
                ? t("promptHeader.awaitingImage.one", { count: awaitingImages })
                : t("promptHeader.awaitingImage.other", { count: awaitingImages })}
            </span>
          )}
          <span className="prompt-updated">{relativeTime(doc.updatedAt || doc.createdAt)}</span>
          {stats && (
            <span className="prompt-savings">
              {t("promptHeader.savings", { ratio: stats.libraryRatio })}
              {stats.history.length > 0 &&
                t("promptHeader.savingsHistory", { ratio: stats.history[0]!.libraryRatio })}
            </span>
          )}
        </div>
        {regenerateUnpinnedError && <p className="prompt-error">{regenerateUnpinnedError}</p>}
      </div>
      <button className="prompt-redo" onClick={onRegenerateUnpinned}>
        ↻ {t("promptHeader.regenerateUnpinned")}
      </button>
    </div>
  );
}
