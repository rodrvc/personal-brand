import { Link } from "react-router-dom";

import type { BrandTokens, CarouselDocument } from "../api/types";
import "./TopBar.css";

interface TopBarProps {
  slug: string;
  brand: BrandTokens;
  doc: CarouselDocument;
  /** Whether anything is selected on the active slide — the deselect button is inert otherwise, and says so. */
  hasSelection: boolean;
  onClearSelection: () => void;
  onOpenAssets: () => void;
  onAddText: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onExport: () => void;
}

const STATUS_LABEL: Record<CarouselDocument["status"], string> = {
  draft: "borrador",
  exported: "exportado",
  published: "publicado",
};

export function TopBar({
  slug,
  brand,
  doc,
  hasSelection,
  onClearSelection,
  onOpenAssets,
  onAddText,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  theme,
  onToggleTheme,
  onExport,
}: TopBarProps) {
  return (
    <header className="topbar">
      <Link to={`/${slug}/carousels`} className="topbar-back">
        ← Carruseles
      </Link>
      <div className="topbar-brand-pill">
        <span className="topbar-brand-dot" />
        <span className="topbar-brand-name">{brand.copy.wordmark}</span>
      </div>
      <div className="topbar-sep" />
      <div>
        <div className="topbar-title">
          {doc.title || doc.id}
          <span className="topbar-chip">{STATUS_LABEL[doc.status]}</span>
        </div>
        <div className="topbar-subtitle">
          {doc.slides.length} láminas · {doc.canvas.w}×{doc.canvas.h}
        </div>
      </div>
      <div className="topbar-sep" />
      <button className="topbar-tool" title="Deseleccionar" aria-label="Deseleccionar" onClick={onClearSelection} disabled={!hasSelection}>
        ▲
      </button>
      <button className="topbar-tool" title="Añadir texto" aria-label="Añadir texto" onClick={onAddText}>
        T
      </button>
      <button className="topbar-tool" title="Añadir asset" aria-label="Añadir asset" onClick={onOpenAssets}>
        ▧
      </button>
      <div className="topbar-sep" />
      <button className="topbar-tool" title="Deshacer" aria-label="Deshacer" onClick={onUndo} disabled={!canUndo}>
        ↺
      </button>
      <button className="topbar-tool" title="Rehacer" aria-label="Rehacer" onClick={onRedo} disabled={!canRedo}>
        ↻
      </button>
      <div className="topbar-spacer" />
      <button className="topbar-tool" title="Tema claro / oscuro" aria-label="Cambiar tema" onClick={onToggleTheme}>
        {theme === "dark" ? "🌙" : "☀️"}
      </button>
      <div className="topbar-sep" />
      <button className="ui-btn ui-btn-primary" onClick={onExport}>
        Exportar {doc.slides.length} PNG
      </button>
    </header>
  );
}
