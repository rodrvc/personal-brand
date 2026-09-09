import { useState } from "react";

import { createCarousel } from "../api/client";
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
 * New-carousel screen (specs/editor-ui "New carousel opens empty"): asks
 * only for what identifies the piece — title, brand (fixed to `slug`, the
 * profile this dialog was opened from) and an optional template. No
 * prompt, no cost, no background work: submitting creates an empty
 * document and the caller navigates straight into the editor with it.
 *
 * Only one template ships today (system/ig-carousel/layouts/explicativo.json
 * is the only file there, and profiles/example/templates/ has none) — a
 * free-text input defaulting to "explicativo" is honest about that; a
 * `<select>` with real options is a separate issue (ACU-230/232) once a
 * list-templates endpoint exists.
 */
export function NewCarouselDialog({ slug, onClose, onCreated }: NewCarouselDialogProps) {
  const [title, setTitle] = useState("");
  const [templateId, setTemplateId] = useState("explicativo");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setBusy(true);
    setError(null);
    try {
      const result = await createCarousel(slug, { title: title.trim() || undefined, templateId });
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
          <Button variant="primary" onClick={handleSubmit} disabled={busy}>
            {busy ? "Creando…" : "Crear"}
          </Button>
        </>
      }
    >
      <div className="new-carousel-form">
        <label className="new-carousel-label">
          Título
          <input
            className="ui-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="ej: Cómo armar tu primer carrusel"
            autoFocus
          />
        </label>
        <label className="new-carousel-label">
          Marca
          <input className="ui-input" value={slug} disabled />
        </label>
        <label className="new-carousel-label">
          Template (opcional)
          <input className="ui-input" value={templateId} onChange={(e) => setTemplateId(e.target.value)} />
        </label>
        <p className="new-carousel-hint">
          El carrusel se crea vacío: entra directo al editor y cada pieza se compone desde ahí, cuando vos lo pidas.
        </p>
        {error && <p className="new-carousel-error">{error}</p>}
      </div>
    </Modal>
  );
}
