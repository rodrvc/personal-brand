import type { CarouselDocument } from "../api/types";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import "../routes/NewCarouselDialog.css";

interface PlanDrawerProps {
  doc: CarouselDocument;
  onClose: () => void;
}

interface PlanRow {
  slot: string;
  kindLabel: string;
  origin: "library" | "ai" | "manual";
  pending: boolean;
  /** No library candidate; waiting on an explicit "Generar imagen…" request (owner decision: image generation is never automatic) — see SelectionPane/SlidePane for that control. */
  awaitingImage: boolean;
}

/**
 * Read-only plan view (specs/editor-ui "Composition from the prompt": the
 * plan is optional, reachable via "Ver plan" from the prompt header, never
 * blocking). Deliberately derived straight from the already-loaded
 * `CarouselDocument` rather than re-fetching or re-modeling the server's
 * `CompositionPlan` shape — every piece's slot/origin/pending state the
 * plan used to preview is already sitting right there in the document by
 * the time this can be opened, so a second network call would just
 * duplicate it.
 */
export function PlanDrawer({ doc, onClose }: PlanDrawerProps) {
  return (
    <Modal title="Plan del carrusel" onClose={onClose} actions={<Button onClick={onClose}>Cerrar</Button>}>
      <div className="plan-preview">
        <p className="plan-summary">
          {doc.slides.length} láminas · prompt: "{doc.prompt.text}"
        </p>
        <ul className="plan-slides">
          {doc.slides.map((slide, slideIndex) => {
            const rows: PlanRow[] = [
              {
                slot: "Fondo",
                kindLabel: slide.background.mode === "color" ? "color" : "imagen",
                origin: slide.background.source,
                pending: Boolean(slide.background.pending),
                awaitingImage: Boolean(slide.background.awaitingImage),
              },
              ...slide.objects.map((object) => ({
                slot: object.slot ?? object.id,
                kindLabel: object.kind === "text" ? "texto" : "imagen",
                origin: object.source,
                pending: Boolean(object.pending),
                awaitingImage: object.kind === "asset" && Boolean(object.awaitingImage),
              })),
            ];
            return (
              <li key={slide.id} className="plan-slide">
                <div className="plan-slide-head">
                  Lámina {slideIndex + 1} · {slide.kind}
                </div>
                <div className="plan-slide-visuals">
                  {rows.map((row, i) => (
                    <span
                      key={i}
                      className={`plan-origin ${row.origin === "library" ? "library" : "generate"}`}
                      title={row.pending ? "Redactando…" : row.awaitingImage ? "Por generar" : undefined}
                    >
                      {row.slot} ({row.kindLabel}): {originLabel(row.origin)}
                      {row.pending ? " · redactando…" : ""}
                      {row.awaitingImage ? " · por generar" : ""}
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}

function originLabel(origin: "library" | "ai" | "manual"): string {
  if (origin === "library") return "biblioteca";
  if (origin === "ai") return "IA";
  return "manual";
}
