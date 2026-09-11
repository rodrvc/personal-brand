import { useEffect, useState } from "react";

import { getAiPricing, getAssetGeneration, regenerate } from "../../api/client";
import type { AssetObject, BrandTokens, CarouselDocument, Slide } from "../../api/types";
import type { Selection } from "../geometry";
import { GenerateImageField } from "../GenerateImageField";
import {
  resetObjectToSlot,
  setObjectPinned,
  setBackgroundPinned,
  setTextContent,
  setTextStyle,
} from "../mutations";
import { t } from "../../i18n";
import type { LocaleKey } from "../../i18n";

interface SelectionPaneProps {
  slug: string;
  brand: BrandTokens;
  doc: CarouselDocument;
  slide: Slide;
  selection: Selection;
  onSelectionChange: (selection: Selection) => void;
  onDocUpdate: (updater: (prev: CarouselDocument) => CarouselDocument) => void;
  onDocReplace: (next: CarouselDocument) => void;
}

/** Piece origin → its LocaleKey. `t()` is called lazily, in `originLabel()`, never at module load. */
const ORIGIN_LABEL_KEY: Record<string, LocaleKey> = {
  ai: "common.originAi",
  library: "selectionPane.origin.library",
  manual: "selectionPane.origin.manual",
};

function originLabel(source: string): string {
  const key = ORIGIN_LABEL_KEY[source];
  return key ? t(key) : source;
}

/**
 * The generate/regenerate control only makes sense for a piece that is
 * either waiting on an explicit image request (`awaitingImage: true`) or
 * already has an AI-generated image to redo. A piece that never went
 * through AI at all — a plain color background, a library-sourced asset —
 * has nothing to generate: showing the button there would suggest an
 * action that silently replaces a deliberate manual/library choice.
 */
function canOfferGenerate(piece: { awaitingImage?: boolean; source: string }): boolean {
  return Boolean(piece.awaitingImage) || piece.source === "ai";
}

/**
 * Client-side mirror of the server's `suggestionForSlot` (planner.ts):
 * used only until the piece gets a real `suggestion` from the server
 * (which never happens today — composing on create was removed, and
 * regeneration only sets `suggestion` on objects it already touched).
 * `doc.prompt.text` is empty on a fresh document, so this falls back to
 * `doc.title`, and to the bare slot name when both are empty — never a
 * stray leading "— slot".
 */
function suggestionFallback(doc: CarouselDocument, slot: string): string {
  const lead = doc.prompt.text.trim() || doc.title.trim();
  return lead ? `${lead} — ${slot}` : slot;
}

/**
 * Piece-generation UI for one visual slot (background or asset object):
 * "Generar imagen…" when it's `awaitingImage` (no library candidate yet,
 * no image), "Regenerar…" when it already has one — both expand into the
 * shared `GenerateImageField` with an editable, cost-shown prompt. Owner
 * decision: image generation is never automatic, so this is the only path
 * that can attach or replace an image on this piece.
 */
