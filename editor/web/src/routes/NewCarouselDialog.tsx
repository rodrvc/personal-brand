import { useState } from "react";

import { createCarouselFromPrompt } from "../api/client";
import type { CreateCarouselResponse } from "../api/types";
import { Modal } from "../components/Modal";
import { Button } from "../components/Button";
import "./NewCarouselDialog.css";

interface NewCarouselDialogProps {
  slug: string;
  onClose: () => void;
  onCreated: (result: CreateCarouselResponse) => void;
}

/**
 * Composition-from-prompt screen (specs/editor-ui "Composition from the
 * prompt"): a single small form — prompt, template, an optional
 * collapsed-by-default library-pieces picker. Submitting builds the
 * carousel immediately (no plan-approval step in between); the caller
 * navigates straight into the editor with the returned document.
 *
 * Only one template ships today (system/ig-carousel/layouts/explicativo.json
 * is the only file there, and profiles/example/templates/ has none) — a
 * free-text input defaulting to "explicativo" is honest about that; a
 * `<select>` with one option would just be theater until a second template
 * exists.
 */
export function NewCarouselDialog({ slug, onClose, onCreated }: NewCarouselDialogProps) {
  const [prompt, setPrompt] = useState("");
  const [templateId, setTemplateId] = useState("explicativo");
  const [assetIdsText, setAssetIdsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    if (!prompt.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const assetIds = assetIdsText
        .split(/[\s,]+/)
        .map((id) => id.trim())
        .filter(Boolean);
      const result = await createCarouselFromPrompt(slug, {
        prompt,
        templateId,
        assetIds: assetIds.length > 0 ? assetIds : undefined,
      });
      onCreated(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Nuevo carrusel"
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" onClick={handleSubmit} disabled={busy || !prompt.trim()}>
            {busy ? "Creando…" : "Crear"}
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
            placeholder="Un carrusel que explique X paso a paso, en 4 pasos, con el template explicativo, usando las fotos de los assets."
            autoFocus
          />
        </label>
        <label className="new-carousel-label">
          Template
          <input className="ui-input" value={templateId} onChange={(e) => setTemplateId(e.target.value)} />
        </label>
        <details className="new-carousel-assets">
          <summary>Piezas de biblioteca (opcional)</summary>
          <label className="new-carousel-label">
            IDs de assets a usar, separados por coma o espacio
            <input
              className="ui-input"
              value={assetIdsText}
              onChange={(e) => setAssetIdsText(e.target.value)}
              placeholder="ej: 3f2a9c1b8e4d5f60, 7c1d..."
            />
          </label>
        </details>
        <p className="new-carousel-hint">
          El carrusel se arma directo en el editor: la cantidad de láminas sale del prompt (ej. "en 4 pasos") o del
          template si no la mencionás.
        </p>
        {error && <p className="new-carousel-error">{error}</p>}
      </div>
    </Modal>
  );
}
