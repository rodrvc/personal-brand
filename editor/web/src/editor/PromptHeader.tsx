import type { CarouselDocument, StatsResponse } from "../api/types";
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
  const pieces = doc.slides.flatMap((s) => [s.background, ...s.objects]);
  for (const piece of pieces) {
    if (piece.source === "library") libraryPieces += 1;
  }
  for (const s of doc.slides) {
    if (s.background.mode === "asset" && s.background.source === "ai") generatedBackgrounds += 1;
  }
  return { slideCount, libraryPieces, generatedBackgrounds };
}

export function PromptHeader({ doc, stats, onRegenerateUnpinned, regenerateUnpinnedError }: PromptHeaderProps) {
  const { slideCount, libraryPieces, generatedBackgrounds } = summarize(doc);

  return (
    <div className="prompt-header">
      <span className="prompt-icon">✦</span>
      <div className="prompt-body">
        <p className="prompt-text">{doc.prompt.text}</p>
        <div className="prompt-meta">
          <span>
            <i className="prompt-check">✓</i> {slideCount} láminas
          </span>
          <span>
            <i className="prompt-check">✓</i> textos redactados
          </span>
          <span>
            <i className="prompt-check">✓</i> {libraryPieces} piezas de biblioteca
          </span>
          <span>
            <i className="prompt-check">✓</i> {generatedBackgrounds} fondos generados
          </span>
          {stats && (
            <span className="prompt-savings">
              {stats.libraryRatio}% de este carrusel salió de la biblioteca
              {stats.history.length > 0 && ` · hace un tiempo era ${stats.history[0]!.libraryRatio}%`}
            </span>
          )}
        </div>
        {regenerateUnpinnedError && <p className="prompt-error">{regenerateUnpinnedError}</p>}
      </div>
      <button className="prompt-redo" onClick={onRegenerateUnpinned}>
        ↻ Regenerar lo no fijado
      </button>
    </div>
  );
}
