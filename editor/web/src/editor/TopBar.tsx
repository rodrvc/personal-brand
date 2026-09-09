import { Link } from "react-router-dom";

import type { BrandTokens, CarouselDocument } from "../api/types";
import type { Tool } from "./Editor";
import "./TopBar.css";

interface TopBarProps {
  slug: string;
  brand: BrandTokens;
  doc: CarouselDocument;
  tool: Tool;
  onToolChange: (tool: Tool) => void;
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
  tool,
  onToolChange,
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
      <button
        className={`topbar-tool ${tool === "select" ? "on" : ""}`}
        title="Seleccionar"
        onClick={() => onToolChange("select")}
      >
        ▲
      </button>
      <button className="topbar-tool" title="Añadir texto" onClick={onAddText}>
        T
      </button>
      <button
        className={`topbar-tool ${tool === "asset" ? "on" : ""}`}
        title="Asset"
        onClick={() => onToolChange("asset")}
      >
        ▧
      </button>
      <div className="topbar-sep" />
      <button className="topbar-tool" title="Deshacer" onClick={onUndo} disabled={!canUndo}>
        ↺
      </button>
      <button className="topbar-tool" title="Rehacer" onClick={onRedo} disabled={!canRedo}>
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
