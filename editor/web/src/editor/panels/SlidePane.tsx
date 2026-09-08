import { useEffect, useState } from "react";

import { getAiPricing, getAssetGeneration, getContrast, regenerate } from "../../api/client";
import type { BrandTokens, CarouselDocument, ContrastMeasurement, Slide, SlideKind } from "../../api/types";
import { GenerateImageField } from "../GenerateImageField";
import { setBackgroundColor, setSlideKind } from "../mutations";

interface SlidePaneProps {
  slug: string;
  brand: BrandTokens;
  doc: CarouselDocument;
  /** Bumped only after a document version is confirmed by the server — see useDocumentEditor. Used instead of doc.updatedAt so the contrast check does not re-fire on every keystroke. */
  renderVersion: number;
  slide: Slide;
  activeIndex: number;
  onDocUpdate: (updater: (prev: CarouselDocument) => CarouselDocument) => void;
  onDocReplace: (next: CarouselDocument) => void;
}

const KIND_LABEL: Record<SlideKind, string> = { cover: "Portada", step: "Paso", closing: "Cierre" };

type BackgroundMode = "color" | "library" | "ai";

export function SlidePane({ slug, brand, doc, renderVersion, slide, activeIndex, onDocUpdate, onDocReplace }: SlidePaneProps) {
  const [measurements, setMeasurements] = useState<ContrastMeasurement[] | null>(null);
  const [contrastError, setContrastError] = useState<string | null>(null);
  const [bgMode, setBgMode] = useState<BackgroundMode>(slide.background.mode === "color" ? "color" : "library");
  const [regenError, setRegenError] = useState<string | null>(null);
  const [pricing, setPricing] = useState<number | null>(null);
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);

  useEffect(() => {
    getAiPricing()
      .then((p) => setPricing(p.estimatedImageCostCents))
      .catch(() => setPricing(null));
  }, []);

  useEffect(() => {
    setLastPrompt(null);
    if (slide.background.mode !== "asset") return;
    let alive = true;
    getAssetGeneration(slug, slide.background.assetId)
      .then((sidecar) => {
        if (alive && sidecar.prompt) setLastPrompt(sidecar.prompt);
      })
      .catch(() => {
        // No sidecar (manual/library background) — falls back to `suggestion`.
      });
    return () => {
      alive = false;
    };
  }, [slug, slide.background]);

  useEffect(() => {
    let alive = true;
    setMeasurements(null);
    setContrastError(null);
    getContrast(slug, doc.id, activeIndex)
      .then((res) => {
        if (alive) setMeasurements(res.measurements);
      })
      .catch((err: unknown) => {
        if (alive) setContrastError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [slug, doc.id, activeIndex, renderVersion]);

  useEffect(() => {
    setBgMode(slide.background.mode === "color" ? "color" : "library");
  }, [slide.id, slide.background.mode]);

  async function handleGenerateBackground(prompt: string) {
    setRegenError(null);
    try {
      const { document } = await regenerate(slug, doc.id, { slideId: slide.id, objectId: "background" }, prompt);
      onDocReplace(document);
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  return (
    <>
      <div className="props-card">
        <div className="props-card-heading">Tipo de lámina</div>
        <select
          className="ui-input"
          value={slide.kind}
          onChange={(e) => onDocUpdate((prev) => setSlideKind(prev, slide.id, e.target.value as SlideKind))}
        >
          {(Object.keys(KIND_LABEL) as SlideKind[]).map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABEL[kind]}
            </option>
          ))}
        </select>
        <p className="props-hint">El tipo decide qué zonas quedan fijas y cómo se numera.</p>
      </div>

      <div className="props-card">
        <div className="props-card-heading">
          Estructura
          <span className="lock-hint">template</span>
        </div>
        <div className="layer-row">
          <span className="layer-name">Fondo a sangre</span>
        </div>
        <div className="layer-row">
          <span className="layer-name">Footer + logo</span>
        </div>
        <div className="layer-row">
          <span className="layer-name">Márgenes</span>
        </div>
        <p className="props-note">
          Estas zonas no se arrastran. Se cambian en el template y el cambio entra en todas las láminas a la vez,
          así el carrusel no se desalinea lámina a lámina.
        </p>
      </div>

      <div className="props-card">
        <div className="props-card-heading">Fondo de esta lámina</div>
        <div className="seg-control">
          <button className={bgMode === "color" ? "on" : ""} onClick={() => setBgMode("color")}>
            Color
          </button>
          <button className={bgMode === "library" ? "on" : ""} onClick={() => setBgMode("library")}>
            Biblioteca
          </button>
          <button className={bgMode === "ai" ? "on" : ""} onClick={() => setBgMode("ai")}>
            IA
          </button>
        </div>
        {bgMode === "color" && (
          <div className="color-swatches">
            {Object.keys(brand.colors).map((key) => (
              <button
                key={key}
                className={`color-swatch ${slide.background.mode === "color" && slide.background.colorKey === key ? "on" : ""}`}
                style={{ background: brand.colors[key] }}
                title={key}
                onClick={() => onDocUpdate((prev) => setBackgroundColor(prev, slide.id, key))}
              />
            ))}
          </div>
        )}
        {bgMode === "library" && <p className="props-hint">Elige una pieza desde la pestaña Bucket para usarla como fondo.</p>}
        {bgMode === "ai" && !slide.background.pinned && (
          <GenerateImageField
            mode={slide.background.mode === "asset" ? "regenerate" : "generate"}
            initialPrompt={
              slide.background.mode === "asset"
                ? lastPrompt ?? slide.background.suggestion ?? `${doc.prompt.text} — background for ${slide.kind}`
                : slide.background.suggestion ?? `${doc.prompt.text} — background for ${slide.kind}`
            }
            estimatedCostCents={pricing}
            onSubmit={handleGenerateBackground}
            error={regenError}
          />
        )}
        {bgMode === "ai" && slide.background.pinned && (
          <p className="props-hint">Fijado: no se puede regenerar hasta que lo liberes.</p>
        )}
        <p className="props-note">
          La IA hace solo el fondo. No dibuja letras sobre la imagen: eso lo pone el template encima, porque un
          modelo de imagen las deforma.
        </p>
      </div>

      <div className="props-card">
        <div className="props-card-heading">Contraste</div>
        {contrastError && <p className="props-hint">{contrastError}</p>}
        {!contrastError && !measurements && <p className="props-hint">Midiendo…</p>}
        {measurements?.map((m) => (
          <div key={m.label} className="contrast-row" style={{ color: m.passesAA ? "var(--ui-ok)" : "var(--ui-danger)" }}>
            <span className="layer-name">{m.label}</span>
            <span className="contrast-value">
              {m.ratio.toFixed(1)}:1 {m.passesAA ? "AA ✓" : "AA ✗"}
            </span>
          </div>
        ))}
        <p className="props-hint">Medido contra el fondo real de cada lámina, no estimado.</p>
      </div>
    </>
  );
}
