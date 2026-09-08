import { useEffect, useState } from "react";

import "./GenerateImageField.css";

interface GenerateImageFieldProps {
  /** "Generar imagen…" for a slot with no image yet; "Regenerar" for one that already has one. */
  mode: "generate" | "regenerate";
  /** Prefilled prompt: the planner's `suggestion` for a fresh slot, or the asset's last-used prompt for a regenerate. */
  initialPrompt: string;
  estimatedCostCents: number | null;
  disabled?: boolean;
  onSubmit: (prompt: string) => Promise<void>;
  error?: string | null;
}

function formatCents(cents: number): string {
  // Sub-cent estimates (pricing.ts's flat per-image estimate is often < 1¢)
  // read oddly as "$0.00" — showing tenths of a cent ("~0,4¢") is what the
  // task asked for and what actually distinguishes these small numbers.
  return `~${(cents).toFixed(1).replace(".", ",")}¢`;
}

/**
 * Inline "Generar imagen…" / "Regenerar" control (piece-generation spec,
 * "Library first, generate later"; owner decision: image generation is
 * never automatic). Collapsed by default to a single button; expands to an
 * editable prompt field — prefilled with the planner's suggestion or the
 * piece's last prompt — plus the estimated cost and a "Generar" button that
 * actually submits the request. Nothing here ever calls the AI provider on
 * its own: every generation this component can trigger is one explicit
 * user click on an editable prompt.
 */
export function GenerateImageField({
  mode,
  initialPrompt,
  estimatedCostCents,
  disabled,
  onSubmit,
  error,
}: GenerateImageFieldProps) {
  const [expanded, setExpanded] = useState(false);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPrompt(initialPrompt);
  }, [initialPrompt]);

  if (!expanded) {
    return (
      <button className="generate-image-toggle" disabled={disabled} onClick={() => setExpanded(true)}>
        {mode === "generate" ? "Generar imagen…" : "Regenerar…"}
      </button>
    );
  }

  async function handleSubmit() {
    setBusy(true);
    try {
      await onSubmit(prompt);
      setExpanded(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="generate-image-field">
      <textarea
        className="ui-input"
        rows={2}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe la imagen que querés generar…"
        disabled={busy}
      />
      <div className="generate-image-actions">
        {estimatedCostCents !== null && <span className="generate-image-cost">{formatCents(estimatedCostCents)}</span>}
        <button className="ui-btn" onClick={() => setExpanded(false)} disabled={busy}>
          Cancelar
        </button>
        <button className="ui-btn ui-btn-primary" onClick={() => void handleSubmit()} disabled={busy || !prompt.trim()}>
          {busy ? "Generando…" : "Generar"}
        </button>
      </div>
      {error && <p className="generate-image-error">{error}</p>}
    </div>
  );
}
