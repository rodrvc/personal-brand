import { t } from "../i18n";
import type { useBrushMask } from "./brush/useBrushMask";
import "./BrushControls.css";

interface BrushControlsProps {
  brush: ReturnType<typeof useBrushMask>;
  onConfirm: () => void;
}

/** Shown above the stage while the brush tool is active (Editor.tsx). Ctrl/Cmd+Z here undoes the last stroke, not the document — see useDocumentEditor.ts's `setUndoSuppressed`. */
export function BrushControls({ brush, onConfirm }: BrushControlsProps) {
  const hasStrokes = brush.strokes.length > 0;
  return (
    <div className="brush-controls">
      <span className="brush-controls-label">{t("brush.label")}</span>
      <label className="brush-controls-size">
        {t("brush.size")}
        <input
          type="range"
          min={4}
          max={80}
          value={brush.screenRadius}
          onChange={(e) => brush.setScreenRadius(Number(e.target.value))}
        />
      </label>
      <button
        type="button"
        className={`ui-btn ${brush.mode === "erase" ? "ui-btn-primary" : ""}`}
        onClick={() => brush.setMode(brush.mode === "erase" ? "paint" : "erase")}
      >
        {t("brush.eraser")}
      </button>
      <button type="button" className="ui-btn" onClick={brush.undoStroke} disabled={!hasStrokes}>
        {t("brush.undoStroke")}
      </button>
      <button type="button" className="ui-btn" onClick={brush.clear} disabled={!hasStrokes}>
        {t("brush.clear")}
      </button>
      <div className="brush-controls-spacer" />
      <button type="button" className="ui-btn ui-btn-primary" onClick={onConfirm} disabled={!hasStrokes}>
        {t("brush.confirm")}
      </button>
    </div>
  );
}
