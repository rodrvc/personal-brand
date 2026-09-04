import type { CarouselDocument } from "../api/types";
import type { Selection } from "./geometry";
import "./StatusBar.css";

interface StatusBarProps {
  doc: CarouselDocument;
  activeIndex: number;
  selection: Selection;
  pinnedCount: number;
  totalPieceCount: number;
  dirty: boolean;
  saveError: string | null;
}

export function StatusBar({ doc, activeIndex, selection, pinnedCount, totalPieceCount, dirty, saveError }: StatusBarProps) {
  const slide = doc.slides[activeIndex];
  const selectedObject = selection ? slide?.objects.find((o) => o.id === selection.objectId) : undefined;

  return (
    <div className="status-bar">
      <span className="status-group">
        <i className="status-dot" />
        Lámina {activeIndex + 1} de {doc.slides.length}
      </span>
      {selectedObject && (
        <span className="status-group">
          {selectedObject.kind === "text" ? "Texto" : "Asset"}
          {selectedObject.kind === "text" && selectedObject.fontSize ? ` · ${selectedObject.fontSize} px` : ""}
          {selectedObject.pinned ? " · fijado" : ""}
        </span>
      )}
      {selectedObject?.geometry && (
        <span className="status-group">
          x {selectedObject.geometry.x} · y {selectedObject.geometry.y}
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span className="status-group">
        {pinnedCount} de {totalPieceCount} piezas fijadas
      </span>
      <span className="status-group">{saveError ? `Error al guardar: ${saveError}` : dirty ? "Guardando…" : "Guardado"}</span>
    </div>
  );
}
