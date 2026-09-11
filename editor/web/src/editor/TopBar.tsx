import { Link } from "react-router-dom";

import type { BrandTokens, CarouselDocument } from "../api/types";
import { t } from "../i18n";
import type { LocaleKey } from "../i18n";
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
      <button className="topbar-tool" title={t("topbar.tool.deselect")} aria-label={t("topbar.tool.deselect")} onClick={onClearSelection} disabled={!hasSelection}>
        ▲
      </button>
      <button className="topbar-tool" title={t("topbar.tool.addText")} aria-label={t("topbar.tool.addText")} onClick={onAddText}>
        T
      </button>
      <button className="topbar-tool" title={t("topbar.tool.addAsset")} aria-label={t("topbar.tool.addAsset")} onClick={onOpenAssets}>
        ▧
      </button>
      <div className="topbar-sep" />
      <button className="topbar-tool" title={t("topbar.tool.undo")} aria-label={t("topbar.tool.undo")} onClick={onUndo} disabled={!canUndo}>
        ↺
      </button>
      <button className="topbar-tool" title={t("topbar.tool.redo")} aria-label={t("topbar.tool.redo")} onClick={onRedo} disabled={!canRedo}>
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