function VisualGenerateControl({
  slug,
  doc,
  target,
  suggestion,
  existingAssetId,
  estimatedCostCents,
  onDocReplace,
}: {
  slug: string;
  doc: CarouselDocument;
  target: { slideId: string; objectId?: string };
  suggestion: string;
  existingAssetId?: string;
  estimatedCostCents: number | null;
  onDocReplace: (next: CarouselDocument) => void;
}) {
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLastPrompt(null);
    if (!existingAssetId) return;
    let alive = true;
    getAssetGeneration(slug, existingAssetId)
      .then((sidecar) => {
        if (alive && sidecar.prompt) setLastPrompt(sidecar.prompt);
      })
      .catch(() => {
        // No sidecar (e.g. a manual/library asset) — falls back to `suggestion` below.
      });
    return () => {
      alive = false;
    };
  }, [slug, existingAssetId]);

  async function handleSubmit(prompt: string) {
    setError(null);
    try {
      const { document } = await regenerate(slug, doc.id, target, prompt);
      onDocReplace(document);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  return (
    <GenerateImageField
      mode={existingAssetId ? "regenerate" : "generate"}
      initialPrompt={existingAssetId ? lastPrompt ?? suggestion : suggestion}
      estimatedCostCents={estimatedCostCents}
      onSubmit={handleSubmit}
      error={error}
      previewTarget={{ slug, carouselId: doc.id, target }}
    />
  );
}

export function SelectionPane({ slug, brand, doc, slide, selection, onSelectionChange, onDocUpdate, onDocReplace }: SelectionPaneProps) {
  const [pricing, setPricing] = useState<number | null>(null);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [regenError, setRegenError] = useState<string | null>(null);
  const selectedObject = selection ? slide.objects.find((o) => o.id === selection.objectId) : undefined;

  useEffect(() => {
    getAiPricing()
      .then((p) => setPricing(p.estimatedImageCostCents))
      .catch(() => setPricing(null));
  }, []);

  async function handleRegenerateText(objectId: string) {
    setRegenerating(objectId);
    setRegenError(null);
    try {
      const { document } = await regenerate(slug, doc.id, { slideId: slide.id, objectId });
      onDocReplace(document);
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : String(err));
    } finally {
      setRegenerating(null);
    }
  }

  const colorKeys = Object.keys(brand.colors);

  return (
    <>
      {selectedObject?.kind === "text" && (
        <div className="props-card">
          <div className="props-card-heading">
            {selectedObject.slot ?? t("selectionPane.textHeadingFallback")}
            <span className={`origin-badge ${selectedObject.source}`} style={{ marginLeft: "auto" }}>
              {selectedObject.pinned ? t("selectionPane.pinned") : originLabel(selectedObject.source)}
            </span>
          </div>
          <textarea
            className="ui-input"
            rows={3}
            value={selectedObject.text}
            onChange={(e) => onDocUpdate((prev) => setTextContent(prev, slide.id, selectedObject.id, e.target.value))}
          />
          <div className="props-row">
            <div className="props-field">
              <label>{t("selectionPane.fontSizeLabel")}</label>
              <input
                className="ui-input"
                type="number"
                min={1}
                step={1}
                value={selectedObject.fontSize ?? ""}
                onChange={(e) => {
                  const fontSize = Math.round(Number(e.target.value));
                  if (!Number.isFinite(fontSize) || fontSize <= 0) return;
                  onDocUpdate((prev) => setTextStyle(prev, slide.id, selectedObject.id, { fontSize }));
                }}
              />
            </div>
            <div className="props-field">
              <label>{t("selectionPane.lineHeightLabel")}</label>
              <input
                className="ui-input"
                type="number"
                step="0.05"
                value={selectedObject.lineHeight ?? ""}
                onChange={(e) =>
                  onDocUpdate((prev) => setTextStyle(prev, slide.id, selectedObject.id, { lineHeight: Number(e.target.value) }))
                }
              />
            </div>
          </div>
          <div className="props-row">
            <div className="props-field">
              <label>{t("selectionPane.positionLabel")}</label>
              <input
                className="ui-input"
                readOnly
                value={
                  selectedObject.geometry
                    ? `${selectedObject.geometry.x} · ${selectedObject.geometry.y}`
                    : t("selectionPane.positionInherited")
                }
              />
            </div>
            <div className="props-field">
              <label>{t("selectionPane.rotationLabel")}</label>
              <input className="ui-input" readOnly value={`${selectedObject.geometry?.rotation ?? 0}°`} />
            </div>
          </div>
          {selectedObject.slot && (
            <button className="ui-btn" onClick={() => onDocUpdate((prev) => resetObjectToSlot(prev, slide.id, selectedObject.id))}>
              {t("selectionPane.resetToTemplate")}
            </button>
          )}
        </div>
      )}

      {selectedObject?.kind === "text" && (
        <div className="props-card">
          <div className="props-card-heading">
            {t("selectionPane.colorHeading")}
            <span className="lock-hint">{t("selectionPane.colorLockHint")}</span>
          </div>
          <div className="color-swatches">
            {colorKeys.map((key) => (
              <button
                key={key}
                className={`color-swatch ${selectedObject.colorKey === key ? "on" : ""}`}
                style={{ background: brand.colors[key] }}
                title={key}
                onClick={() => onDocUpdate((prev) => setTextStyle(prev, slide.id, selectedObject.id, { colorKey: key }))}
              />
            ))}
          </div>
          <p className="props-hint">
            {t("selectionPane.colorHintPrefix", { count: colorKeys.length })} <b>inputs</b>
            {t("selectionPane.colorHintSuffix")}
          </p>
        </div>
      )}

      {selectedObject?.kind === "asset" && (
        <div className="props-card">
          <div className="props-card-heading">
            {selectedObject.slot ?? t("selectionPane.assetHeadingFallback")}
            <span className={`origin-badge ${selectedObject.source}`} style={{ marginLeft: "auto" }}>
              {selectedObject.pinned ? t("selectionPane.pinned") : originLabel(selectedObject.source)}
            </span>
          </div>
          {!selectedObject.pinned && canOfferGenerate(selectedObject) && (
            <VisualGenerateControl
              slug={slug}
              doc={doc}
              target={{ slideId: slide.id, objectId: selectedObject.id }}
              suggestion={(selectedObject as AssetObject).suggestion ?? `${doc.prompt.text} — ${selectedObject.slot ?? selectedObject.id}`}
              existingAssetId={(selectedObject as AssetObject).assetId}
              estimatedCostCents={pricing}
              onDocReplace={onDocReplace}
            />
          )}
          {selectedObject.pinned && <p className="props-hint">{t("common.pinnedNoRegenerate")}</p>}
          {!selectedObject.pinned && !canOfferGenerate(selectedObject) && (
            <p className="props-hint">{t("selectionPane.noAiHint")}</p>
          )}
        </div>
      )}

      <div className="props-card">
        <div className="props-card-heading">{t("selectionPane.piecesHeading")}</div>
        <p className="props-hint" style={{ marginBottom: 2 }}>
          {t("selectionPane.piecesHintPrefix")} <b>✓</b> {t("selectionPane.piecesHintMiddle")} <b>↻</b>{" "}
          {t("selectionPane.piecesHintSuffix")}
        </p>

        <div
          className={`layer-row ${selection === null ? "on" : ""}`}
          onClick={() => onSelectionChange(null)}
        >
          <span className="layer-name">{t("selectionPane.backgroundLayerName")}</span>
          <span className="layer-actions">
            <span className={`origin-badge ${slide.background.source}`}>{originLabel(slide.background.source)}</span>
            <button
              className={`pin-btn ${slide.background.pinned ? "on" : ""}`}
              title={t("selectionPane.pinAction")}
              onClick={(e) => {
                e.stopPropagation();
                onDocUpdate((prev) => setBackgroundPinned(prev, slide.id, !slide.background.pinned));
              }}
            >
              ✓
            </button>
          </span>
        </div>
        {!slide.background.pinned && canOfferGenerate(slide.background) && (
          <div className="layer-row-extra" onClick={(e) => e.stopPropagation()}>
            <VisualGenerateControl
              slug={slug}
              doc={doc}
              target={{ slideId: slide.id, objectId: "background" }}
              suggestion={slide.background.suggestion ?? suggestionFallback(doc, `background for ${slide.kind}`)}
              existingAssetId={slide.background.mode === "asset" ? slide.background.assetId : undefined}
              estimatedCostCents={pricing}
              onDocReplace={onDocReplace}
            />
          </div>
        )}

        {slide.objects.map((object) => (
          <div key={object.id}>
            <div
              className={`layer-row ${selection?.objectId === object.id ? "on" : ""}`}
              onClick={() => onSelectionChange({ slideId: slide.id, objectId: object.id })}
            >
              <span className="layer-name">
                {object.locked && <span className="layer-lock-icon">🔒 </span>}
                {object.slot ?? (object.kind === "text" ? t("selectionPane.textHeadingFallback") : t("selectionPane.assetHeadingFallback"))}
              </span>
              <span className="layer-actions">
                {!object.locked && <span className={`origin-badge ${object.source}`}>{originLabel(object.source)}</span>}
                {!object.locked && (
                  <>
                    <button
                      className={`pin-btn ${object.pinned ? "on" : ""}`}
                      title={t("selectionPane.pinAction")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDocUpdate((prev) => setObjectPinned(prev, slide.id, object.id, !object.pinned));
                      }}
                    >
                      ✓
                    </button>
                    {object.kind === "text" && (
                      <button
                        className="regen-btn"
                        title={t("selectionPane.regenerateAction")}
                        disabled={object.pinned || regenerating === object.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRegenerateText(object.id);
                        }}
                      >
                        ↻
                      </button>
                    )}
                  </>
                )}
              </span>
            </div>
            {object.kind === "asset" && !object.pinned && !object.locked && canOfferGenerate(object) && (
              <div className="layer-row-extra" onClick={(e) => e.stopPropagation()}>
                <VisualGenerateControl
                  slug={slug}
                  doc={doc}
                  target={{ slideId: slide.id, objectId: object.id }}
                  suggestion={object.suggestion ?? suggestionFallback(doc, object.slot ?? object.id)}
                  existingAssetId={object.assetId}
                  estimatedCostCents={pricing}
                  onDocReplace={onDocReplace}
                />
              </div>
            )}
          </div>
        ))}

        {regenError && <p className="props-hint" style={{ color: "var(--ui-danger)" }}>{regenError}</p>}
        <p className="props-note">{t("selectionPane.footerNote")}</p>
      </div>
    </>
  );
}
