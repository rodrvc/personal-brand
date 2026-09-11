import { Link } from "react-router-dom";

import type { BrandTokens, CarouselDocument } from "../api/types";
import type { Tool } from "./Editor";
import { t } from "../i18n";
import type { LocaleKey } from "../i18n";
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

/** Document status → its LocaleKey. `t()` is called lazily, in `statusLabel()`, never at module load. */
const STATUS_LABEL_KEY: Record<CarouselDocument["status"], LocaleKey> = {
  draft: "topbar.status.draft",
  exported: "topbar.status.exported",
  published: "topbar.status.published",
};

function statusLabel(status: CarouselDocument["status"]): string {
  return t(STATUS_LABEL_KEY[status]);
}

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
        {t("topbar.back")}
      </Link>
      <div className="topbar-brand-pill">
        <span className="topbar-brand-dot" />
        <span className="topbar-brand-name">{brand.copy.wordmark}</span>
      </div>
      <div className="topbar-sep" />
      <div>
        <div className="topbar-title">
          {doc.title || doc.id}
          <span className="topbar-chip">{statusLabel(doc.status)}</span>
        </div>
        <div className="topbar-subtitle">
          {t("topbar.subtitle", { count: doc.slides.length, w: doc.canvas.w, h: doc.canvas.h })}
        </div>
      </div>
      <div className="topbar-sep" />
      <button
        className={`topbar-tool ${tool === "select" ? "on" : ""}`}
        title={t("topbar.tool.select")}
        onClick={() => onToolChange("select")}
      >
        ▲
      </button>
      <button className="topbar-tool" title={t("topbar.tool.addText")} onClick={onAddText}>
        T
      </button>
      <button
        className={`topbar-tool ${tool === "asset" ? "on" : ""}`}
        title={t("topbar.tool.asset")}
        onClick={() => onToolChange("asset")}
      >
        ▧
      </button>
      <div className="topbar-sep" />
      <button className="topbar-tool" title={t("topbar.tool.undo")} onClick={onUndo} disabled={!canUndo}>
        ↺
      </button>
      <button className="topbar-tool" title={t("topbar.tool.redo")} onClick={onRedo} disabled={!canRedo}>
        ↻
      </button>
      <div className="topbar-spacer" />
      <button
        className="topbar-tool"
        title={t("topbar.tool.toggleTheme")}
        aria-label={t("topbar.tool.toggleThemeAriaLabel")}
        onClick={onToggleTheme}
      >
        {theme === "dark" ? "🌙" : "☀️"}
      </button>
      <div className="topbar-sep" />
      <button className="ui-btn ui-btn-primary" onClick={onExport}>
        {t("topbar.export", { count: doc.slides.length })}
      </button>
    </header>
  );
}
