import { useState } from "react";

import { applyPlan, createCarouselFromPrompt } from "../api/client";
import type { CompositionPlanResponse } from "../api/types";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import "./NewCarouselDialog.css";

interface NewCarouselDialogProps {
  slug: string;
  onClose: () => void;
  onCreated: (carouselId: string) => void;
}

type Step = "prompt" | "plan";

/**
 * Composition-from-prompt screen (specs/editor-ui "Composition from the
 * prompt", tasks.md 6.8): prompt + template, then a per-slide plan preview
 * with each visual piece's origin (library 0¢ | generate ~cost) before
 * anything is created or spent.
 */
export function NewCarouselDialog({ slug, onClose, onCreated }: NewCarouselDialogProps) {
  const [step, setStep] = useState<Step>("prompt");
  const [prompt, setPrompt] = useState("");
  const [templateId, setTemplateId] = useState("explicativo");
  const [plan, setPlan] = useState<CompositionPlanResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePlan() {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createCarouselFromPrompt(slug, { prompt, templateId });
      setPlan(res);
      setStep("plan");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      await applyPlan(slug, plan.carouselId, plan.templateId);
      onCreated(plan.carouselId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (step === "prompt") {
    return (
      <Modal
        title="Nuevo carrusel"
        onClose={onClose}
        actions={
          <>
            <Button onClick={onClose}>Cancelar</Button>
            <Button variant="primary" onClick={handlePlan} disabled={busy || !prompt.trim()}>
              {busy ? "Planificando…" : "Ver plan"}
            </Button>
          </>
        }
      >
        <div className="new-carousel-form">
          <label className="new-carousel-label">
            Prompt
            <textarea
              className="ui-input"
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Un carrusel que explique X paso a paso, con el template explicativo, usando las fotos de los assets."
            />
          </label>
          <label className="new-carousel-label">
            Template
            <input className="ui-input" value={templateId} onChange={(e) => setTemplateId(e.target.value)} />
          </label>
          {error && <p className="new-carousel-error">{error}</p>}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Plan del carrusel"
      onClose={onClose}
      actions={
        <>
          <Button onClick={() => setStep("prompt")}>Volver</Button>
          <Button variant="primary" onClick={handleConfirm} disabled={busy}>
            {busy ? "Creando…" : "Confirmar y crear"}
          </Button>
        </>
      }
    >
      {plan && (
        <div className="plan-preview">
          <p className="plan-summary">
            {plan.plan.slideKinds.length} láminas · {plan.libraryPieces} de biblioteca · {plan.generatedPieces} a generar
            · {(plan.estimatedCostCents / 100).toFixed(2)}¢ estimado
          </p>
          <ul className="plan-slides">
            {plan.plan.slideKinds.map((kind, slideIndex) => (
              <li key={slideIndex} className="plan-slide">
                <div className="plan-slide-head">
                  Lámina {slideIndex + 1} · {kind}
                </div>
                <div className="plan-slide-visuals">
                  {plan.plan.textSlots
                    .filter((t) => t.slideIndex === slideIndex)
                    .map((t) => (
                      <span key={t.slot} className="plan-origin library">
                        {t.slot}: texto a redactar
                      </span>
                    ))}
                  {plan.plan.visualSlots
                    .filter((v) => v.slideIndex === slideIndex)
                    .map((v) => (
                      <span key={v.slot} className={`plan-origin ${v.source}`}>
                        {v.slot}: {v.source === "library" ? "Biblioteca · 0¢" : `Generar · ~${((v.estimatedCostCents ?? 0) / 100).toFixed(2)}¢`}
                      </span>
                    ))}
                </div>
              </li>
            ))}
          </ul>
          {error && <p className="new-carousel-error">{error}</p>}
        </div>
      )}
    </Modal>
  );
}
