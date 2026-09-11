import { useLayoutEffect, useRef, useState } from "react";

import { slideHtmlUrl, slidePngUrl } from "../api/client";
import type { BrandTokens, CarouselDocument, LayoutTemplate } from "../api/types";
import type { CarouselDocument as Doc } from "../api/types";
import type { Selection } from "./geometry";
import { SelectionOverlay } from "./SelectionOverlay";
import "./Stage.css";

const THUMB_WIDTH = 84;

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

/** One thumbnail in the filmstrip. A real PNG render, with a number/kind fallback badge if the image fails to load (e.g. a slide whose render errors). */
function Thumb({
  slug,
  doc,
  slide,
  index,
  active,
  cacheBuster,
  thumbAspect,
  onSelect,
}: {
  slug: string;
  doc: CarouselDocument;
  slide: Doc["slides"][number];
  index: number;
  active: boolean;
  cacheBuster: string;
  thumbAspect: number;
  onSelect: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const kindLabel = slide.kind === "cover" ? "POR" : slide.kind === "closing" ? "FIN" : String(index + 1);

  return (
    <button
      type="button"
      className={`stage-thumb ${active ? "on" : ""}`}
      aria-label={`Lámina ${index + 1}`}
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
    >
      <div
        className={`stage-thumb-mini ${failed ? "failed" : ""}`}
        style={{ width: "var(--thumb-w)", height: `calc(var(--thumb-w) * ${thumbAspect})` }}
      >
        {!failed && (
          <img
            src={`${slidePngUrl(slug, doc.id, index)}${cacheBuster}`}
            alt=""
            loading="lazy"
            className="stage-thumb-img"
            onError={() => setFailed(true)}
          />
        )}
        {failed && <span className="stage-thumb-fallback">{kindLabel}</span>}
      </div>
      <div className="stage-thumb-n">{String(index + 1).padStart(2, "0")}</div>
    </button>
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
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [iframeLoadTick, setIframeLoadTick] = useState(0);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });

  // Fit the active sheet to the available stage area: measure the stage
  // element and recompute on resize, so the slide scales up in the space
  // freed by moving the strip below (rather than staying pinned to a fixed
  // display width).
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setStageSize({ w: width, h: height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // `contentRect` already excludes the stage's padding, so the measured
  // size is the space the sheet can use as is; subtracting the padding
  // again would shrink the sheet by 52px on each axis.
  const availableW = Math.max(stageSize.w, 0);
  const availableH = Math.max(stageSize.h, 0);
  const fitScale = availableW > 0 && availableH > 0 ? Math.min(availableW / doc.canvas.w, availableH / doc.canvas.h) : 0;
  // Before the first measurement, fall back to a reasonable scale so the
  // sheet isn't invisible for one frame.
  const scale = fitScale > 0 ? fitScale : 330 / doc.canvas.w;
  const displayHeight = doc.canvas.h * scale;
  const displayWidth = doc.canvas.w * scale;
  const thumbAspect = doc.canvas.h / doc.canvas.w;
  const cacheBuster = renderVersion ? `?r=${renderVersion}` : "";

  const colorKeyForNewSlide =
    (activeSlide?.background.mode === "color" ? activeSlide.background.colorKey : undefined) ?? fallbackColorKey;

  return (
    <div className="stage-wrap">
      <div className="stage" ref={stageRef}>
        {activeSlide && (
          <div className="stage-sheet-container">
            <div className="stage-sheet active">
              <div className="stage-sheet-label">
                <b>Lámina {activeIndex + 1}</b> · {activeSlide.kind}
              </div>
              <div className="stage-art" style={{ width: displayWidth, height: displayHeight }}>
                <iframe
                  ref={iframeRef}
                  key={activeSlide.id}
                  title={`slide-active-${activeIndex}`}
                  src={`${slideHtmlUrl(slug, doc.id, activeIndex)}${cacheBuster}`}
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
      </div>

      <nav className="stage-strip" aria-label="Láminas" style={{ "--thumb-w": `${THUMB_WIDTH}px` } as React.CSSProperties}>
        {doc.slides.map((slide, index) => (
          <Thumb
            key={slide.id}
            slug={slug}
            doc={doc}
            slide={slide}
            index={index}
            active={index === activeIndex}
            cacheBuster={cacheBuster}
            thumbAspect={thumbAspect}
            onSelect={() => onActiveIndexChange(index)}
          />
        ))}
        <button
          type="button"
          className="stage-add-thumb"
          title="Añadir lámina"
          aria-label="Añadir lámina"
          onClick={() => onAddSlide(colorKeyForNewSlide)}
        >
          +
        </button>
      </nav>
    </div>
  );
}
