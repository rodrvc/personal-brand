import { useState } from "react";

import { regenerate } from "../../api/client";
import type { BrandTokens, CarouselDocument, Slide } from "../../api/types";
import type { Selection } from "../geometry";
import {
  resetObjectToSlot,
  setObjectPinned,
  setBackgroundPinned,
  setTextContent,
  setTextStyle,
} from "../mutations";

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

const ORIGIN_LABEL: Record<string, string> = { ai: "IA", library: "Biblioteca", manual: "Manual" };

export function SelectionPane({ slug, brand, doc, slide, selection, onSelectionChange, onDocUpdate, onDocReplace }: SelectionPaneProps) {
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [regenError, setRegenError] = useState<string | null>(null);
  const selectedObject = selection ? slide.objects.find((o) => o.id === selection.objectId) : undefined;

  async function handleRegenerate(objectId: string | "background") {
    setRegenerating(objectId);
    setRegenError(null);
    try {
      const next = await regenerate(slug, doc.id, {
        slideId: slide.id,
        ...(objectId === "background" ? {} : { objectId }),
      });
      onDocReplace(next);
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
            {selectedObject.slot ?? "Texto"}
            <span className={`origin-badge ${selectedObject.source}`} style={{ marginLeft: "auto" }}>
              {selectedObject.pinned ? "fijado" : ORIGIN_LABEL[selectedObject.source]}
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
              <label>Tamaño</label>
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
              <label>Interlínea</label>
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
              <label>Posición</label>
              <input
                className="ui-input"
                readOnly
                value={selectedObject.geometry ? `${selectedObject.geometry.x} · ${selectedObject.geometry.y}` : "heredada"}
              />
            </div>
            <div className="props-field">
              <label>Rotación</label>
              <input className="ui-input" readOnly value={`${selectedObject.geometry?.rotation ?? 0}°`} />
            </div>
          </div>
          {selectedObject.slot && (
            <button className="ui-btn" onClick={() => onDocUpdate((prev) => resetObjectToSlot(prev, slide.id, selectedObject.id))}>
              Restablecer al template
            </button>
          )}
        </div>
      )}

      {selectedObject?.kind === "text" && (
        <div className="props-card">
          <div className="props-card-heading">
            Color
            <span className="lock-hint">marca</span>
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
            Los {colorKeys.length} colores de la marca. Son <b>inputs</b>, no configuración: si un color no está
            aquí, no existe para esta pieza.
          </p>
        </div>
      )}

      <div className="props-card">
        <div className="props-card-heading">Piezas de la lámina</div>
        <p className="props-hint" style={{ marginBottom: 2 }}>
          Fija <b>✓</b> lo que te gustó y regenera <b>↻</b> solo el resto.
        </p>

        <div
          className={`layer-row ${selection === null ? "on" : ""}`}
          onClick={() => onSelectionChange(null)}
        >
          <span className="layer-name">Fondo</span>
          <span className="layer-actions">
            <span className={`origin-badge ${slide.background.source}`}>{ORIGIN_LABEL[slide.background.source]}</span>
            <button
              className={`pin-btn ${slide.background.pinned ? "on" : ""}`}
              title="Fijar"
              onClick={(e) => {
                e.stopPropagation();
                onDocUpdate((prev) => setBackgroundPinned(prev, slide.id, !slide.background.pinned));
              }}
            >
              ✓
            </button>
            <button
              className="regen-btn"
              title="Regenerar"
              disabled={slide.background.pinned || regenerating === "background"}
              onClick={(e) => {
                e.stopPropagation();
                void handleRegenerate("background");
              }}
            >
              ↻
            </button>
          </span>
        </div>

        {slide.objects.map((object) => (
          <div
            key={object.id}
            className={`layer-row ${selection?.objectId === object.id ? "on" : ""}`}
            onClick={() => onSelectionChange({ slideId: slide.id, objectId: object.id })}
          >
            <span className="layer-name">
              {object.locked && <span className="layer-lock-icon">🔒 </span>}
              {object.slot ?? (object.kind === "text" ? "Texto" : "Asset")}
            </span>
            <span className="layer-actions">
              {!object.locked && <span className={`origin-badge ${object.source}`}>{ORIGIN_LABEL[object.source]}</span>}
              {!object.locked && (
                <>
                  <button
                    className={`pin-btn ${object.pinned ? "on" : ""}`}
                    title="Fijar"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDocUpdate((prev) => setObjectPinned(prev, slide.id, object.id, !object.pinned));
                    }}
                  >
                    ✓
                  </button>
                  <button
                    className="regen-btn"
                    title="Regenerar"
                    disabled={object.pinned || regenerating === object.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleRegenerate(object.id);
                    }}
                  >
                    ↻
                  </button>
                </>
              )}
            </span>
          </div>
        ))}

        {regenError && <p className="props-hint" style={{ color: "var(--ui-danger)" }}>{regenError}</p>}
        <p className="props-note">Fija lo que quieras conservar; "Regenerar lo no fijado" cambia solo el resto.</p>
      </div>
    </>
  );
}
