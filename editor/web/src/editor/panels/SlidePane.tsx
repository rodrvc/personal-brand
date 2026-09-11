import { useEffect, useState } from "react";

import { getAiPricing, getAssetGeneration, getContrast, regenerate } from "../../api/client";
import type { BrandTokens, CarouselDocument, ContrastMeasurement, Slide, SlideKind } from "../../api/types";
import { GenerateImageField } from "../GenerateImageField";
import { setBackgroundColor, setSlideKind } from "../mutations";
import { humanizeId } from "../../../../../system/ig-carousel/object-reset.js";
import { t } from "../../i18n";
import type { LocaleKey } from "../../i18n";

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

/** Slide kind → its LocaleKey. `t()` is called lazily, in `slideKindLabel()`, never at module load. */
const KIND_LABEL_KEY: Record<SlideKind, LocaleKey> = {
  cover: "slidePane.kind.cover",
  step: "slidePane.kind.step",
  closing: "slidePane.kind.closing",
};

function slideKindLabel(kind: SlideKind): string {
  return t(KIND_LABEL_KEY[kind]);
}

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
        <div className="props-card-heading">{t("slidePane.kindHeading")}</div>
        <select
          className="ui-input"
          value={slide.kind}
          onChange={(e) => onDocUpdate((prev) => setSlideKind(prev, slide.id, e.target.value as SlideKind))}
        >
          {(Object.keys(KIND_LABEL_KEY) as SlideKind[]).map((kind) => (
            <option key={kind} value={kind}>
              {slideKindLabel(kind)}
            </option>
          ))}
        </select>
        <p className="props-hint">{t("slidePane.kindHint")}</p>
      </div>

      <div className="props-card">
        <div className="props-card-heading">
          {t("slidePane.structureHeading")}
          <span className="lock-hint">{t("slidePane.structureLockHint")}</span>
        </div>
        <div className="layer-row">
          <span className="layer-name">{t("slidePane.bleedBackground")}</span>
        </div>
        <div className="layer-row">
          <span className="layer-name">{t("slidePane.footerLogo")}</span>
        </div>
        <div className="layer-row">
          <span className="layer-name">{t("slidePane.margins")}</span>
        </div>
        {/* Reads the template, never sets it: the Templates tab owns selection (ACU-232). "Sin template" is the document simply carrying no reference. */}
        <div className="layer-row">
          <span className="layer-name">{t("slidePane.templateRow")}</span>
          <span className="layer-name">{doc.template ? humanizeId(doc.template.id) : t("slidePane.templateNone")}</span>
        </div>
        <p className="props-note">{t("slidePane.templatePointer")}</p>
        <p className="props-note">{t("slidePane.structureNote")}</p>
      </div>

      <div className="props-card">
        <div className="props-card-heading">{t("slidePane.backgroundHeading")}</div>
        <div className="seg-control">
          <button className={bgMode === "color" ? "on" : ""} onClick={() => setBgMode("color")}>
            {t("slidePane.backgroundMode.color")}
          </button>
          <button className={bgMode === "library" ? "on" : ""} onClick={() => setBgMode("library")}>
            {t("slidePane.backgroundMode.library")}
          </button>
          <button className={bgMode === "ai" ? "on" : ""} onClick={() => setBgMode("ai")}>
            {t("slidePane.backgroundMode.ai")}
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
        {bgMode === "library" && <p className="props-hint">{t("slidePane.libraryHint")}</p>}
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
            previewTarget={{ slug, carouselId: doc.id, target: { slideId: slide.id, objectId: "background" } }}
          />
        )}
        {bgMode === "ai" && slide.background.pinned && (
          <p className="props-hint">{t("common.pinnedNoRegenerate")}</p>
        )}
        <p className="props-note">{t("slidePane.aiNote")}</p>
      </div>

      <div className="props-card">
        <div className="props-card-heading">{t("slidePane.contrastHeading")}</div>
        {contrastError && <p className="props-hint">{contrastError}</p>}
        {!contrastError && !measurements && <p className="props-hint">{t("slidePane.contrastMeasuring")}</p>}
        {measurements?.map((m) => {
          const object = slide.objects.find((o) => o.id === m.objectId);
          return (
            <div key={m.objectId} className="contrast-row" style={{ color: m.passesAA ? "var(--ui-ok)" : "var(--ui-danger)" }}>
              <span className="layer-name">{object?.slot ?? m.objectId}</span>
              <span className="contrast-value">
                {m.ratio.toFixed(1)}:1 {m.passesAA ? t("slidePane.contrastPass") : t("slidePane.contrastFail")}
              </span>
            </div>
          );
        })}
        <p className="props-hint">{t("slidePane.contrastHint")}</p>
      </div>
    </>
  );
}
