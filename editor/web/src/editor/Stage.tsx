import { useRef, useState } from "react";

import { slideHtmlUrl } from "../api/client";
import type { BrandTokens, CarouselDocument, LayoutTemplate } from "../api/types";
import type { CarouselDocument as Doc } from "../api/types";
import type { Selection } from "./geometry";
import { SelectionOverlay } from "./SelectionOverlay";
import "./Stage.css";

const CANVAS_DISPLAY_WIDTH = 330;

interface StageProps {
  slug: string;
  doc: CarouselDocument;
  template: LayoutTemplate;
  brand: BrandTokens;
  /** Bumped only after a document version is confirmed by the server — see useDocumentEditor. */
  renderVersion: number;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  selection: Selection;
  onSelectionChange: (selection: Selection) => void;
  onDocUpdate: (updater: (prev: Doc) => Doc) => void;
  /** Color key to seed a newly added slide's background with (usually the active slide's, when it has a color background). */
  fallbackColorKey: string;
  onAddSlide: (colorKey: string) => void;
}

function SlideSheet({
  slug,
  doc,
  slideId,
  variant,
  label,
  renderVersion,
}: {
  slug: string;
  doc: CarouselDocument;
  slideId: string;
  variant: "active" | "next";
  label: string;
  renderVersion: number;
}) {
  const index = doc.slides.findIndex((s) => s.id === slideId);
  const src = `${slideHtmlUrl(slug, doc.id, index)}${renderVersion ? `?r=${renderVersion}` : ""}`;

  const scale = CANVAS_DISPLAY_WIDTH / doc.canvas.w;
  const displayHeight = doc.canvas.h * scale;

  return (
    <div className={`stage-sheet ${variant}`}>
      <div className="stage-sheet-label">{label}</div>
      <div className="stage-art" style={{ width: CANVAS_DISPLAY_WIDTH, height: displayHeight }}>
        <iframe
          title={`slide-${index}`}
          src={src}
          className="stage-iframe"
          style={{
            width: doc.canvas.w,
            height: doc.canvas.h,
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        />
      </div>
    </div>
  );
}

export function Stage({
  slug,
  doc,
  template,
  brand,
  renderVersion,
  activeIndex,
  onActiveIndexChange,
  selection,
  onSelectionChange,
  onDocUpdate,
  fallbackColorKey,
  onAddSlide,
}: StageProps) {
  const activeSlide = doc.slides[activeIndex];
  const nextSlide = doc.slides[activeIndex + 1];
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeLoadTick, setIframeLoadTick] = useState(0);

  const scale = CANVAS_DISPLAY_WIDTH / doc.canvas.w;
  const displayHeight = doc.canvas.h * scale;

  const colorKeyForNewSlide =
    (activeSlide?.background.mode === "color" ? activeSlide.background.colorKey : undefined) ?? fallbackColorKey;

  return (
    <div className="stage-wrap">
      <div className="stage">
        {activeSlide && (
          <div className="stage-sheet-container">
            <div className="stage-sheet active">
              <div className="stage-sheet-label">
                <b>Lámina {activeIndex + 1}</b> · {activeSlide.kind}
              </div>
              <div className="stage-art" style={{ width: CANVAS_DISPLAY_WIDTH, height: displayHeight }}>
                <iframe
                  ref={iframeRef}
                  key={activeSlide.id}
                  title={`slide-active-${activeIndex}`}
                  src={`${slideHtmlUrl(slug, doc.id, activeIndex)}${renderVersion ? `?r=${renderVersion}` : ""}`}
                  className="stage-iframe"
                  style={{
                    width: doc.canvas.w,
                    height: doc.canvas.h,
                    transform: `scale(${scale})`,
                    transformOrigin: "top left",
                  }}
                  onLoad={() => setIframeLoadTick((t) => t + 1)}
                />
                <SelectionOverlay
                  template={template}
                  brand={brand}
                  slide={activeSlide}
                  canvas={doc.canvas}
                  scale={scale}
                  selection={selection}
                  onSelectionChange={onSelectionChange}
                  onDocUpdate={onDocUpdate}
                  iframeRef={iframeRef}
                  iframeLoadTick={iframeLoadTick}
                />
              </div>
            </div>
          </div>
        )}

        {nextSlide && (
          <SlideSheet
            slug={slug}
            doc={doc}
            slideId={nextSlide.id}
            variant="next"
            label={`Lámina ${activeIndex + 2}`}
            renderVersion={renderVersion}
          />
        )}
      </div>

      <nav className="stage-strip" aria-label="Láminas">
        {doc.slides.map((slide, index) => (
          <button
            key={slide.id}
            className={`stage-thumb ${index === activeIndex ? "on" : ""}`}
            onClick={() => onActiveIndexChange(index)}
          >
            <div className="stage-thumb-mini">
              <span className="stage-thumb-kind">{slide.kind === "cover" ? "POR" : slide.kind === "closing" ? "FIN" : index}</span>
            </div>
            <div className="stage-thumb-n">{String(index + 1).padStart(2, "0")}</div>
          </button>
        ))}
        <button className="stage-add-thumb" title="Añadir lámina" onClick={() => onAddSlide(colorKeyForNewSlide)}>
          +
        </button>
      </nav>
    </div>
  );
}
