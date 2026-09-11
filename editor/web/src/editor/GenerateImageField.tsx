import { useEffect, useState } from "react";

import { previewRegeneratePrompt } from "../api/client";
import type { RegenerateTarget } from "../api/client";
import { t } from "../i18n";
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
  /** Enables the "Ver prompt final" preview, which asks the server what it would actually send (suggestion/override + brand style) without spending anything. Omitted where the caller has no stable target yet. */
  previewTarget?: { slug: string; carouselId: string; target: RegenerateTarget };
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
  previewTarget,
}: GenerateImageFieldProps) {
  const [expanded, setExpanded] = useState(false);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [busy, setBusy] = useState(false);
  const [showFinalPrompt, setShowFinalPrompt] = useState(false);
  const [finalPrompt, setFinalPrompt] = useState<string | null>(null);
  const [finalPromptError, setFinalPromptError] = useState<string | null>(null);
  const [loadingFinalPrompt, setLoadingFinalPrompt] = useState(false);

  useEffect(() => {
    setPrompt(initialPrompt);
  }, [initialPrompt]);

  useEffect(() => {
    // Collapses and forgets any previously fetched preview whenever the
    // field itself collapses or the underlying prompt changes — a stale
    // "prompt final" for a since-edited draft would be misleading.
    setShowFinalPrompt(false);
    setFinalPrompt(null);
    setFinalPromptError(null);
  }, [expanded, prompt]);

  async function handleToggleFinalPrompt() {
    const next = !showFinalPrompt;
    setShowFinalPrompt(next);
    if (!next || !previewTarget || finalPrompt !== null || loadingFinalPrompt) return;
    setLoadingFinalPrompt(true);
    setFinalPromptError(null);
    try {
      const res = await previewRegeneratePrompt(
        previewTarget.slug,
        previewTarget.carouselId,
        previewTarget.target,
        prompt.trim() || undefined,
      );
      setFinalPrompt(res.prompt);
    } catch (err) {
      setFinalPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingFinalPrompt(false);
    }
  }

  if (!expanded) {
    return (
      <button className="generate-image-toggle" disabled={disabled} onClick={() => setExpanded(true)}>
        {mode === "generate" ? t("generateImage.toggleGenerate") : t("generateImage.toggleRegenerate")}
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
        placeholder={t("generateImage.promptPlaceholder")}
        disabled={busy}
      />
      <div className="generate-image-actions">
        {estimatedCostCents !== null && <span className="generate-image-cost">{formatCents(estimatedCostCents)}</span>}
        {previewTarget && (
          <button className="generate-image-preview-toggle" onClick={() => void handleToggleFinalPrompt()} disabled={busy}>
            {t("generateImage.viewFinalPrompt")}
          </button>
        )}
        <button className="ui-btn" onClick={() => setExpanded(false)} disabled={busy}>
          {t("generateImage.cancel")}
        </button>
        <button className="ui-btn ui-btn-primary" onClick={() => void handleSubmit()} disabled={busy || !prompt.trim()}>
          {busy ? t("generateImage.generating") : t("generateImage.generate")}
        </button>
      </div>
      {showFinalPrompt && (
        <div className="generate-image-final-prompt">
          {loadingFinalPrompt && <p className="props-hint">{t("generateImage.composingPrompt")}</p>}
          {finalPromptError && <p className="generate-image-error">{finalPromptError}</p>}
          {finalPrompt && <pre>{finalPrompt}</pre>}
        </div>
      )}
      {error && <p className="generate-image-error">{error}</p>}
    </div>
  );
}
