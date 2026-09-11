import { useCallback, useEffect, useState } from "react";

import type { BrandTokens, CarouselDocument, LayoutTemplate, StatsResponse } from "../api/types";
import type { useDocumentEditor } from "../hooks/useDocumentEditor";
import { regenerate, getCarousel } from "../api/client";
import { addTextObject, newEditorId } from "./mutations";
import { TopBar } from "./TopBar";
import { PromptHeader } from "./PromptHeader";
import { Stage } from "./Stage";
import { PropertiesPanel } from "./panels/PropertiesPanel";
import { StatusBar } from "./StatusBar";
import type { Selection } from "./geometry";
import { RegenerateUnpinnedDialog } from "./RegenerateUnpinnedDialog";
import { ExportDialog } from "./ExportDialog";
import { t } from "../i18n";
import "./Editor.css";

const ACTIVE_SLIDE_STORAGE_PREFIX = "editor-active-slide:";

export type PanelTab = "sel" | "bucket" | "lam" | "marca" | "templates";

interface EditorProps {
  slug: string;
  brand: BrandTokens;
  template: LayoutTemplate;
  editorState: ReturnType<typeof useDocumentEditor>;
  stats: StatsResponse | null;
  initialActiveSlide: number;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  /** Passed straight to the properties panel's Templates tab: a swap there re-renders the stage against the new template without a route refetch. */
  onTemplateChange: (next: LayoutTemplate) => void;
}

export function Editor({
  slug,
  brand,
  template,
  editorState,
  stats: initialStats,
  initialActiveSlide,
  theme,
  onToggleTheme,
  onTemplateChange,
}: EditorProps) {
  const { doc, update, applyRemote, undo, redo, canUndo, canRedo, dirty, saveError, renderVersion } = editorState;
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.min(initialActiveSlide, Math.max(0, doc.slides.length - 1)),
  );
  const [selection, setSelection] = useState<Selection>(null);
  const [panelTab, setPanelTab] = useState<PanelTab>("sel");
  const [stats, setStats] = useState(initialStats);
  const [showRegenDialog, setShowRegenDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [regenUnpinnedError, setRegenUnpinnedError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(ACTIVE_SLIDE_STORAGE_PREFIX + doc.id, String(activeIndex));
    } catch {
      // best-effort
    }
  }, [doc.id, activeIndex]);

  useEffect(() => {
    setSelection(null);
  }, [activeIndex]);

  const activeSlide = doc.slides[activeIndex];

  const pinnedCount = doc.slides.reduce((sum, s) => sum + s.objects.filter((o) => o.pinned).length + (s.background.pinned ? 1 : 0), 0);
  const totalPieceCount = doc.slides.reduce((sum, s) => sum + s.objects.length + 1, 0);

  const handleAddText = useCallback(() => {
    if (!activeSlide) return;
    const slideId = activeSlide.id;
    const objectId = newEditorId(`obj-${slideId}-text`);
    update((prev) => addTextObject(prev, slideId, objectId, template, brand));
    setSelection({ slideId, objectId });
    setPanelTab("sel");
  }, [activeSlide, template, brand, update]);

  const handleRegenerateUnpinned = useCallback(async () => {
    if (!activeSlide) return;
    setShowRegenDialog(false);
    setRegenUnpinnedError(null);
    try {
      const { document: next } = await regenerate(slug, doc.id, { slideId: activeSlide.id, scope: "unpinned" });
      applyRemote(next);
    } catch (err) {
      setRegenUnpinnedError(err instanceof Error ? err.message : String(err));
    }
  }, [slug, doc.id, activeSlide, applyRemote]);

  // The export queue rewrites the document on disk (status "exported").
  // Replace the editor's copy with the server's so the top bar updates and
  // the next save does not write the old status back. Safe only because
  // the export dialog is modal: applyRemote resets the undo stack, and no
  // edit can be in progress behind the backdrop.
  const refreshFromServer = useCallback(() => {
    getCarousel(slug, doc.id)
      .then(applyRemote)
      .catch((error: unknown) => console.warn("Could not refresh the carousel after export", error));
  }, [slug, doc.id, applyRemote]);

  if (!activeSlide) {
    return <div className="editor-empty">{t("editor.empty")}</div>;
  }

  return (
    <div className="editor-app">
      <TopBar
        slug={slug}
        brand={brand}
        doc={doc}
        hasSelection={selection !== null}
        onClearSelection={() => setSelection(null)}
        onOpenAssets={() => setPanelTab("bucket")}
        onAddText={handleAddText}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        theme={theme}
        onToggleTheme={onToggleTheme}
        onExport={() => setShowExportDialog(true)}
      />
      <div className="editor-body">
        <div className="editor-center">
          <PromptHeader
            doc={doc}
            stats={stats}
            onRegenerateUnpinned={() => setShowRegenDialog(true)}
            regenerateUnpinnedError={regenUnpinnedError}
          />
          <Stage
            slug={slug}
            doc={doc}
            template={template}
            brand={brand}
            renderVersion={renderVersion}
            activeIndex={activeIndex}
            onActiveIndexChange={setActiveIndex}
            selection={selection}
            onSelectionChange={setSelection}
            onDocUpdate={update}
            fallbackColorKey={Object.keys(brand.colors)[0] ?? ""}
            onAddSlide={(colorKey) => {
              update((d) => {
                const slides = [...d.slides];
                slides.splice(activeIndex + 1, 0, {
                  id: newEditorId("slide"),
                  kind: "step",
                  background: { mode: "color", colorKey, pinned: false, source: "manual" },
                  objects: [],
                });
                return { ...d, slides, updatedAt: new Date().toISOString() };
              });
              setActiveIndex(activeIndex + 1);
            }}
          />
        </div>
        <PropertiesPanel
          slug={slug}
          brand={brand}
          template={template}
          doc={doc}
          renderVersion={renderVersion}
          activeIndex={activeIndex}
          selection={selection}
          onSelectionChange={setSelection}
          onDocUpdate={update}
          onDocReplace={applyRemote}
          panelTab={panelTab}
          onPanelTabChange={setPanelTab}
          stats={stats}
          onStatsRefresh={setStats}
          onTemplateChange={onTemplateChange}
        />
      </div>
      <StatusBar
        doc={doc}
        activeIndex={activeIndex}
        selection={selection}
        pinnedCount={pinnedCount}
        totalPieceCount={totalPieceCount}
        dirty={dirty}
        saveError={saveError}
      />
      {showRegenDialog && (
        <RegenerateUnpinnedDialog
          slide={activeSlide}
          onCancel={() => setShowRegenDialog(false)}
          onConfirm={handleRegenerateUnpinned}
        />
      )}
      {showExportDialog && (
        <ExportDialog
          slug={slug}
          carouselId={doc.id}
          onClose={() => {
            setShowExportDialog(false);
            // Refresh on close too: a failed poll or an early Escape must not
            // leave the editor holding a document older than the export.
            refreshFromServer();
          }}
          onExported={refreshFromServer}
        />
      )}
    </div>
  );
}
