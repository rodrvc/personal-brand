import type { CarouselDocument } from "../api/types";
import type { Selection } from "./geometry";
import { t } from "../i18n";
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
        {t("statusBar.slideOfTotal", { index: activeIndex + 1, total: doc.slides.length })}
      </span>
      {selectedObject && (
        <span className="status-group">
          {selectedObject.kind === "text" ? t("statusBar.textKind") : t("statusBar.assetKind")}
          {selectedObject.kind === "text" && selectedObject.fontSize
            ? t("statusBar.fontSize", { size: selectedObject.fontSize })
            : ""}
          {selectedObject.pinned ? t("statusBar.pinned") : ""}
        </span>
      )}
      {selectedObject?.geometry && (
        <span className="status-group">
          {t("statusBar.position", { x: selectedObject.geometry.x, y: selectedObject.geometry.y })}
        </span>
      )}
      <span style={{ flex: 1 }} />
      <span className="status-group">
        {t("statusBar.pinnedPieces", { pinned: pinnedCount, total: totalPieceCount })}
      </span>
      <span className="status-group">
        {saveError
          ? t("statusBar.saveError", { message: saveError })
          : dirty
            ? t("statusBar.saving")
            : t("statusBar.saved")}
      </span>
    </div>
  );
}
